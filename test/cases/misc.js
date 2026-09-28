'use strict'

const assert = require('node:assert/strict')
const { QzoneNotFoundError } = require('qzone-sdk')

const prompt = require('../../lib/auto-interaction/prompt')
const status = require('../../lib/status')
const characterRuntime = require('../../lib/xml-tool/character-runtime')
const report = require('../../lib/auto-interaction/report')
const types = require('../../lib/auto-interaction/types')
const promptDefaults = require('../../lib/prompt-defaults')

const user = (id) => ({ id, nickname: 'n' + id })
const ref = (id, authorId) => ({ id, authorId })

const post = (overrides) => Object.assign({
    id: 'p1',
    authorId: 'u1',
    author: user('u1'),
    content: 'hello',
    createdAt: '2026-01-01T00:00:00.000Z',
    likeCount: 0,
    commentCount: 0,
    liked: false,
    media: [],
    comments: [],
    commentsComplete: true
}, overrides)

const comment = (overrides) => Object.assign({
    id: 'c1',
    author: user('u2'),
    content: 'nice',
    createdAt: '2026-01-01T00:00:01.000Z',
    parentId: null,
    threadRoot: null,
    replyTo: null,
    replyToUser: null,
    kind: 'comment'
}, overrides)

module.exports = (test, testAsync, { concurrency, persona, state }) => {
    testAsync('mapWithConcurrency 限制并发并保持结果顺序', async () => {
        let active = 0
        let peak = 0
        const out = await concurrency.mapWithConcurrency([1, 2, 3, 4, 5, 6], async (n) => {
            active += 1
            peak = Math.max(peak, active)
            await new Promise((r) => setTimeout(r, 5))
            active -= 1
            return n * 2
        }, 2)
        assert.deepEqual(out.map((o) => o.value), [2, 4, 6, 8, 10, 12])
        assert.deepEqual(out.map((o) => o.index), [0, 1, 2, 3, 4, 5])
        assert.equal(peak, 2)
    })

    testAsync('mapWithConcurrency 隔离单点异常', async () => {
        const out = await concurrency.mapWithConcurrency([1, 2, 3], async (n) => {
            if (n === 2) throw new Error('bad')
            return n
        })
        assert.equal(out[0].ok, true)
        assert.equal(out[1].ok, false)
        assert.match(out[1].error.message, /bad/)
        assert.equal(out[2].ok, true)
    })

    testAsync('mapWithConcurrency 空数组与非法 limit', async () => {
        assert.deepEqual(await concurrency.mapWithConcurrency([], async () => 1), [])
        assert.deepEqual((await concurrency.mapWithConcurrency([1, 2], async (n) => n, 0)).map((o) => o.value), [1, 2])
        assert.deepEqual((await concurrency.mapWithConcurrency([1, 2], async (n) => n, -5)).map((o) => o.value), [1, 2])
    })

    test('resolveAssistantLabel 剥离 Character 后缀', () => {
        assert.equal(persona.resolveAssistantLabel('小明（Character）'), '小明')
        assert.equal(persona.resolveAssistantLabel('小明'), '小明')
        assert.equal(persona.resolveAssistantLabel('（Character）'), '')
    })

    test('isModelConfigured 排除空值与「无」占位', () => {
        assert.equal(persona.isModelConfigured('gpt-4'), true)
        assert.equal(persona.isModelConfigured('  gpt-4 '), true)
        assert.equal(persona.isModelConfigured('  '), false)
        assert.equal(persona.isModelConfigured('无'), false)
        assert.equal(persona.isModelConfigured(undefined), false)
        assert.equal(persona.isModelConfigured(1), false)
    })

    test('createInteractionWhitelist 清理空白项', () => {
        const list = types.createInteractionWhitelist(true, [' 1 ', '', '  ', '2'])
        assert.equal(list.enabled, true)
        assert.deepEqual([...list.allowed].sort(), ['1', '2'])
    })

    test('isWhitelistUsable 关闭时恒可用', () => {
        assert.equal(types.isWhitelistUsable(types.createInteractionWhitelist(false, [])), true)
        assert.equal(types.isWhitelistUsable(types.createInteractionWhitelist(true, [])), false)
        assert.equal(types.isWhitelistUsable(types.createInteractionWhitelist(true, ['1'])), true)
    })

    test('isUserAllowed 白名单外与空 id 均拒绝', () => {
        const list = types.createInteractionWhitelist(true, ['1'])
        assert.equal(types.isUserAllowed(list, '1'), true)
        assert.equal(types.isUserAllowed(list, '2'), false)
        assert.equal(types.isUserAllowed(list, null), false)
        assert.equal(types.isUserAllowed(list, '  '), false)
        assert.equal(types.isUserAllowed(types.createInteractionWhitelist(false, []), null), true)
    })

    test('emptyRoundStats 全部字段归零', () => {
        const stats = report.emptyRoundStats()
        for (const value of Object.values(stats)) assert.equal(value, 0)
        assert.equal(Object.keys(stats).length, 11)
    })

    test('createReportSlot 支持绑定与解绑', () => {
        const slot = status.createRuntimeReports().interaction
        assert.equal(slot.get(), null)
        const release = slot.bind(() => ({ phase: 'ready' }))
        assert.equal(slot.get().phase, 'ready')
        release()
        assert.equal(slot.get(), null)
    })

    test('createReportSlot 后绑定覆盖前者且旧释放不影响新绑定', () => {
        const slot = status.createRuntimeReports().interaction
        const first = slot.bind(() => ({ phase: 'a' }))
        slot.bind(() => ({ phase: 'b' }))
        assert.equal(slot.get().phase, 'b')
        first()
        assert.equal(slot.get().phase, 'b')
    })

    test('createReportSlot 读取函数返回 null 时回退 null', () => {
        const slot = status.createRuntimeReports().interaction
        slot.bind(() => null)
        assert.equal(slot.get(), null)
    })

    test('isAiMessage 兼容 _getType 与 getType', () => {
        assert.equal(characterRuntime.isAiMessage({ _getType: () => 'ai' }), true)
        assert.equal(characterRuntime.isAiMessage({ getType: () => 'ai' }), true)
        assert.equal(characterRuntime.isAiMessage({ _getType: () => 'human' }), false)
        assert.equal(characterRuntime.isAiMessage({ _getType: () => { throw new Error('x') } }), false)
        assert.equal(characterRuntime.isAiMessage(null), false)
        assert.equal(characterRuntime.isAiMessage('str'), false)
    })

    test('extractAssistantText 处理字符串与多模态内容', () => {
        assert.equal(characterRuntime.extractAssistantText({ content: ' hi ' }), 'hi')
        assert.equal(characterRuntime.extractAssistantText({ content: [{ type: 'text', text: 'a' }, { type: 'image_url' }, { type: 'text', text: 'b' }] }), 'ab')
        assert.equal(characterRuntime.extractAssistantText({ content: null }), '')
        assert.equal(characterRuntime.extractAssistantText(null), '')
    })

    const aiMessage = (text) => ({ _getType: () => 'ai', content: text })

    test('subscribeAssistantResponses 推送新消息时通知监听者', () => {
        const messages = []
        const seen = []
        const off = characterRuntime.subscribeAssistantResponses(messages, () => 'S', (p) => seen.push(p.response))
        messages.push(aiMessage('one'))
        messages.push({ _getType: () => 'human', content: 'ignored' })
        messages.push(aiMessage(''))
        assert.deepEqual(seen, ['one'])
        off()
    })

    test('subscribeAssistantResponses 订阅时补发历史 AI 消息', () => {
        const messages = [aiMessage('old')]
        const seen = []
        characterRuntime.subscribeAssistantResponses(messages, () => 'S', (p) => seen.push(p.response))
        assert.deepEqual(seen, ['old'])
    })

    test('subscribeAssistantResponses 同一数组多次订阅共享 dispatcher 且各自只收一次', () => {
        const messages = []
        const a = []
        const b = []
        const offA = characterRuntime.subscribeAssistantResponses(messages, () => 'S', (p) => a.push(p.response))
        characterRuntime.subscribeAssistantResponses(messages, () => 'S', (p) => b.push(p.response))
        messages.push(aiMessage('x'))
        assert.deepEqual(a, ['x'])
        assert.deepEqual(b, ['x'])
        offA()
        messages.push(aiMessage('y'))
        assert.deepEqual(a, ['x'])
        assert.deepEqual(b, ['x', 'y'])
    })

    test('subscribeAssistantResponses 全部退订后恢复原始 push', () => {
        const messages = []
        const original = messages.push
        const offA = characterRuntime.subscribeAssistantResponses(messages, () => 'S', () => {})
        assert.notEqual(messages.push, original)
        offA()
        assert.equal(messages.push, original)
    })

    test('subscribeAssistantResponses 监听者抛错不影响其他监听者', () => {
        const messages = []
        const errors = []
        const seen = []
        characterRuntime.subscribeAssistantResponses(messages, () => 'S', () => { throw new Error('boom') }, (e) => errors.push(e))
        characterRuntime.subscribeAssistantResponses(messages, () => 'S', (p) => seen.push(p.response))
        messages.push(aiMessage('x'))
        assert.deepEqual(seen, ['x'])
        assert.equal(errors.length, 1)
    })

    test('subscribeAssistantResponses 后加入的订阅者不会让旧订阅者重收历史', () => {
        const messages = [aiMessage('old-1'), aiMessage('old-2')]
        const a = []
        const b = []
        characterRuntime.subscribeAssistantResponses(messages, () => 'S', (p) => a.push(p.response))
        characterRuntime.subscribeAssistantResponses(messages, () => 'S', (p) => b.push(p.response))
        assert.deepEqual(a, ['old-1', 'old-2'])
        assert.deepEqual(b, ['old-1', 'old-2'])
    })

    test('subscribeAssistantResponses 已有历史时新订阅不触发旧订阅者', () => {
        const messages = []
        const a = []
        characterRuntime.subscribeAssistantResponses(messages, () => 'S', (p) => a.push(p.response))
        messages.push(aiMessage('first'))
        characterRuntime.subscribeAssistantResponses(messages, () => 'S', () => {})
        assert.deepEqual(a, ['first'])
    })

    testAsync('registerGetTempListener 包装后保留原返回值并回调监听者', async () => {
        const original = async (a, b) => ({ completionMessages: [aiMessage('hi')], args: [a, b] })
        const service = { getTemp: original }
        const calls = []
        const off = characterRuntime.registerGetTempListener(service, (temp, session) => calls.push([temp, session]), (args) => args[0])
        const temp = await service.getTemp('S1', 'b')
        assert.equal(temp.args[0], 'S1')
        assert.equal(calls.length, 1)
        assert.equal(calls[0][1], 'S1')
        off()
        assert.equal(service.getTemp, original)
    })

    test('registerGetTempListener 服务缺少 getTemp 时返回 null', () => {
        assert.equal(characterRuntime.registerGetTempListener({}, () => {}, () => null), null)
    })

    testAsync('registerGetTempListener 监听者抛错不影响 getTemp 结果', async () => {
        const service = { getTemp: async () => ({ ok: true }) }
        const off = characterRuntime.registerGetTempListener(service, () => { throw new Error('boom') }, () => null)
        assert.deepEqual(await service.getTemp(), { ok: true })
        off()
    })

    testAsync('registerGetTempListener 多监听者时只包装一次且逐一清理', async () => {
        const original = async () => ({ v: 1 })
        const service = { getTemp: original }
        const seen = []
        const offA = characterRuntime.registerGetTempListener(service, () => seen.push('a'), () => null)
        const wrapped = service.getTemp
        const offB = characterRuntime.registerGetTempListener(service, () => seen.push('b'), () => null)
        assert.equal(service.getTemp, wrapped)
        await service.getTemp()
        assert.deepEqual(seen.sort(), ['a', 'b'])
        offA()
        assert.notEqual(service.getTemp, original)
        offB()
        assert.equal(service.getTemp, original)
    })

    const buildPrompt = (overrides) => prompt.buildInteractionPrompt(Object.assign({
        assistantLabel: '小明',
        persona: '<p>',
        detail: post(),
        trigger: { key: 'k', kind: 'friend-post', post: { id: 'p1', authorId: 'u9' }, actorId: 'u9', commentKey: null, occurredAt: null, detectedAt: 1 },
        activeComment: null,
        media: { lines: [], imageParts: [], descriptions: new Map(), storageFallbacks: 0, downloadFailedMedia: [] },
        promptTask: '',
        promptMedia: '',
        promptWriting: '',
        promptSystem: '',
        policy: { commentMode: 'forced', likeMode: 'off' }
    }, overrides))

    const promptText = (res) => {
        const content = res.inputMessage.content
        return content[0].text
    }

    test('buildInteractionPrompt 好友动态场景包含任务与契约', () => {
        const res = buildPrompt()
        assert.ok(res.systemPrompt.includes('你是小明'))
        assert.ok(res.systemPrompt.includes('&lt;p&gt;'))
        assert.ok(res.systemPrompt.includes('<qzone_decision>'))
        const text = promptText(res)
        assert.ok(text.includes('触发原因：好友发了新动态'))
        assert.ok(text.includes('<comments>') === false)
    })

    test('buildInteractionPrompt 回复场景标注当前目标', () => {
        const c = comment({ id: 'c5', kind: 'reply', threadRoot: ref('c0', 'bot') })
        const res = buildPrompt({
            detail: post({ comments: [comment({ id: 'c0', author: user('bot') }), c] }),
            trigger: { key: 'k', kind: 'friend-thread-reply', post: { id: 'p1', authorId: 'u9' }, actorId: 'u2', commentKey: 'ck', occurredAt: null, detectedAt: 1 },
            activeComment: c
        })
        const text = promptText(res)
        assert.ok(text.includes('你在好友动态下的评论池中有新消息'))
        assert.ok(text.includes('R1 - nu2(id:u2)'))
        assert.ok(text.includes('C1 - nbot(id:bot)'))
        assert.ok(text.includes('  R1'))
        assert.ok(text.includes('[当前目标]'))
    })

    test('buildInteractionPrompt 自身动态场景', () => {
        const c = comment({ id: 'c7' })
        const res = buildPrompt({
            detail: post({ comments: [c] }),
            trigger: { key: 'k', kind: 'self-comment', post: { id: 'p1', authorId: 'u1' }, actorId: 'u2', commentKey: 'ck', occurredAt: null, detectedAt: 1 },
            activeComment: c
        })
        assert.ok(promptText(res).includes('有人评论了你的动态'))
    })

    test('buildInteractionPrompt 转义动态与评论正文中的尖括号', () => {
        const res = buildPrompt({ detail: post({ content: '<b>&</b>', comments: [comment({ content: '<i>x</i>' })] }) })
        const text = promptText(res)
        assert.ok(text.includes('&lt;b&gt;&amp;&lt;/b&gt;'))
        assert.ok(text.includes('&lt;i&gt;x&lt;/i&gt;'))
    })

    test('buildInteractionPrompt 渲染媒体行与描述', () => {
        const res = buildPrompt({
            media: {
                lines: ['media_id=M1 status=attached'],
                imageParts: [{ type: 'image_url', image_url: { url: 'https://relay/1.png' } }],
                descriptions: new Map([['M2', '一只猫']]),
                storageFallbacks: 0,
                downloadFailedMedia: []
            }
        })
        const text = promptText(res)
        assert.ok(text.includes('<media>'))
        assert.ok(text.includes('<media_descriptions>'))
        assert.ok(text.includes('M2: 一只猫'))
        assert.equal(res.inputMessage.content.length, 2)
        assert.equal(res.inputMessage.content[1].image_url.url, 'https://relay/1.png')
    })

    test('buildInteractionPrompt 无评论时不输出 comments 块', () => {
        assert.ok(!promptText(buildPrompt()).includes('<comments>'))
    })

    test('buildInteractionPrompt 使用自定义模板并补齐缺失段落', () => {
        const res = buildPrompt({ promptSystem: 'H {{assistantLabel}} {{preset}} {{contract}}', promptTask: 'TASK', promptMedia: 'MEDIA', promptWriting: 'WRITE' })
        assert.ok(res.systemPrompt.startsWith('H 小明'))
        assert.ok(res.systemPrompt.includes('<task>\nTASK\n</task>'))
        assert.ok(res.systemPrompt.includes('<media_rules>\nMEDIA\n</media_rules>'))
        assert.ok(res.systemPrompt.includes('<writing_rules>\nWRITE\n</writing_rules>'))
    })

    test('buildInteractionPrompt 兼容 comments 顺序与 threadRoot 缺失', () => {
        const orphan = comment({ id: 'orphan', kind: 'reply', threadRoot: null })
        const res = buildPrompt({ detail: post({ comments: [orphan] }) })
        assert.ok(promptText(res).includes('R1 - nu2(id:u2)'))
    })

    test('prompt-defaults 导出全部非空默认段落', () => {
        const keys = Object.keys(promptDefaults)
        assert.ok(keys.length >= 8)
        for (const key of keys) {
            assert.equal(typeof promptDefaults[key], 'string', key)
            assert.ok(promptDefaults[key].trim().length > 0, key)
        }
    })

    test('NotFoundError 属于 QZONE_NOT_FOUND 体系供 runtime 精确捕获', () => {
        const e = new QzoneNotFoundError('gone')
        assert.equal(e.name, 'QzoneNotFoundError')
        assert.equal(e.code, 'QZONE_NOT_FOUND')
        assert.ok(e instanceof Error)
    })

    test('state 模块导出运行时构造入口', () => {
        for (const name of ['createInteractionRuntimeState', 'createMonitoredPost', 'discoverCommentTriggers', 'createFriendPostTrigger', 'enqueueTrigger', 'terminalizeTrigger', 'sortPendingTriggers', 'trimMonitoredPosts', 'removeMonitoredPost', 'isPostAfterWatermark', 'advanceFriendFeedWatermark', 'createFriendFeedWatermark', 'baselineMonitoredPost', 'findCommentByKey', 'postKey', 'commentKey', 'triggerKey', 'sameCommentReference', 'isCommentInBotThread']) {
            assert.equal(typeof state[name], 'function', name)
        }
    })
}
