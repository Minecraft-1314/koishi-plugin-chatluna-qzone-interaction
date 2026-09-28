'use strict'

const assert = require('node:assert/strict')

const registerFeeds = require('../lib/commands/feeds').registerFeeds
const registerPublish = require('../lib/commands/publish').registerPublish
const registerDigest = require('../lib/commands/digest').registerDigest
const registerStatus = require('../lib/commands/status').registerStatus
const createAllowGuard = require('../lib/commands/guard').createAllowGuard
const { PublishXmlTool } = require('../lib/xml-tool')
const { QzoneWriteAuthError } = require('../lib/qzone/manager')
const { QzoneAuthError, QzoneNotFoundError } = require('qzone-sdk')

const makeCommand = () => {
    const captured = { subs: [] }
    const chain = {
        usage: () => chain,
        example: () => chain,
        option: () => chain,
        alias: () => chain,
        before: () => chain,
        action: (fn) => {
            captured.action = fn
            return chain
        },
        subcommand: (name) => {
            captured.subs.push(name)
            return chain
        }
    }
    return { chain, captured }
}

const user = (id) => ({ id, nickname: 'n' + id })

const post = (overrides) => Object.assign({
    id: 'p1',
    authorId: 'u1',
    author: user('u1'),
    content: 'hello',
    createdAt: '2026-01-01T00:00:00.000Z',
    likeCount: 3,
    commentCount: 2,
    liked: false,
    media: [],
    comments: [],
    commentsComplete: true
}, overrides)

const fakeLogger = () => {
    const lines = []
    return {
        lines,
        debug: (m) => lines.push(['debug', m]),
        info: (m) => lines.push(['info', m]),
        warn: (m) => lines.push(['warn', m]),
        error: (m) => lines.push(['error', m])
    }
}

const cases = []
const test = (name, fn) => cases.push({ name, fn })
const testAsync = (name, fn) => cases.push({ name, fn })

test('allowUserIds 为空时所有指令关闭', () => {
    const guard = createAllowGuard({ allowUserIds: [] })
    assert.match(guard({ session: { userId: '123' } }), /未开放/)
    assert.match(guard({}), /未开放/)
})

test('白名单外的用户被拒绝', () => {
    const guard = createAllowGuard({ allowUserIds: ['123', ' 456 '] })
    assert.equal(guard({ session: { userId: '123' } }), undefined)
    assert.equal(guard({ session: { userId: ' 456 ' } }), undefined)
    assert.match(guard({ session: { userId: '789' } }), /没有使用/)
    assert.match(guard({}), /没有使用/)
})

test('白名单项为空白时被忽略', () => {
    const guard = createAllowGuard({ allowUserIds: ['  ', ''] })
    assert.match(guard({ session: { userId: '1' } }), /未开放/)
})

testAsync('qzone.feeds 读取成功时输出动态列表', async () => {
    const { chain, captured } = makeCommand()
    const ctx = { chatluna_qzone_interaction: { listFeedPage: async () => ({ items: [post()], nextCursor: null }) } }
    registerFeeds(chain, ctx, () => 5)
    assert.deepEqual(captured.subs, ['.feeds [count:text]'])
    const out = await captured.action({}, undefined, undefined)
    assert.match(out, /自己/)
    assert.match(out, /hello/)
    assert.match(out, /点赞 3 · 评论 2/)
})

testAsync('qzone.feeds 空列表给出提示', async () => {
    const { chain, captured } = makeCommand()
    const ctx = { chatluna_qzone_interaction: { listFeedPage: async () => ({ items: [], nextCursor: null }) } }
    registerFeeds(chain, ctx, () => 5)
    assert.match(await captured.action({}, undefined, undefined), /没有可显示的动态/)
})

testAsync('qzone.feeds 带媒体时标注媒体数量', async () => {
    const { chain, captured } = makeCommand()
    const withMedia = post({ media: [{ kind: 'image', url: 'https://x/1.png' }] })
    const ctx = { chatluna_qzone_interaction: { listFeedPage: async () => ({ items: [withMedia], nextCursor: null }) } }
    registerFeeds(chain, ctx, () => 5)
    assert.match(await captured.action({}, undefined, undefined), /媒体 1/)
})

testAsync('qzone.feeds 读取失败时给出可读提示而不抛错', async () => {
    const { chain, captured } = makeCommand()
    const logger = fakeLogger()
    const ctx = {
        logger,
        chatluna_qzone_interaction: { listFeedPage: async () => { throw new Error('登录态失效') } }
    }
    registerFeeds(chain, ctx, () => 5)
    const out = await captured.action({}, undefined, undefined)
    assert.match(out, /空间动态失败/)
    assert.match(out, /登录态失效/)
    assert.match(out, /qzone\.status/)
    assert.ok(logger.lines.some(([level, m]) => level === 'warn' && /qzone\.feeds 读取失败/.test(m)))
})

testAsync('qzone.feeds 鉴权错误同样被兜底', async () => {
    const { chain, captured } = makeCommand()
    const ctx = {
        logger: fakeLogger(),
        chatluna_qzone_interaction: { listFeedPage: async () => { throw new QzoneAuthError('expired') } }
    }
    registerFeeds(chain, ctx, () => 5)
    const out = await captured.action({}, undefined, undefined)
    assert.match(out, /空间动态失败/)
    assert.match(out, /qzone\.status/)
})

testAsync('qzone.feeds 目标 QQ 非法时同样被兜底', async () => {
    const { chain, captured } = makeCommand()
    const ctx = {
        logger: fakeLogger(),
        chatluna_qzone_interaction: { listFeedPage: async () => { throw new QzoneNotFoundError('no such user') } }
    }
    registerFeeds(chain, ctx, () => 5)
    const out = await captured.action({}, undefined, '999')
    assert.match(out, /QQ 999/)
    assert.match(out, /空间动态失败/)
})

const clampProbe = async (count, target) => {
    const { chain, captured } = makeCommand()
    const seen = []
    const ctx = {
        chatluna_qzone_interaction: {
            listFeedPage: async (req) => { seen.push(req); return { items: [], nextCursor: null } }
        }
    }
    registerFeeds(chain, ctx, () => 5)
    await captured.action({}, count, target)
    return seen[0]
}

testAsync('qzone.feeds 条数被夹取到 1..10 并回退默认值', async () => {
    assert.equal((await clampProbe(undefined, undefined)).limit, 5)
    assert.equal((await clampProbe('3', undefined)).limit, 3)
    assert.equal((await clampProbe('99', undefined)).limit, 10)
    assert.equal((await clampProbe('abc', undefined)).limit, 5)
    assert.equal((await clampProbe('0', undefined)).limit, 5)
    assert.equal((await clampProbe('-2', undefined)).limit, 5)
})

testAsync('qzone.feeds 指定 QQ 时使用 profile 作用域', async () => {
    const req = await clampProbe(undefined, ' 123 ')
    assert.equal(req.scope, 'profile')
    assert.equal(req.userId, '123')
    const own = await clampProbe(undefined, '   ')
    assert.equal(own.scope, 'self')
    assert.equal(own.userId, undefined)
})

testAsync('qzone.feeds 无日期与长正文安全降级', async () => {
    const { chain, captured } = makeCommand()
    const items = [post({ createdAt: null, content: 'x'.repeat(200) })]
    const ctx = { chatluna_qzone_interaction: { listFeedPage: async () => ({ items, nextCursor: null }) } }
    registerFeeds(chain, ctx, () => 5)
    const out = await captured.action({}, undefined, undefined)
    assert.match(out, /未知时间/)
    assert.match(out, /……/)
})

testAsync('qzone.publish 收集消息图片并发布', async () => {
    const { chain, captured } = makeCommand()
    const calls = []
    const ctx = {
        logger: fakeLogger(),
        http: { get: async () => ({ data: new Uint8Array([1, 2]).buffer, headers: { 'content-type': 'image/png' } }) },
        chatluna_qzone_interaction: { publishPost: async (req) => { calls.push(req); return { outcome: 'verified' } } }
    }
    registerPublish(chain, ctx, () => false)
    const session = { message: [{ type: 'img', attrs: { src: 'https://a/1.png' } }, { type: 'text' }] }
    const out = await captured.action({ session }, '正文')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].content, '正文')
    assert.equal(calls[0].images.length, 1)
    assert.match(out, /发布成功/)
})

testAsync('qzone.publish 图片超限时提示已忽略', async () => {
    const { chain, captured } = makeCommand()
    const ctx = {
        logger: fakeLogger(),
        http: { get: async () => ({ data: new Uint8Array([1]).buffer, headers: {} }) },
        chatluna_qzone_interaction: { publishPost: async () => ({ outcome: 'verified' }) }
    }
    registerPublish(chain, ctx, () => false)
    const many = Array.from({ length: 12 }, (_, i) => ({ type: 'img', attrs: { src: 'https://a/' + i + '.png' } }))
    const out = await captured.action({ session: { message: many } }, '正文')
    assert.match(out, /多余的已忽略/)
})

testAsync('qzone.publish 任一图片失败时整体不发布', async () => {
    const { chain, captured } = makeCommand()
    let called = 0
    const ctx = {
        logger: fakeLogger(),
        http: { get: async (url) => { if (url.includes('2')) throw new Error('404'); return { data: new Uint8Array([1]).buffer, headers: {} } } },
        chatluna_qzone_interaction: { publishPost: async () => { called += 1; return { outcome: 'verified' } } }
    }
    registerPublish(chain, ctx, () => false)
    const session = { message: [{ type: 'img', attrs: { src: 'https://a/1.png' } }, { type: 'img', attrs: { src: 'https://a/2.png' } }] }
    const out = await captured.action({ session }, '正文')
    assert.equal(called, 0)
    assert.match(out, /本次不发布/)
})

testAsync('qzone.publish 空正文不发布', async () => {
    const { chain, captured } = makeCommand()
    let called = 0
    const ctx = {
        logger: fakeLogger(),
        chatluna_qzone_interaction: { publishPost: async () => { called += 1; return { outcome: 'verified' } } }
    }
    registerPublish(chain, ctx, () => false)
    const out = await captured.action({ session: {} }, '   ')
    assert.equal(called, 0)
    assert.match(out, /正文为空/)
})

testAsync('qzone.publish 鉴权失效时提示重试', async () => {
    const { chain, captured } = makeCommand()
    const ctx = {
        logger: fakeLogger(),
        chatluna_qzone_interaction: { publishPost: async () => { throw new QzoneWriteAuthError('publish', true) } }
    }
    registerPublish(chain, ctx, () => false)
    const out = await captured.action({ session: {} }, '正文')
    assert.match(out, /登录态已失效/)
})

testAsync('qzone.digest 未挂载运行时时给出提示', async () => {
    const { chain, captured } = makeCommand()
    registerDigest(chain, () => null)
    assert.match(await captured.action({}), /未挂载运行时/)
})

testAsync('qzone.digest 正常执行时输出阶段与结论', async () => {
    const { chain, captured } = makeCommand()
    registerDigest(chain, () => ({ report: null, runOnce: async () => ({ phase: 'published', detail: '已发布', memoryCount: 3, lastOutcome: 'verified' }) }))
    const out = await captured.action({})
    assert.match(out, /【今日记忆动态 · published】/)
    assert.match(out, /使用记忆条数：3/)
    assert.match(out, /发布结果：verified/)
})

testAsync('qzone.digest 无记忆条数时不输出该行', async () => {
    const { chain, captured } = makeCommand()
    registerDigest(chain, () => ({ runOnce: async () => ({ phase: 'skipped', detail: '无记忆', memoryCount: 0, lastOutcome: null }) }))
    const out = await captured.action({})
    assert.ok(!out.includes('使用记忆条数'))
    assert.ok(!out.includes('发布结果'))
})

const statusCtx = (rebind, bot) => ({
    chatluna_qzone_interaction: {
        status: () => ({
            bot: bot ?? null,
            client: { initialized: bot != null, accountId: bot ? bot.selfId : null, authenticated: bot != null, sessionUpdatedAt: bot ? '2026-01-01T00:00:00.000Z' : null, rebind }
        })
    }
})

const healthyRebind = { inFlight: false, disabled: false, consecutiveFailures: 0, lastAttemptAtSeconds: null, lastSuccessAtSeconds: null, nextAllowedAtSeconds: null }

testAsync('qzone.status 输出登录态与两个子系统状态', async () => {
    const { chain, captured } = makeCommand()
    registerStatus(chain, statusCtx(healthyRebind, { platform: 'OneBot', selfId: '123', online: true }), { interaction: () => null, digest: () => null })
    const out = await captured.action({})
    assert.match(out, /OneBot/)
    assert.match(out, /账号：123/)
    assert.match(out, /在线：是/)
    assert.match(out, /自动续绑：正常/)
    assert.match(out, /QQ 空间自动互动：\r?\n未挂起/)
    assert.match(out, /每日记忆动态：\r?\n未挂起/)
})

testAsync('qzone.status 续绑退避、进行中与停用各有文案', async () => {
    const base = { inFlight: false, disabled: false, consecutiveFailures: 2, lastAttemptAtSeconds: 1767225600, lastSuccessAtSeconds: null, nextAllowedAtSeconds: 1767225720 }
    const run = async (rebind) => {
        const { chain, captured } = makeCommand()
        registerStatus(chain, statusCtx(rebind), { interaction: () => null, digest: () => null })
        return captured.action({})
    }
    assert.match(await run(base), /连续失败退避中（2 次/)
    assert.match(await run(Object.assign({}, base, { disabled: true })), /已停用（连续失败 2 次/)
    assert.match(await run(Object.assign({}, base, { inFlight: true })), /正在续绑/)
})

testAsync('qzone.status 展示互动与记忆的详细统计', async () => {
    const { chain, captured } = makeCommand()
    const interaction = {
        phase: 'ready',
        detail: '等待下一轮',
        baselineCompletedAt: '2026-01-01T00:00:00.000Z',
        roundStartedAt: '2026-01-01T01:00:00.000Z',
        lastRoundAt: '2026-01-01T01:00:00.000Z',
        monitoredPosts: 3,
        monitorLimit: 10,
        pendingTriggers: 1,
        maxWritesPerRound: 5,
        round: { discovered: 2, writeAttempts: 1, verified: 1, accepted: 0, unknown: 0, incompleteSnapshots: 0, feedPageLimitHits: 0, likeAttempts: 0, likesApplied: 0, likeAlreadyApplied: 0, errors: 0 },
        lastError: null
    }
    const digest = { phase: 'idle', detail: '等待触发', lastRunAt: '2026-01-01T02:00:00.000Z', nextRunAt: '2026-01-02T00:00:00.000Z', lastOutcome: 'verified', memoryCount: 12 }
    registerStatus(chain, statusCtx(healthyRebind, { platform: 'Milky', selfId: '9', online: false }), { interaction: () => interaction, digest: () => digest })
    const out = await captured.action({})
    assert.match(out, /Milky/)
    assert.match(out, /在线：否/)
    assert.match(out, /监控动态：3\/10/)
    assert.match(out, /待处理触发：1/)
    assert.match(out, /上轮统计：发现 2，写入 1/)
    assert.match(out, /本次使用记忆条数：12/)
    assert.match(out, /下次触发：/)
})

testAsync('qzone.status 互动存在最近错误时展示且空时间显示为无', async () => {
    const { chain, captured } = makeCommand()
    const interaction = {
        phase: 'failed', detail: '轮询失败', baselineCompletedAt: null, roundStartedAt: null, lastRoundAt: null,
        monitoredPosts: 0, monitorLimit: 0, pendingTriggers: 0, maxWritesPerRound: 0, round: null, lastError: 'round-read'
    }
    registerStatus(chain, statusCtx(healthyRebind), { interaction: () => interaction, digest: () => null })
    const out = await captured.action({})
    assert.match(out, /最近错误：round-read/)
    assert.match(out, /基线建立于：无/)
    assert.match(out, /最近一轮：无/)
})

const buildPublishCtx = (publishPost, extra) => Object.assign({
    logger: fakeLogger(),
    chatluna_qzone_interaction: { publishPost }
}, extra)

const characterService = () => ({ getTemp: async () => ({ completionMessages: [] }) })

const characterServiceWith = (messages) => ({ getTemp: async () => ({ completionMessages: messages }) })

const mountTool = (ctx, config) => {
    const tool = new PublishXmlTool(ctx, Object.assign({ enablePublishTool: true, debug: false, promptPublishTool: '' }, config), ctx.logger)
    tool.start()
    return tool
}

const emitResponse = async (service, text) => {
    const temp = await service.getTemp()
    temp.completionMessages.push({ _getType: () => 'ai', content: text })
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms))

testAsync('qzone_publish 标签触发发布', async () => {
    const calls = []
    const ctx = buildPublishCtx(async (req) => { calls.push(req); return { outcome: 'verified' } })
    const service = characterService()
    ctx.chatluna_character = service
    const tool = mountTool(ctx)
    await emitResponse(service, '好的 <qzone_publish content="今天很开心" />')
    await settle(30)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].content, '今天很开心')
    assert.equal(tool.stats.published, 1)
    tool.stop()
})

testAsync('qzone_publish 对话首轮 completionMessages 为空时仍能发布', async () => {
    const calls = []
    const ctx = buildPublishCtx(async (req) => { calls.push(req); return { outcome: 'verified' } })
    const service = characterServiceWith([])
    ctx.chatluna_character = service
    const tool = mountTool(ctx)
    await emitResponse(service, '<qzone_publish content="首轮" />')
    await settle(30)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].content, '首轮')
    tool.stop()
})

testAsync('qzone_publish 已有历史消息时补发历史并只统计新消息一次', async () => {
    const calls = []
    const ctx = buildPublishCtx(async (req) => { calls.push(req); return { outcome: 'verified' } })
    const history = [{ _getType: () => 'system', content: 'sys' }, { _getType: () => 'ai', content: '<qzone_publish content="历史" />' }]
    const service = characterServiceWith(history)
    ctx.chatluna_character = service
    const tool = mountTool(ctx)
    const temp = await service.getTemp()
    await settle(40)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].content, '历史')
    temp.completionMessages.push({ _getType: () => 'ai', content: '<qzone_publish content="新消息" />' })
    await settle(30)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].content, '新消息')
    tool.stop()
})

testAsync('qzone_publish 按 imageN 顺序收集图片', async () => {
    const calls = []
    const ctx = buildPublishCtx(async (req) => { calls.push(req); return { outcome: 'verified' } }, {
        http: { get: async () => ({ data: new Uint8Array([1]).buffer, headers: {} }) }
    })
    const service = characterService()
    ctx.chatluna_character = service
    const tool = mountTool(ctx)
    await emitResponse(service, '<qzone_publish content="c" image2="https://a/2.png" image1="https://a/1.png" />')
    await settle(40)
    assert.equal(calls[0].images.length, 2)
    assert.equal(tool.stats.published, 1)
    tool.stop()
})

testAsync('qzone_publish 缺少 content 时忽略', async () => {
    let called = 0
    const ctx = buildPublishCtx(async () => { called += 1; return { outcome: 'verified' } })
    const service = characterService()
    ctx.chatluna_character = service
    const tool = mountTool(ctx)
    await emitResponse(service, '<qzone_publish />')
    await settle(30)
    assert.equal(called, 0)
    tool.stop()
})

testAsync('qzone_publish 未启用时不挂载', async () => {
    let called = 0
    const ctx = buildPublishCtx(async () => { called += 1; return { outcome: 'verified' } })
    const service = characterService()
    ctx.chatluna_character = service
    const original = service.getTemp
    const tool = mountTool(ctx, { enablePublishTool: false })
    await emitResponse(service, '<qzone_publish content="x" />')
    await settle(30)
    assert.equal(called, 0)
    assert.equal(service.getTemp, original)
    tool.stop()
})

testAsync('qzone_publish stop 后不再响应新的模型输出', async () => {
    const calls = []
    const ctx = buildPublishCtx(async (req) => { calls.push(req.content); return { outcome: 'verified' } })
    const service = characterService()
    ctx.chatluna_character = service
    const tool = mountTool(ctx)
    const temp = await service.getTemp()
    tool.stop()
    temp.completionMessages.push({ _getType: () => 'ai', content: '<qzone_publish content="after-stop" />' })
    await settle(40)
    assert.equal(calls.length, 0)
})

testAsync('qzone_publish stop 后 getTemp 恢复为原始实现', async () => {
    const ctx = buildPublishCtx(async () => ({ outcome: 'verified' }))
    const service = characterService()
    ctx.chatluna_character = service
    const original = service.getTemp
    const tool = mountTool(ctx)
    assert.notEqual(service.getTemp, original)
    await service.getTemp()
    tool.stop()
    assert.equal(service.getTemp, original)
})

testAsync('qzone_publish 缺少 character 服务时挂起并只告警一次', async () => {
    const ctx = buildPublishCtx(async () => ({ outcome: 'verified' }))
    const tool = mountTool(ctx)
    tool.start()
    const warnings = ctx.logger.lines.filter(([level]) => level === 'warn')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0][1], /未检测到可用的 chatluna_character/)
    tool.stop()
})

testAsync('qzone_publish 登录态持续失效时按上限重试后放弃', async () => {
    let attempts = 0
    const ctx = buildPublishCtx(async () => {
        attempts += 1
        throw new QzoneWriteAuthError('publish', true)
    })
    const service = characterService()
    ctx.chatluna_character = service
    const tool = mountTool(ctx)
    await emitResponse(service, '<qzone_publish content="x" />')
    await settle(4300)
    assert.equal(attempts, 4)
    assert.equal(tool.stats.published, 0)
    assert.equal(tool.stats.failed, 1)
    tool.stop()
})

testAsync('qzone_publish 续绑后成功只计一次发布', async () => {
    let attempts = 0
    const ctx = buildPublishCtx(async () => {
        attempts += 1
        if (attempts === 1) throw new QzoneWriteAuthError('publish', true)
        return { outcome: 'verified' }
    })
    const service = characterService()
    ctx.chatluna_character = service
    const tool = mountTool(ctx)
    await emitResponse(service, '<qzone_publish content="x" />')
    await settle(2200)
    assert.equal(attempts, 2)
    assert.equal(tool.stats.published, 1)
    tool.stop()
})

testAsync('qzone_publish stop 后不再发布', async () => {
    let called = 0
    const ctx = buildPublishCtx(async () => { called += 1; return { outcome: 'verified' } })
    const service = characterService()
    ctx.chatluna_character = service
    const tool = mountTool(ctx)
    tool.stop()
    await emitResponse(service, '<qzone_publish content="x" />')
    await settle(30)
    assert.equal(called, 0)
})

testAsync('qzone_publish 单条响应最多处理 3 个标签', async () => {
    const calls = []
    const ctx = buildPublishCtx(async (req) => { calls.push(req); return { outcome: 'verified' } })
    const service = characterService()
    ctx.chatluna_character = service
    const tool = mountTool(ctx)
    const tags = Array.from({ length: 5 }, (_, i) => '<qzone_publish content="c' + i + '" />').join('')
    await emitResponse(service, tags)
    await settle(50)
    assert.equal(calls.length, 3)
    tool.stop()
})

testAsync('qzone_publish 发布异常后队列仍可继续处理新标签', async () => {
    const calls = []
    const ctx = buildPublishCtx(async (req) => {
        calls.push(req.content)
        if (req.content === 'boom') throw new Error('publish down')
        return { outcome: 'verified' }
    })
    const service = characterService()
    ctx.chatluna_character = service
    const tool = mountTool(ctx)
    await emitResponse(service, '<qzone_publish content="boom" />')
    await settle(4400)
    await emitResponse(service, '<qzone_publish content="after" />')
    await settle(50)
    assert.ok(calls.includes('after'))
    assert.equal(tool.stats.published, 1)
    tool.stop()
})

const run = async () => {
    const failures = []
    let passed = 0
    for (const c of cases) {
        try {
            await c.fn()
            passed += 1
        } catch (error) {
            failures.push({ name: c.name, error })
        }
    }
    for (const f of failures) {
        console.error('FAIL: ' + f.name)
        console.error('      ' + (f.error && f.error.message))
    }
    console.log('')
    console.log('passed=' + passed + ' failed=' + failures.length)
    return failures.length
}

module.exports = { run }

if (require.main === module) {
    run().then((bad) => process.exit(bad === 0 ? 0 : 1))
}
