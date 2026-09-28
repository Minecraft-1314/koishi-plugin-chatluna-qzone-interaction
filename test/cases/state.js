'use strict'

const assert = require('node:assert/strict')

module.exports = (test, testAsync, { state, post, comment, user, ref }) => {
    test('postKey/commentKey/triggerKey 组合稳定', () => {
        assert.equal(state.postKey({ id: 'p1', authorId: 'u1' }), 'u1:p1')
        const p = post()
        assert.equal(state.commentKey(p, comment({ id: 'c9' })), 'u1:p1:comment:-:-:u2:c9')
        const r = comment({ id: 'c10', kind: 'reply', threadRoot: ref('c9', 'u2') })
        assert.equal(state.commentKey(p, r), 'u1:p1:reply:u2:c9:u2:c10')
        assert.equal(state.triggerKey('friend-post', { id: 'p1', authorId: 'u1' }), 'friend-post:u1:p1:-')
        assert.equal(state.triggerKey('self-comment', { id: 'p1', authorId: 'u1' }, 'k'), 'self-comment:u1:p1:k')
    })

    test('sameCommentReference 区分空值与错配', () => {
        assert.equal(state.sameCommentReference(null, null), true)
        assert.equal(state.sameCommentReference(null, ref('a', 'b')), false)
        assert.equal(state.sameCommentReference(ref('a', 'b'), null), false)
        assert.equal(state.sameCommentReference(ref('a', 'b'), ref('a', 'b')), true)
        assert.equal(state.sameCommentReference(ref('a', 'b'), ref('a', 'c')), false)
    })

    const trigger = (overrides) => Object.assign({
        key: 'k',
        kind: 'friend-post',
        post: { id: 'p', authorId: 'u' },
        actorId: 'u',
        commentKey: null,
        occurredAt: null,
        detectedAt: 1
    }, overrides)

    test('enqueueTrigger 对 pending 与 terminal 都去重', () => {
        const s = state.createInteractionRuntimeState()
        assert.equal(state.enqueueTrigger(s, trigger()), true)
        assert.equal(state.enqueueTrigger(s, trigger()), false)
        state.terminalizeTrigger(s, 'k', 'verified', 2)
        assert.equal(s.pendingTriggers.size, 0)
        assert.equal(s.terminalTriggers.size, 1)
        assert.equal(state.enqueueTrigger(s, trigger()), false)
    })

    test('sortPendingTriggers 按 kind 优先级再按时间与 key', () => {
        const make = (kind, occurredAt, key) => trigger({ key, kind, occurredAt })
        const sorted = state.sortPendingTriggers([
            make('friend-post', 1, 'a'),
            make('self-comment', 5, 'b'),
            make('friend-thread-reply', 5, 'c'),
            make('friend-thread-reply', 2, 'd'),
            make('self-comment', null, 'e')
        ])
        assert.deepEqual(sorted.map((x) => x.key), ['d', 'c', 'e', 'b', 'a'])
    })

    test('baselineMonitoredPost 快照不完整时不推进基线', () => {
        const monitored = state.createMonitoredPost(post(), 'self', 0, false)
        state.baselineMonitoredPost(monitored, post({ commentsComplete: false }), 5)
        assert.equal(monitored.baselineReady, false)
        assert.equal(monitored.seenComments.size, 0)
    })

    test('baselineMonitoredPost 完整时记录已见评论并清空忽略水位', () => {
        const p = post({ comments: [comment({ id: 'c1' }), comment({ id: 'c2', author: user('u3') })] })
        const monitored = state.createMonitoredPost(p, 'self', 0, false)
        monitored.ignoreCommentsThrough = 999
        state.baselineMonitoredPost(monitored, p, 5)
        assert.equal(monitored.baselineReady, true)
        assert.equal(monitored.seenComments.size, 2)
        assert.equal(monitored.ignoreCommentsThrough, null)
        assert.equal(monitored.baselineObservationPending, false)
    })

    test('discoverCommentTriggers 未就绪时自动补基线且不产生触发', () => {
        const p = post({ comments: [comment({ id: 'c1' })] })
        const monitored = state.createMonitoredPost(p, 'self', 0, false)
        assert.equal(state.discoverCommentTriggers(monitored, p, { botId: 'bot', detectedAt: 1 }).length, 0)
        assert.equal(monitored.baselineReady, true)
    })

    test('discoverCommentTriggers 快照不完整时返回空', () => {
        const monitored = state.createMonitoredPost(post(), 'self', 0, true)
        assert.equal(state.discoverCommentTriggers(monitored, post({ commentsComplete: false }), { botId: 'b', detectedAt: 1 }).length, 0)
    })

    test('discoverCommentTriggers 自身动态：他人评论触发，bot 自己的评论忽略', () => {
        const p = post({ comments: [comment({ id: 'c1', author: user('u2') }), comment({ id: 'c2', author: user('bot') })] })
        const monitored = state.createMonitoredPost(p, 'self', 0, true)
        const triggers = state.discoverCommentTriggers(monitored, p, { botId: 'bot', detectedAt: 1 })
        assert.equal(triggers.length, 1)
        assert.equal(triggers[0].kind, 'self-comment')
        assert.equal(triggers[0].actorId, 'u2')
    })

    test('discoverCommentTriggers 好友动态：只有 bot 主楼内的回复触发', () => {
        const p = post({
            authorId: 'u9',
            author: user('u9'),
            comments: [
                comment({ id: 'root', author: user('bot'), kind: 'comment' }),
                comment({ id: 'inBot', author: user('u2'), kind: 'reply', threadRoot: ref('root', 'bot') }),
                comment({ id: 'other', author: user('u3'), kind: 'reply', threadRoot: ref('x', 'u4') }),
                comment({ id: 'flat', author: user('u5'), kind: 'comment' })
            ]
        })
        const monitored = state.createMonitoredPost(p, 'friend', 0, true, ref('root', 'bot'))
        const triggers = state.discoverCommentTriggers(monitored, p, { botId: 'bot', detectedAt: 1 })
        assert.equal(triggers.length, 1)
        assert.equal(triggers[0].kind, 'friend-thread-reply')
        assert.equal(triggers[0].actorId, 'u2')
    })

    test('discoverCommentTriggers 观察期内忽略旧评论', () => {
        const p = post({ comments: [comment({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' })] })
        const monitored = state.createMonitoredPost(p, 'self', 0, true)
        monitored.ignoreCommentsThrough = Date.parse('2026-01-01T00:00:05.000Z')
        monitored.baselineObservationPending = true
        assert.equal(state.discoverCommentTriggers(monitored, p, { botId: 'bot', detectedAt: 10 }).length, 0)
    })

    test('discoverCommentTriggers 无忽略水位时无日期评论照常触发', () => {
        const undated = post({ comments: [comment({ id: 'u', createdAt: null })] })
        const monitored = state.createMonitoredPost(undated, 'self', 0, true)
        monitored.baselineObservationPending = true
        assert.equal(state.discoverCommentTriggers(monitored, undated, { botId: 'bot', detectedAt: 10 }).length, 1)
        assert.equal(monitored.baselineObservationPending, false)
    })

    test('discoverCommentTriggers 观察期后无日期评论可正常触发', () => {
        const p = post({ comments: [comment({ id: 'u', createdAt: null })] })
        const monitored = state.createMonitoredPost(p, 'self', 0, true)
        assert.equal(state.discoverCommentTriggers(monitored, p, { botId: 'bot', detectedAt: 10 }).length, 1)
    })

    test('discoverCommentTriggers 同一条评论不会被重复发现', () => {
        const p = post({ comments: [comment({ id: 'c1' })] })
        const monitored = state.createMonitoredPost(p, 'self', 0, true)
        assert.equal(state.discoverCommentTriggers(monitored, p, { botId: 'bot', detectedAt: 1 }).length, 1)
        assert.equal(state.discoverCommentTriggers(monitored, p, { botId: 'bot', detectedAt: 2 }).length, 0)
    })

    test('isCommentInBotThread 只认同主楼的回复', () => {
        const root = ref('root', 'bot')
        assert.equal(state.isCommentInBotThread(comment({ kind: 'reply', threadRoot: root }), root), true)
        assert.equal(state.isCommentInBotThread(comment({ kind: 'comment', threadRoot: null }), root), false)
        assert.equal(state.isCommentInBotThread(comment({ kind: 'reply', threadRoot: ref('x', 'y') }), root), false)
    })

    test('findCommentByKey 找不到时回退为 null', () => {
        const p = post({ comments: [comment({ id: 'c1' })] })
        assert.equal(state.findCommentByKey(p, state.commentKey(p, p.comments[0])).id, 'c1')
        assert.equal(state.findCommentByKey(p, 'nope'), null)
    })

    test('createFriendFeedWatermark 取最大时间并记录窗口内全部 key', () => {
        const w = state.createFriendFeedWatermark([
            post({ id: 'a', createdAt: '2026-01-01T00:00:01.000Z' }),
            post({ id: 'b', createdAt: '2026-01-01T00:00:03.000Z' }),
            post({ id: 'c', createdAt: '2026-01-01T00:00:03.000Z' })
        ], 999)
        assert.equal(w.timestamp, Date.parse('2026-01-01T00:00:03.000Z'))
        assert.deepEqual([...w.recentKeys.keys()].sort(), ['u1:a', 'u1:b', 'u1:c'])
    })

    test('createFriendFeedWatermark 丢弃窗口外的旧 key', () => {
        const w = state.createFriendFeedWatermark([
            post({ id: 'old', createdAt: '2025-12-31T00:00:00.000Z' }),
            post({ id: 'new', createdAt: '2026-01-01T00:00:03.000Z' })
        ], 0)
        assert.equal(w.recentKeys.has('u1:old'), false)
        assert.equal(w.recentKeys.has('u1:new'), true)
    })

    test('createFriendFeedWatermark 全部无日期时回退到给定时间', () => {
        const w = state.createFriendFeedWatermark([post({ createdAt: null })], 4242)
        assert.equal(w.timestamp, 4242)
        assert.equal(w.recentKeys.size, 0)
    })

    test('isPostAfterWatermark 处理同刻新帖、旧帖与无日期帖', () => {
        const w = state.createFriendFeedWatermark([post({ id: 'a', createdAt: '2026-01-01T00:00:01.000Z' })], 0)
        assert.equal(state.isPostAfterWatermark(post({ id: 'a', createdAt: '2026-01-01T00:00:01.000Z' }), w), false)
        assert.equal(state.isPostAfterWatermark(post({ id: 'b', createdAt: '2026-01-01T00:00:01.000Z' }), w), true)
        assert.equal(state.isPostAfterWatermark(post({ id: 'c', createdAt: '2026-01-01T00:00:02.000Z' }), w), true)
        assert.equal(state.isPostAfterWatermark(post({ id: 'd', createdAt: '2025-12-31T00:00:00.000Z' }), w), false)
        assert.equal(state.isPostAfterWatermark(post({ id: 'e', createdAt: null }), w), false)
    })

    test('advanceFriendFeedWatermark 不倒退且同刻合并 key', () => {
        const cur = state.createFriendFeedWatermark([post({ id: 'a', createdAt: '2026-01-01T00:00:05.000Z' })], 0)
        assert.equal(state.advanceFriendFeedWatermark(cur, [post({ id: 'x', createdAt: '2026-01-01T00:00:01.000Z' })]), cur)
        const same = state.advanceFriendFeedWatermark(cur, [post({ id: 'b', createdAt: '2026-01-01T00:00:05.000Z' })])
        assert.equal(same.timestamp, cur.timestamp)
        assert.equal(same.recentKeys.size, 2)
        const newer = state.advanceFriendFeedWatermark(cur, [post({ id: 'c', createdAt: '2026-01-01T00:00:09.000Z' })])
        assert.equal(newer.timestamp, Date.parse('2026-01-01T00:00:09.000Z'))
        assert.ok(newer.recentKeys.has(state.postKey(post({ id: 'c' }))))
    })

    test('宽限窗口内的乱序动态会被识别为新动态', () => {
        const newest = post({ id: 'a', createdAt: '2026-01-01T00:10:00.000Z' })
        const w = state.createFriendFeedWatermark([newest], 0)
        const outOfOrder = post({ id: 'b', createdAt: '2026-01-01T00:05:00.000Z' })
        assert.equal(state.isPostAfterWatermark(outOfOrder, w), true)
    })

    test('宽限窗口外的乱序动态仍被跳过', () => {
        const newest = post({ id: 'a', createdAt: '2026-01-01T00:10:00.000Z' })
        const w = state.createFriendFeedWatermark([newest], 0)
        const tooOld = post({ id: 'b', createdAt: '2025-12-31T23:50:00.000Z' })
        assert.equal(state.isPostAfterWatermark(tooOld, w), false)
    })

    test('宽限窗口边界为闭区间', () => {
        const newest = post({ id: 'a', createdAt: '2026-01-01T00:10:00.000Z' })
        const w = state.createFriendFeedWatermark([newest], 0)
        const edge = post({ id: 'b', createdAt: '2026-01-01T00:00:00.000Z' })
        assert.equal(state.isPostAfterWatermark(edge, w), true)
    })

    test('宽限窗口内的已见动态不会重复处理', () => {
        const seen = post({ id: 'a', createdAt: '2026-01-01T00:05:00.000Z' })
        const newest = post({ id: 'b', createdAt: '2026-01-01T00:10:00.000Z' })
        const w = state.createFriendFeedWatermark([seen, newest], 0)
        assert.equal(w.recentKeys.has(state.postKey(seen)), true)
        assert.equal(state.isPostAfterWatermark(seen, w), false)
    })

    test('水位线前移时宽限记录随窗口收敛', () => {
        const old = post({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' })
        const mid = post({ id: 'mid', createdAt: '2026-01-01T00:05:00.000Z' })
        const cur = state.createFriendFeedWatermark([old, mid], 0)
        assert.equal(state.isPostAfterWatermark(old, cur), false)
        const far = post({ id: 'far', createdAt: '2026-01-02T00:00:00.000Z' })
        const advanced = state.advanceFriendFeedWatermark(cur, [far])
        assert.equal(advanced.timestamp, Date.parse('2026-01-02T00:00:00.000Z'))
        assert.deepEqual([...advanced.recentKeys.keys()], ['u1:far'])
    })

    test('同刻推进时宽限记录合并保留', () => {
        const a = post({ id: 'a', createdAt: '2026-01-01T00:10:00.000Z' })
        const cur = state.createFriendFeedWatermark([a], 0)
        const b = post({ id: 'b', createdAt: '2026-01-01T00:07:00.000Z' })
        const same = state.advanceFriendFeedWatermark(cur, [a, b])
        assert.equal(same.timestamp, cur.timestamp)
        assert.equal(same.recentKeys.has(state.postKey(b)), true)
        assert.equal(state.isPostAfterWatermark(b, same), false)
    })

    test('isPostBeforeWatermark 与宽限窗口一致', () => {
        const newest = post({ id: 'a', createdAt: '2026-01-01T00:10:00.000Z' })
        const w = state.createFriendFeedWatermark([newest], 0)
        assert.equal(state.isPostBeforeWatermark(post({ id: 'b', createdAt: '2026-01-01T00:05:00.000Z' }), w), false)
        assert.equal(state.isPostBeforeWatermark(post({ id: 'c', createdAt: '2025-12-31T23:00:00.000Z' }), w), true)
        assert.equal(state.isPostBeforeWatermark(post({ id: 'd', createdAt: null }), w), false)
    })

    test('关闭宽限窗口时行为与旧版一致', () => {
        const newest = post({ id: 'a', createdAt: '2026-01-01T00:10:00.000Z' })
        const w = state.createFriendFeedWatermark([newest], 0, 0)
        assert.equal(state.isPostAfterWatermark(post({ id: 'b', createdAt: '2026-01-01T00:05:00.000Z' }), w, 0), false)
    })

    test('pruneTerminalTriggers 按 TTL 清理过期记录', () => {
        const s = state.createInteractionRuntimeState()
        s.terminalTriggers.set('a', { result: 'verified', completedAt: 1000 })
        s.terminalTriggers.set('b', { result: 'verified', completedAt: 9000 })
        const pruned = state.pruneTerminalTriggers(s, 10000, 5000)
        assert.equal(pruned.expired, 1)
        assert.equal(pruned.remaining, 1)
        assert.equal(s.terminalTriggers.has('a'), false)
        assert.equal(s.terminalTriggers.has('b'), true)
    })

    test('pruneTerminalTriggers 超量时按插入顺序淘汰最旧记录', () => {
        const s = state.createInteractionRuntimeState()
        for (let i = 0; i < 10; i += 1) {
            s.terminalTriggers.set('k' + i, { result: 'verified', completedAt: 1000 + i })
        }
        const pruned = state.pruneTerminalTriggers(s, 1000, Number.MAX_SAFE_INTEGER, 4)
        assert.equal(pruned.overflow, 6)
        assert.equal(s.terminalTriggers.size, 4)
        assert.equal(s.terminalTriggers.has('k0'), false)
        assert.equal(s.terminalTriggers.has('k9'), true)
    })

    test('pruneTerminalTriggers 保留 pending 不受影响', () => {
        const s = state.createInteractionRuntimeState()
        s.pendingTriggers.set('p', { key: 'p', kind: 'friend-post', post: { id: 'p', authorId: 'u' }, actorId: 'u', commentKey: null, occurredAt: null, detectedAt: 0 })
        s.terminalTriggers.set('t', { result: 'verified', completedAt: 0 })
        state.pruneTerminalTriggers(s, 999999, 1)
        assert.equal(s.pendingTriggers.size, 1)
        assert.equal(s.terminalTriggers.size, 0)
    })

    test('终态收敛常量处于合理量级', () => {
        assert.ok(state.MAX_TERMINAL_TRIGGERS > 0)
        assert.ok(state.TERMINAL_TRIGGER_TTL_MS >= 24 * 60 * 60 * 1000)
        assert.ok(state.FRIEND_FEED_GRACE_MS > 0)
    })

    test('抬升水位线后基线页内的动态不会被回扫', () => {
        const seen = post({ id: 'seen', createdAt: '2026-01-01T00:00:00.000Z' })
        const base = state.createFriendFeedWatermark([seen], 0)
        const raised = state.raiseFriendFeedWatermark(base, Date.parse('2026-01-01T00:05:00.000Z'))
        assert.equal(raised.timestamp, Date.parse('2026-01-01T00:05:00.000Z'))
        assert.equal(state.isPostAfterWatermark(seen, raised), false)
    })

    test('抬升水位线后窗口外的老动态同样不会被回扫', () => {
        const seen = post({ id: 'seen', createdAt: '2026-01-01T00:00:00.000Z' })
        const base = state.createFriendFeedWatermark([seen], 0)
        const raised = state.raiseFriendFeedWatermark(base, Date.parse('2026-01-01T06:00:00.000Z'))
        assert.equal(state.isPostAfterWatermark(seen, raised), false)
    })

    test('抬升水位线不会把时间往回推', () => {
        const base = state.createFriendFeedWatermark([post({ createdAt: '2026-01-01T00:10:00.000Z' })], 0)
        const same = state.raiseFriendFeedWatermark(base, Date.parse('2026-01-01T00:05:00.000Z'))
        assert.equal(same, base)
    })

    test('抬升水位线后抬升之后的新动态仍能被发现', () => {
        const base = state.createFriendFeedWatermark([post({ createdAt: '2026-01-01T00:00:00.000Z' })], 0)
        const raised = state.raiseFriendFeedWatermark(base, Date.parse('2026-01-01T00:05:00.000Z'))
        const fresh = post({ id: 'fresh', createdAt: '2026-01-01T00:06:00.000Z' })
        assert.equal(state.isPostAfterWatermark(fresh, raised), true)
    })

    test('关闭宽限期时抬升会丢弃已见记录', () => {
        const seen = post({ id: 'seen', createdAt: '2026-01-01T00:00:00.000Z' })
        const base = state.createFriendFeedWatermark([seen], 0, 0)
        const raised = state.raiseFriendFeedWatermark(base, Date.parse('2026-01-01T00:05:00.000Z'), 0)
        assert.equal(raised.recentKeys.size, 0)
    })

    test('trimMonitoredPosts 按活跃度保留并清理关联触发', () => {
        const s = state.createInteractionRuntimeState()
        const keep = state.createMonitoredPost(post({ id: 'keep' }), 'self', 100, true)
        const drop = state.createMonitoredPost(post({ id: 'drop' }), 'self', 1, true)
        s.monitoredPosts.set(keep.key, keep)
        s.monitoredPosts.set(drop.key, drop)
        s.pendingTriggers.set('t1', trigger({ key: 't1', kind: 'self-comment', post: drop.post, commentKey: 'k' }))
        s.pendingTriggers.set('t2', trigger({ key: 't2', kind: 'friend-post', post: keep.post }))
        s.terminalTriggers.set('self-comment:' + drop.key + ':k', { result: 'verified', completedAt: 1 })
        assert.deepEqual(state.trimMonitoredPosts(s, 1), [drop.key])
        assert.equal(s.pendingTriggers.has('t1'), false)
        assert.equal(s.pendingTriggers.has('t2'), true)
        assert.equal(s.terminalTriggers.has('self-comment:' + drop.key + ':k'), false)
    })

    test('trimMonitoredPosts limit 为 0 时清空全部', () => {
        const s = state.createInteractionRuntimeState()
        s.monitoredPosts.set('a', state.createMonitoredPost(post({ id: 'a' }), 'self', 1, true))
        assert.deepEqual(state.trimMonitoredPosts(s, 0), ['a'])
        assert.equal(s.monitoredPosts.size, 0)
    })

    test('removeMonitoredPost 保留 friend-post 终态记录', () => {
        const s = state.createInteractionRuntimeState()
        const key = 'u1:p1'
        s.terminalTriggers.set('friend-post:' + key + ':-', { result: 'verified', completedAt: 1 })
        s.terminalTriggers.set('friend-thread-reply:' + key + ':kk', { result: 'verified', completedAt: 1 })
        state.removeMonitoredPost(s, key)
        assert.equal(s.terminalTriggers.has('friend-post:' + key + ':-'), true)
        assert.equal(s.terminalTriggers.has('friend-thread-reply:' + key + ':kk'), false)
    })
}
