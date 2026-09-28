'use strict'

const assert = require('node:assert/strict')

const memoryPlugin = (items) => ({ chatluna_memory: { listMemories: async () => ({ items }) } })

module.exports = (test, testAsync, { digestRuntime, memorySource, digestGenerator, fakeLogger }) => {
    test('parseDigestTime 接受 HH:mm 并拒绝非法格式', () => {
        assert.deepEqual(digestRuntime.parseDigestTime('23:00'), { hour: 23, minute: 0 })
        assert.deepEqual(digestRuntime.parseDigestTime(' 07:05 '), { hour: 7, minute: 5 })
        assert.equal(digestRuntime.parseDigestTime('24:00'), null)
        assert.equal(digestRuntime.parseDigestTime('7:00'), null)
        assert.equal(digestRuntime.parseDigestTime('23:60'), null)
        assert.equal(digestRuntime.parseDigestTime(''), null)
        assert.equal(digestRuntime.parseDigestTime('abc'), null)
    })

    const stubCtx = () => ({ on: () => {}, off: () => {} })

    const newRuntime = (config, ctx, deps) => new digestRuntime.DigestRuntime(ctx || stubCtx(), Object.assign({
        enableDailyDigest: true,
        digestTime: '23:00',
        personaPresetId: 'p',
        mainModel: 'm',
        digestMemoryLimit: 100,
        debug: false
    }, config), Object.assign({
        now: () => new Date(),
        logger: fakeLogger(),
        resolveModel: async () => ({ invoke: async () => ({ content: '' }) }),
        renderPersona: async () => 'persona'
    }, deps))

    test('DigestRuntime 未启用时保持 disabled 报告', () => {
        const r = newRuntime({ enableDailyDigest: false })
        assert.equal(r.report.phase, 'disabled')
        r.start()
        assert.equal(r.report.phase, 'disabled')
        r.stop()
    })

    test('DigestRuntime digestTime 非法时挂起并告警', () => {
        const logger = fakeLogger()
        const r = newRuntime({ digestTime: '99:99' }, null, { logger })
        r.start()
        assert.equal(r.report.phase, 'failed')
        assert.match(r.report.detail, /格式非法/)
        assert.ok(logger.lines.some(([level, msg]) => level === 'warn' && /格式非法/.test(msg)))
        r.stop()
    })

    test('DigestRuntime 合法时间时排期并记录下次触发', () => {
        const r = newRuntime({ digestTime: '23:00' }, null, { now: () => new Date(2026, 4, 20, 10, 0, 0) })
        r.start()
        assert.equal(r.report.phase, 'idle')
        assert.ok(r.report.nextRunAt !== null)
        assert.equal(new Date(r.report.nextRunAt).getDate(), 20)
        r.stop()
    })

    test('DigestRuntime 目标时刻已过时排到次日', () => {
        const r = newRuntime({ digestTime: '09:00' }, null, { now: () => new Date(2026, 4, 20, 10, 0, 0) })
        r.start()
        assert.equal(new Date(r.report.nextRunAt).getDate(), 21)
        r.stop()
    })

    test('DigestRuntime stop 后不再排期', () => {
        const r = newRuntime({})
        r.start()
        const before = r.report.nextRunAt
        r.stop()
        r.start()
        assert.equal(r.report.nextRunAt, before)
    })

    testAsync('DigestRuntime 缺少人设预设时挂起', async () => {
        const r = newRuntime({ personaPresetId: '   ' })
        const report = await r.runOnce('manual')
        assert.equal(report.phase, 'suspended')
        assert.match(report.detail, /personaPresetId/)
    })

    testAsync('DigestRuntime 模型为空时挂起而不是抛错', async () => {
        const r = newRuntime({ mainModel: '  ' })
        const report = await r.runOnce('manual')
        assert.equal(report.phase, 'suspended')
        assert.match(report.detail, /mainModel/)
    })

    testAsync('DigestRuntime 无记忆插件时挂起', async () => {
        const report = await newRuntime({}, {}).runOnce('manual')
        assert.equal(report.phase, 'suspended')
        assert.match(report.detail, /记忆插件/)
    })

    testAsync('DigestRuntime 记忆插件抛错时归为 failed', async () => {
        const ctx = { chatluna_memory: { listMemories: async () => { throw new Error('db down') } } }
        const report = await newRuntime({}, ctx).runOnce('manual')
        assert.equal(report.phase, 'failed')
        assert.match(report.detail, /db down/)
    })

    testAsync('DigestRuntime resolveModel 抛错时归为 failed', async () => {
        const report = await newRuntime({}, memoryPlugin([]), { resolveModel: async () => { throw new Error('model down') } }).runOnce('manual')
        assert.equal(report.phase, 'failed')
        assert.match(report.detail, /model down/)
    })

    testAsync('DigestRuntime 当日无记忆时跳过', async () => {
        const report = await newRuntime({}, memoryPlugin([])).runOnce('manual')
        assert.equal(report.phase, 'skipped')
        assert.match(report.detail, /没有记忆/)
    })

    testAsync('DigestRuntime 模型判定不发布时跳过', async () => {
        const ctx = memoryPlugin([{ id: '1', type: 'n', content: 'x', createdAt: new Date(2026, 4, 20, 9).toISOString() }])
        const report = await newRuntime({}, ctx, {
            resolveModel: async () => ({ invoke: async () => ({ content: '<qzone_digest><action>skip</action></qzone_digest>' }) })
        }).runOnce('manual')
        assert.equal(report.phase, 'skipped')
        assert.match(report.detail, /不宜公开/)
    })

    testAsync('DigestRuntime 模型契约无效时重试后归为 failed', async () => {
        const ctx = memoryPlugin([{ id: '1', type: 'n', content: 'x', createdAt: new Date(2026, 4, 20, 9).toISOString() }])
        let calls = 0
        const report = await newRuntime({}, ctx, {
            resolveModel: async () => ({ invoke: async () => { calls += 1; return { content: 'no contract' } } })
        }).runOnce('manual')
        assert.equal(report.phase, 'failed')
        assert.match(report.detail, /未产出有效结果/)
        assert.equal(calls, 7)
    })

    testAsync('DigestRuntime 发布失败时归为 failed', async () => {
        const ctx = memoryPlugin([{ id: '1', type: 'n', content: 'x', createdAt: new Date(2026, 4, 20, 9).toISOString() }])
        ctx.chatluna_qzone_interaction = {
            publishPost: async () => { throw new Error('publish down') }
        }
        const report = await newRuntime({}, ctx, {
            resolveModel: async () => ({ invoke: async () => ({ content: '<qzone_digest><action>publish</action><content>x</content></qzone_digest>' }) })
        }).runOnce('manual')
        assert.equal(report.phase, 'failed')
        assert.match(report.detail, /发布失败/)
    })

    testAsync('DigestRuntime 发布成功时返回 verified 结论', async () => {
        const ctx = memoryPlugin([{ id: '1', type: 'n', content: 'x', createdAt: new Date(2026, 4, 20, 9).toISOString() }])
        ctx.chatluna_qzone_interaction = {
            publishPost: async () => ({ outcome: 'verified' })
        }
        const report = await newRuntime({}, ctx, {
            resolveModel: async () => ({ invoke: async () => ({ content: '<qzone_digest><action>publish</action><content>x</content></qzone_digest>' }) })
        }).runOnce('manual')
        assert.equal(report.phase, 'published')
        assert.equal(report.memoryCount, 1)
        assert.match(report.lastOutcome, /发布成功/)
        assert.ok(report.lastRunAt !== null)
    })

    testAsync('DigestRuntime 并发触发时后一次被跳过', async () => {
        let calls = 0
        const r = newRuntime({}, memoryPlugin([]), {
            resolveModel: async () => { calls += 1; return { invoke: async () => ({ content: '' }) } }
        })
        const [a, b] = await Promise.all([r.runOnce('manual'), r.runOnce('manual')])
        assert.equal(a.phase, 'skipped')
        assert.equal(b.phase, 'skipped')
        assert.equal(calls, 1)
    })

    test('readMemoryProvider 优先 chatluna-memory', () => {
        const ctx = { chatluna_memory: { listMemories: async () => ({}) }, chatluna_living_memory: { listMemories: async () => ({}) } }
        assert.equal(memorySource.readMemoryProvider(ctx).pluginName, 'chatluna-memory')
        assert.equal(memorySource.readMemoryProvider({ chatluna_memory: {} }), null)
        assert.equal(memorySource.readMemoryProvider({}), null)
        assert.notEqual(memorySource.readMemoryService({ chatluna_living_memory: { listMemories: async () => ({}) } }), null)
        assert.equal(memorySource.readMemoryService({}), null)
    })

    test('startOfLocalDay 取本地零点', () => {
        assert.equal(memorySource.startOfLocalDay(new Date(2026, 4, 20, 13, 30)), new Date(2026, 4, 20).getTime())
    })

    testAsync('readTodayMemories 过滤当天、排序并保留最新 limit 条', async () => {
        const items = [
            { id: '1', type: 'a', content: ' 早 ', createdAt: new Date(2026, 4, 20, 8).toISOString() },
            { id: '2', type: 'b', content: '午', createdAt: new Date(2026, 4, 20, 12).toISOString() },
            { id: '3', type: 'c', content: '晚', createdAt: new Date(2026, 4, 20, 20).toISOString() },
            { id: '4', type: 'd', content: '昨天', createdAt: new Date(2026, 4, 19, 20).toISOString() },
            { id: '5', type: 'e', content: '   ', createdAt: new Date(2026, 4, 20, 9).toISOString() },
            { id: '6', type: 'f', content: '坏时间', createdAt: 'not-a-date' },
            { id: '7', type: 'g', content: '缺时间' },
            { id: '8', type: 'h', createdAt: new Date(2026, 4, 20, 9).toISOString() },
            { id: 9, createdAt: new Date(2026, 4, 20, 9).toISOString() }
        ]
        const res = await memorySource.readTodayMemories(memoryPlugin(items), 'p', 2, new Date(2026, 4, 20, 10))
        assert.equal(res.serviceAvailable, true)
        assert.equal(res.pluginName, 'chatluna-memory')
        assert.deepEqual(res.memories.map((m) => m.content), ['午', '晚'])
    })

    testAsync('readTodayMemories 缺 type 时回退为 other', async () => {
        const res = await memorySource.readTodayMemories(
            memoryPlugin([{ id: '1', content: 'x', createdAt: new Date(2026, 4, 20, 9).toISOString() }]),
            'p', 10, new Date(2026, 4, 20, 10)
        )
        assert.equal(res.memories[0].type, 'other')
    })

    testAsync('readTodayMemories 无插件时返回不可用', async () => {
        const res = await memorySource.readTodayMemories({}, 'p', 10, new Date())
        assert.equal(res.serviceAvailable, false)
        assert.equal(res.pluginName, null)
        assert.equal(res.memories.length, 0)
    })

    testAsync('readTodayMemories 兼容缺 items 的响应', async () => {
        const ctx = { chatluna_memory: { listMemories: async () => ({}) } }
        const res = await memorySource.readTodayMemories(ctx, 'p', 10, new Date())
        assert.equal(res.serviceAvailable, true)
        assert.equal(res.memories.length, 0)
    })

    testAsync('readTodayMemories 使用 livingmemory 回退来源', async () => {
        const ctx = { chatluna_living_memory: { listMemories: async () => ({ items: [] }) } }
        const res = await memorySource.readTodayMemories(ctx, 'p', 10, new Date())
        assert.equal(res.pluginName, 'chatluna-livingmemory')
    })

    test('formatDigestTime 输出 HH:mm', () => {
        assert.equal(digestGenerator.formatDigestTime(new Date(2026, 4, 20, 8, 5)), '08:05')
    })

    test('buildDigestPrompt 转义人设与记忆并注入契约', () => {
        const res = digestGenerator.buildDigestPrompt({
            assistantLabel: 'A&B',
            persona: '<script>',
            memories: [{ id: '1', type: 'note', content: 'a<b&c', createdAt: new Date(2026, 4, 20, 8) }],
            dateLabel: '2026-05-20',
            promptTask: '',
            promptVoice: '',
            promptSystem: ''
        })
        assert.ok(res.systemPrompt.includes('A&amp;B'))
        assert.ok(res.systemPrompt.includes('&lt;script&gt;'))
        assert.ok(res.inputMessage.content.includes('a&lt;b&amp;c'))
        assert.ok(res.systemPrompt.includes('<qzone_digest>'))
    })

    test('buildDigestPrompt 使用自定义模板并补齐缺失段落', () => {
        const res = digestGenerator.buildDigestPrompt({
            assistantLabel: 'L', persona: 'P', memories: [], dateLabel: 'D',
            promptTask: 'TASK', promptVoice: 'VOICE',
            promptSystem: 'head {{assistantLabel}} {{preset}} {{contract}}'
        })
        assert.ok(res.systemPrompt.includes('head L P'))
        assert.ok(res.systemPrompt.includes('<task>\nTASK\n</task>'))
        assert.ok(res.systemPrompt.includes('<writing_rules>\nVOICE\n</writing_rules>'))
    })

    testAsync('DigestRuntime mainModel 为占位符时挂起而不是报错', async () => {
        let resolveCalls = 0
        const r = newRuntime(
            { mainModel: '无' },
            { on: () => {}, off: () => {} },
            {
                resolveModel: async () => {
                    resolveCalls += 1
                    throw new Error('模型占位符不应被解析')
                }
            }
        )
        const report = await r.runOnce('manual')
        assert.equal(report.phase, 'suspended')
        assert.equal(resolveCalls, 0)
    })

    testAsync('DigestRuntime mainModel 为空串时同样挂起', async () => {
        let resolveCalls = 0
        const r = newRuntime(
            { mainModel: '   ' },
            { on: () => {}, off: () => {} },
            { resolveModel: async () => { resolveCalls += 1; return null } }
        )
        const report = await r.runOnce('manual')
        assert.equal(report.phase, 'suspended')
        assert.equal(resolveCalls, 0)
    })
}
