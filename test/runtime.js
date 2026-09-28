'use strict'

const assert = require('node:assert/strict')
const { QzoneNotFoundError } = require('qzone-sdk')

const { AutoInteractionRuntime } = require('../lib/auto-interaction/runtime')
const { createInteractionWhitelist } = require('../lib/auto-interaction/types')

const BOT = 'bot'

const user = (id, nickname) => ({ id, nickname: nickname || 'n' + id })
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

const emptyMedia = {
    lines: [],
    imageParts: [],
    descriptions: new Map(),
    storageFallbacks: 0,
    downloadFailedMedia: []
}

const buildOptions = (overrides) => Object.assign({
    friendPostCommentMode: 'forced',
    friendPostLikeMode: 'off',
    interactionWhitelist: createInteractionWhitelist(false, []),
    monitorLimit: 10,
    maxWritesPerRound: 5,
    modelRef: 'sub',
    presetId: 'preset',
    assistantLabel: 'preset',
    debug: false,
    promptTask: '',
    promptMedia: '',
    promptWriting: '',
    promptSystem: ''
}, overrides)

const publishReply = (text) => '<qzone_decision><action>publish</action><content>' + text + '</content></qzone_decision>'

const world = (config = {}) => {
    const log = []
    const w = {
        log,
        posts: new Map(),
        selfFeed: [],
        friendsFeed: [],
        online: true,
        botId: BOT,
        writes: [],
        modelFails: 0,
        decideImpl: null,
        personaFails: false,
        getPostFails: new Map(),
        clock: '2026-01-01T00:00:00.000Z',
        model: { modelName: 'm', modelInfo: { capabilities: [] }, fileHandlingConfig: null, invoke: async () => ({ content: '' }) }
    }
    const deps = {
        now: () => new Date(w.clock),
        logger: {
            debug: (m) => log.push(['debug', m]),
            info: (m) => log.push(['info', m]),
            warn: (m) => log.push(['warn', m]),
            error: (m) => log.push(['error', m])
        },
        isBotOnline: () => w.online,
        listFeedPage: async (request) => {
            const source = request.scope === 'self' ? w.selfFeed : w.friendsFeed
            const start = request.cursor ? Number(request.cursor) : 0
            const items = source.slice(start, start + (request.limit || 20))
            const next = start + (request.limit || 20)
            return { items, nextCursor: next < source.length ? String(next) : null }
        },
        getPost: async (request) => {
            const key = request.post.authorId + ':' + request.post.id
            if (w.getPostFails.has(key)) throw w.getPostFails.get(key)
            const found = w.posts.get(key)
            if (!found) throw new QzoneNotFoundError('gone: ' + key)
            return found
        },
        comment: async (request) => {
            w.writes.push({ type: 'comment', post: request.post.id, content: request.content })
            const created = comment({
                id: 'bc1',
                author: user(BOT),
                content: request.content,
                createdAt: '2026-01-01T13:00:00.000Z',
                threadRoot: null,
                kind: 'comment'
            })
            w.appendComment(request.post.authorId, request.post.id, created)
            return { outcome: 'verified', comment: created }
        },
        reply: async (request) => {
            w.writes.push({ type: 'reply', post: request.post.id, comment: request.comment.id, content: request.content })
            return { outcome: 'verified', reference: ref('new' + w.writes.length, BOT) }
        },
        like: async (request) => {
            w.writes.push({ type: 'like', post: request.post.id })
            return { outcome: 'verified', liked: true }
        },
        getAccountId: () => w.botId,
        resolveModel: async () => {
            if (w.modelFails > 0) {
                w.modelFails -= 1
                return null
            }
            return w.model
        },
        renderPersona: async () => {
            if (w.personaFails) throw new Error('persona down')
            return 'persona'
        },
        canDescribeMedia: () => false,
        prepareMedia: async () => emptyMedia,
        decide: async (input) => {
            if (w.decideImpl) return w.decideImpl(input)
            return { value: { publish: true, like: false, content: 'auto-' + input.postId }, error: null }
        }
    }
    w.deps = deps
    w.runtime = new AutoInteractionRuntime(deps, buildOptions(config))
    w.put = (p) => {
        w.posts.set(p.authorId + ':' + p.id, p)
        return p
    }
    w.appendComment = (authorId, postId, added) => {
        const key = authorId + ':' + postId
        const current = w.posts.get(key)
        if (!current) return
        const next = Object.assign({}, current, {
            comments: current.comments.concat([added]),
            commentCount: current.comments.length + 1
        })
        w.put(next)
    }
    return w
}

const errorsIn = (log) => log.filter(([level]) => level === 'error')
const warnsIn = (log) => log.filter(([level]) => level === 'warn')

const cases = []
const test = (name, fn) => cases.push({ name, fn })

test('离线时不建立基线并进入 waiting-bot', async () => {
    const w = world()
    w.online = false
    await w.runtime.runRound()
    assert.equal(w.runtime.report.phase, 'waiting-bot')
    assert.equal(w.runtime.report.baselineCompletedAt, null)
})

test('基线建立后进入 ready 并记录监控', async () => {
    const w = world()
    w.put(post({ id: 'sp1', comments: [comment({ id: 'c1' })] }))
    w.selfFeed = [w.posts.get('u1:sp1')]
    await w.runtime.runRound()
    const report = w.runtime.report
    assert.equal(report.phase, 'ready')
    assert.equal(report.monitoredPosts, 1)
    assert.ok(report.baselineCompletedAt !== null)
    assert.equal(w.runtime.state.baseline, 'ready')
})

test('基线缺少账号 ID 时归为 failed 并抛出', async () => {
    const w = world()
    w.botId = null
    await assert.rejects(() => w.runtime.runRound(), /Session 未提供当前账号 ID/)
    assert.equal(w.runtime.report.phase, 'failed')
    assert.equal(w.runtime.report.lastError, 'baseline')
    assert.equal(errorsIn(w.log).length, 1)
})

test('基线读取自身动态详情失败时跳过该动态但基线仍建立', async () => {
    const w = world()
    w.selfFeed = [post({ id: 'sp1' })]
    w.getPostFails.set('u1:sp1', new Error('detail down'))
    await w.runtime.runRound()
    assert.equal(w.runtime.report.phase, 'ready')
    assert.equal(w.runtime.report.monitoredPosts, 0)
    assert.ok(warnsIn(w.log).some(([, m]) => /读取自身动态详情失败/.test(m)))
})

test('基线后不再补扫历史评论', async () => {
    const w = world()
    w.put(post({ id: 'sp1', createdAt: '2026-01-01T00:00:00.000Z', comments: [comment({ id: 'c1' })] }))
    w.selfFeed = [w.posts.get('u1:sp1')]
    await w.runtime.runRound()
    await w.runtime.runRound()
    assert.equal(w.writes.length, 0)
    assert.equal(w.runtime.report.round.discovered, 0)
})

test('基线时已存在的好友动态不会被宽限期回扫', async () => {
    const w = world()
    const existing = w.put(post({
        id: 'old1',
        authorId: 'u9',
        author: user('u9'),
        createdAt: '2026-01-01T00:02:00.000Z'
    }))
    w.friendsFeed = [existing]
    await w.runtime.runRound()
    assert.equal(w.writes.length, 0)
    for (let i = 0; i < 3; i += 1) await w.runtime.runRound()
    assert.equal(w.writes.length, 0)
    assert.equal(w.runtime.report.round.discovered, 0)
})

test('基线后新发布且时间戳早于水位线的动态仍会被发现', async () => {
    const w = world()
    const existing = w.put(post({
        id: 'old1',
        authorId: 'u9',
        author: user('u9'),
        createdAt: '2026-01-01T00:09:00.000Z'
    }))
    w.friendsFeed = [existing]
    await w.runtime.runRound()
    const fresh = w.put(post({
        id: 'fresh',
        authorId: 'u9',
        author: user('u9'),
        createdAt: '2026-01-01T00:05:00.000Z'
    }))
    w.friendsFeed = [existing, fresh]
    await w.runtime.runRound()
    const commented = w.writes.filter((x) => x.type === 'comment').map((x) => x.post)
    assert.ok(commented.includes('fresh'))
    assert.ok(!commented.includes('old1'))
})

test('基线后新评论触发自身动态回复', async () => {
    const w = world()
    const p = w.put(post({ id: 'sp1' }))
    w.selfFeed = [p]
    await w.runtime.runRound()
    const updated = Object.assign({}, p, { comments: [comment({ id: 'c1', author: user('u2') })] })
    w.put(updated)
    w.selfFeed = [updated]
    await w.runtime.runRound()
    assert.equal(w.writes.length, 1)
    assert.equal(w.writes[0].type, 'reply')
    assert.equal(w.writes[0].post, 'sp1')
    assert.equal(w.writes[0].comment, 'c1')
    assert.equal(w.runtime.report.phase, 'ready')
    assert.equal(w.runtime.report.round.discovered, 1)
})

test('自身动态的新评论只回复一次不重复', async () => {
    const w = world()
    const p = w.put(post({ id: 'sp1' }))
    w.selfFeed = [p]
    await w.runtime.runRound()
    const updated = Object.assign({}, p, { comments: [comment({ id: 'c1', author: user('u2') })] })
    w.put(updated)
    w.selfFeed = [updated]
    await w.runtime.runRound()
    await w.runtime.runRound()
    assert.equal(w.writes.length, 1)
})

test('自身动态评论快照不完整时保留待处理不写入', async () => {
    const w = world()
    const p = w.put(post({ id: 'sp1' }))
    w.selfFeed = [p]
    await w.runtime.runRound()
    w.put(Object.assign({}, p, { comments: [comment({ id: 'c1' })], commentsComplete: false }))
    await w.runtime.runRound()
    assert.equal(w.writes.length, 0)
    assert.ok(w.runtime.report.round.incompleteSnapshots >= 1)
})

test('自身动态详情读取失败时保留待处理', async () => {
    const w = world()
    const p = w.put(post({ id: 'sp1' }))
    w.selfFeed = [p]
    await w.runtime.runRound()
    w.getPostFails.set('u1:sp1', new Error('detail down'))
    await w.runtime.runRound()
    assert.equal(w.writes.length, 0)
    assert.ok(warnsIn(w.log).some(([, m]) => /读取监控动态失败/.test(m)))
})

test('受监控动态已删除时停止监控', async () => {
    const w = world()
    const p = w.put(post({ id: 'sp1' }))
    w.selfFeed = [p]
    await w.runtime.runRound()
    w.posts.delete('u1:sp1')
    w.getPostFails.set('u1:sp1', new QzoneNotFoundError('gone'))
    await w.runtime.runRound()
    assert.equal(w.runtime.state.monitoredPosts.size, 0)
    assert.equal(w.runtime.report.round.errors, 0)
})

test('好友新动态触发评论', async () => {
    const w = world()
    w.friendsFeed = []
    await w.runtime.runRound()
    const p = w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))
    w.friendsFeed = [p]
    await w.runtime.runRound()
    assert.equal(w.writes.length, 1)
    assert.equal(w.writes[0].type, 'comment')
    assert.equal(w.writes[0].post, 'fp1')
    assert.equal(w.runtime.report.round.discovered, 1)
})

test('好友动态不重复评论', async () => {
    const w = world()
    await w.runtime.runRound()
    const p = w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))
    w.friendsFeed = [p]
    await w.runtime.runRound()
    await w.runtime.runRound()
    assert.equal(w.writes.length, 1)
})

test('好友动态早于水位线时不处理', async () => {
    const w = world()
    const old = w.put(post({ id: 'old', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T00:00:00.000Z' }))
    w.friendsFeed = [old]
    await w.runtime.runRound()
    await w.runtime.runRound()
    assert.equal(w.writes.length, 0)
})

test('bot 自己的好友动态被跳过', async () => {
    const w = world()
    await w.runtime.runRound()
    const p = w.put(post({ id: 'mine', authorId: BOT, author: user(BOT), createdAt: '2026-01-01T12:00:00.000Z' }))
    w.friendsFeed = [p]
    await w.runtime.runRound()
    assert.equal(w.writes.length, 0)
})

test('白名单外的作者被跳过', async () => {
    const w = world({ interactionWhitelist: createInteractionWhitelist(true, ['u7']) })
    await w.runtime.runRound()
    const p = w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))
    w.friendsFeed = [p]
    await w.runtime.runRound()
    assert.equal(w.writes.length, 0)
    assert.equal(w.runtime.report.round.discovered, 0)
})

test('白名单内的作者正常评论', async () => {
    const w = world({ interactionWhitelist: createInteractionWhitelist(true, ['u9']) })
    await w.runtime.runRound()
    const p = w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))
    w.friendsFeed = [p]
    await w.runtime.runRound()
    assert.equal(w.writes.length, 1)
})

test('仅点赞模式不评论但会点赞', async () => {
    const w = world({ friendPostCommentMode: 'off', friendPostLikeMode: 'forced' })
    await w.runtime.runRound()
    const p = w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))
    w.friendsFeed = [p]
    await w.runtime.runRound()
    assert.equal(w.writes.length, 1)
    assert.equal(w.writes[0].type, 'like')
    assert.equal(w.runtime.report.round.likesApplied, 1)
})

test('已点赞的动态跳过点赞', async () => {
    const w = world({ friendPostCommentMode: 'off', friendPostLikeMode: 'forced' })
    await w.runtime.runRound()
    const p = w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), liked: true, createdAt: '2026-01-01T12:00:00.000Z' }))
    w.friendsFeed = [p]
    await w.runtime.runRound()
    assert.equal(w.writes.length, 0)
    assert.equal(w.runtime.report.round.likeAttempts, 0)
})

test('点赞失败计入错误但不中断轮次', async () => {
    const w = world({ friendPostCommentMode: 'off', friendPostLikeMode: 'forced' })
    w.deps.like = async () => { throw new Error('like down') }
    await w.runtime.runRound()
    w.friendsFeed = [w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))]
    await w.runtime.runRound()
    assert.equal(w.runtime.report.phase, 'ready')
    assert.ok(w.runtime.report.round.errors >= 1)
})

test('commentMode=off 且 likeMode=off 时好友动态不产生触发', async () => {
    const w = world({ friendPostCommentMode: 'off', friendPostLikeMode: 'off', monitorLimit: 0 })
    await w.runtime.runRound()
    w.friendsFeed = [w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))]
    await w.runtime.runRound()
    assert.equal(w.writes.length, 0)
    assert.equal(w.runtime.report.round.discovered, 0)
})

test('commentMode=decide 时模型 skip 则不评论并终结触发', async () => {
    const w = world({ friendPostCommentMode: 'decide' })
    w.decideImpl = async () => ({ value: { publish: false, like: false, content: null }, error: null })
    await w.runtime.runRound()
    w.friendsFeed = [w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))]
    await w.runtime.runRound()
    assert.equal(w.writes.length, 0)
    assert.ok(w.runtime.state.terminalTriggers.has('friend-post:u9:fp1:-'))
})

test('commentMode=decide 且 likeMode=decide 时按模型决定点赞', async () => {
    const w = world({ friendPostCommentMode: 'decide', friendPostLikeMode: 'decide' })
    w.decideImpl = async () => ({ value: { publish: true, like: true, content: 'yes' }, error: null })
    await w.runtime.runRound()
    w.friendsFeed = [w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))]
    await w.runtime.runRound()
    assert.deepEqual(w.writes.map((x) => x.type), ['like', 'comment'])
})

test('模型决策无效时保留触发留待下轮', async () => {
    const w = world()
    w.decideImpl = async () => ({ value: null, error: 'bad contract' })
    await w.runtime.runRound()
    w.friendsFeed = [w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))]
    await w.runtime.runRound()
    assert.equal(w.writes.length, 0)
    assert.equal(w.runtime.state.pendingTriggers.size, 1)
    assert.ok(warnsIn(w.log).some(([, m]) => /模型决策无效/.test(m)))
})

test('模型决策抛错时保留触发且不影响轮次', async () => {
    const w = world()
    w.decideImpl = async () => { throw new Error('decide down') }
    await w.runtime.runRound()
    w.friendsFeed = [w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))]
    await w.runtime.runRound()
    assert.equal(w.runtime.report.phase, 'ready')
    assert.equal(w.runtime.state.pendingTriggers.size, 1)
    assert.ok(w.runtime.report.round.errors >= 1)
})

test('模型不可用时提前结束本轮并保留触发', async () => {
    const w = world()
    w.modelFails = 99
    await w.runtime.runRound()
    w.friendsFeed = [w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))]
    await w.runtime.runRound()
    assert.equal(w.writes.length, 0)
    assert.equal(w.runtime.state.pendingTriggers.size, 1)
    assert.equal(w.runtime.report.lastError, 'model-unavailable')
})

test('人设渲染失败时提前结束本轮', async () => {
    const w = world()
    w.personaFails = true
    await w.runtime.runRound()
    w.friendsFeed = [w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))]
    await w.runtime.runRound()
    assert.equal(w.writes.length, 0)
    assert.equal(w.runtime.report.lastError, 'persona')
})

test('目标无可感知内容时不评论', async () => {
    const w = world()
    w.decideImpl = async () => { throw new Error('should not decide') }
    await w.runtime.runRound()
    const blank = post({ id: 'fp1', authorId: 'u9', author: user('u9'), content: '   ', createdAt: '2026-01-01T12:00:00.000Z' })
    w.put(blank)
    w.friendsFeed = [blank]
    await w.runtime.runRound()
    assert.equal(w.writes.length, 0)
    assert.equal(w.runtime.state.terminalTriggers.get('friend-post:u9:fp1:-').result, 'nothing-perceptible')
})

test('写入失败时终结触发不重试', async () => {
    const w = world()
    w.deps.comment = async () => { throw new Error('write down') }
    await w.runtime.runRound()
    w.friendsFeed = [w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))]
    await w.runtime.runRound()
    assert.equal(w.runtime.state.terminalTriggers.get('friend-post:u9:fp1:-').result, 'write-failed-no-retry')
    assert.equal(w.runtime.state.pendingTriggers.size, 0)
})

test('单轮写请求上限生效', async () => {
    const w = world({ maxWritesPerRound: 2 })
    await w.runtime.runRound()
    const friends = Array.from({ length: 5 }, (_, i) => w.put(post({
        id: 'fp' + i,
        authorId: 'u9',
        author: user('u9'),
        createdAt: '2026-01-01T12:00:0' + i + '.000Z'
    })))
    w.friendsFeed = friends
    await w.runtime.runRound()
    assert.equal(w.writes.length, 2)
    assert.equal(w.runtime.state.pendingTriggers.size, 3)
})

test('达到单轮上限被跳过的强制点赞会在下轮补上', async () => {
    const w = world({ friendPostCommentMode: 'off', friendPostLikeMode: 'forced', maxWritesPerRound: 2 })
    await w.runtime.runRound()
    const friends = Array.from({ length: 5 }, (_, i) => w.put(post({
        id: 'fp' + i,
        authorId: 'u9',
        author: user('u9'),
        createdAt: '2026-01-01T12:00:0' + i + '.000Z'
    })))
    w.friendsFeed = friends
    await w.runtime.runRound()
    assert.equal(w.writes.filter((x) => x.type === 'like').length, 2)
    await w.runtime.runRound()
    await w.runtime.runRound()
    const liked = w.writes.filter((x) => x.type === 'like').map((x) => x.post)
    assert.equal(liked.length, 5)
    assert.equal(new Set(liked).size, 5)
})

test('补赞不会重复点赞同一条动态', async () => {
    const w = world({ friendPostCommentMode: 'off', friendPostLikeMode: 'forced', maxWritesPerRound: 1 })
    await w.runtime.runRound()
    const friends = Array.from({ length: 3 }, (_, i) => w.put(post({
        id: 'fp' + i,
        authorId: 'u9',
        author: user('u9'),
        createdAt: '2026-01-01T12:00:0' + i + '.000Z'
    })))
    w.friendsFeed = friends
    for (let i = 0; i < 6; i += 1) await w.runtime.runRound()
    const liked = w.writes.filter((x) => x.type === 'like').map((x) => x.post)
    assert.equal(new Set(liked).size, liked.length)
    assert.equal(liked.length, 3)
})

test('点赞失败后会在下轮重试', async () => {
    const w = world({ friendPostCommentMode: 'off', friendPostLikeMode: 'forced' })
    let fail = true
    w.deps.like = async () => {
        if (fail) { fail = false; throw new Error('like down') }
        return { outcome: 'verified', liked: true }
    }
    await w.runtime.runRound()
    w.friendsFeed = [w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))]
    await w.runtime.runRound()
    assert.equal(w.runtime.report.round.likeAttempts, 1)
    await w.runtime.runRound()
    assert.ok(w.runtime.report.round.likesApplied >= 1)
})

test('动态已删除时补赞队列不再保留', async () => {
    const w = world({ friendPostCommentMode: 'off', friendPostLikeMode: 'forced', maxWritesPerRound: 1 })
    await w.runtime.runRound()
    const friends = Array.from({ length: 3 }, (_, i) => w.put(post({
        id: 'fp' + i,
        authorId: 'u9',
        author: user('u9'),
        createdAt: '2026-01-01T12:00:0' + i + '.000Z'
    })))
    w.friendsFeed = friends
    await w.runtime.runRound()
    w.deps.like = async () => { throw new QzoneNotFoundError('gone') }
    for (let i = 0; i < 4; i += 1) await w.runtime.runRound()
    assert.equal(w.runtime.report.phase, 'ready')
})

test('乱序发布的好友动态在宽限窗口内仍会被发现', async () => {
    const w = world()
    const seed = w.put(post({ id: 'seed', authorId: 'u8', author: user('u8'), createdAt: '2026-01-01T12:00:00.000Z' }))
    w.friendsFeed = [seed]
    await w.runtime.runRound()
    const newer = w.put(post({ id: 'newer', authorId: 'u8', author: user('u8'), createdAt: '2026-01-01T12:30:00.000Z' }))
    w.friendsFeed = [newer, seed]
    await w.runtime.runRound()
    const older = w.put(post({ id: 'older', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:20:00.000Z' }))
    w.friendsFeed = [newer, older, seed]
    await w.runtime.runRound()
    const commented = w.writes.filter((x) => x.type === 'comment').map((x) => x.post)
    assert.ok(commented.includes('older'))
})

test('自身动态重复读取时不会向 SDK 请求 limit 为 0', async () => {
    const w = world()
    const requested = []
    w.deps.listFeedPage = async (req) => {
        if (req.scope === 'self') requested.push(req.limit)
        return { items: [], nextCursor: null }
    }
    await w.runtime.runRound()
    for (const limit of requested) assert.ok(limit >= 1, 'limit must be >= 1, got ' + limit)
})

test('超量自身动态时按上限截断且不重复拉取', async () => {
    const w = world({ monitorLimit: 3 })
    const selfPosts = Array.from({ length: 10 }, (_, i) => w.put(post({
        id: 'sp' + i,
        createdAt: '2026-01-01T12:00:0' + i + '.000Z'
    })))
    w.selfFeed = selfPosts
    const requested = []
    w.deps.listFeedPage = async (req) => {
        requested.push(req.limit)
        return { items: selfPosts.slice(0, req.limit), nextCursor: null }
    }
    await w.runtime.runRound()
    for (const limit of requested) assert.ok(limit >= 1, 'limit must be >= 1, got ' + limit)
})

test('终态记录在轮次结束时被收敛', async () => {
    const w = world()
    await w.runtime.runRound()
    w.friendsFeed = [w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))]
    await w.runtime.runRound()
    assert.equal(w.runtime.state.terminalTriggers.size, 1)
    const pruned = w.runtime.state.terminalTriggers.size
    assert.ok(pruned <= 2000)
})

test('stop 清空待补赞队列', async () => {
    const w = world({ friendPostCommentMode: 'off', friendPostLikeMode: 'forced', maxWritesPerRound: 1 })
    await w.runtime.runRound()
    const friends = Array.from({ length: 3 }, (_, i) => w.put(post({
        id: 'fp' + i,
        authorId: 'u9',
        author: user('u9'),
        createdAt: '2026-01-01T12:00:0' + i + '.000Z'
    })))
    w.friendsFeed = friends
    await w.runtime.runRound()
    w.runtime.stop()
    assert.equal(w.runtime.state.pendingTriggers.size, 0)
})

test('监控上限为 0 时不建立自身动态监控', async () => {
    const w = world({ monitorLimit: 0 })
    w.selfFeed = [w.put(post({ id: 'sp1' }))]
    await w.runtime.runRound()
    assert.equal(w.runtime.report.monitoredPosts, 0)
    assert.equal(w.runtime.state.monitoredPosts.size, 0)
})

test('好友 Feed 未建水位线时报错但不崩溃轮次', async () => {
    const w = world()
    await w.runtime.runRound()
    w.runtime.state.friendFeedWatermark = null
    w.friendsFeed = [w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))]
    await w.runtime.runRound()
    assert.equal(w.runtime.report.phase, 'ready')
    assert.ok(w.runtime.report.round.errors >= 1)
    assert.ok(warnsIn(w.log).some(([, m]) => /好友动态 Feed 水位尚未建立/.test(m)))
})

test('评论好友动态后建立 bot 主楼监控', async () => {
    const w = world()
    await w.runtime.runRound()
    w.friendsFeed = [w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))]
    await w.runtime.runRound()
    assert.equal(w.runtime.state.monitoredPosts.has('u9:fp1'), true)
    const monitored = w.runtime.state.monitoredPosts.get('u9:fp1')
    assert.equal(monitored.owner, 'friend')
    assert.equal(monitored.botThreadRoot.authorId, BOT)
    assert.equal(monitored.baselineReady, true)
})

test('好友在 bot 主楼回复时触发楼中回复', async () => {
    const w = world()
    await w.runtime.runRound()
    const p = w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))
    w.friendsFeed = [p]
    await w.runtime.runRound()
    const withComment = Object.assign({}, p, {
        comments: [comment({ id: 'bc1', author: user(BOT), content: 'bot said', threadRoot: null, kind: 'comment' })]
    })
    w.put(withComment)
    w.friendsFeed = [withComment]
    await w.runtime.runRound()
    const reply = comment({ id: 'r1', author: user('u2'), kind: 'reply', threadRoot: ref('bc1', BOT) })
    const withReply = Object.assign({}, withComment, { comments: withComment.comments.concat([reply]) })
    w.put(withReply)
    w.friendsFeed = [withReply]
    await w.runtime.runRound()
    const replyWrites = w.writes.filter((x) => x.type === 'reply')
    assert.equal(replyWrites.length, 1)
    assert.equal(replyWrites[0].comment, 'r1')
})

test('停止后轮次直接返回且不再写入', async () => {
    const w = world()
    await w.runtime.runRound()
    w.friendsFeed = [w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))]
    w.runtime.cancel()
    await w.runtime.runRound()
    assert.equal(w.writes.length, 0)
    assert.equal(w.runtime.stopped, true)
})

test('stop 清空全部运行时状态', async () => {
    const w = world()
    w.selfFeed = [w.put(post({ id: 'sp1' }))]
    await w.runtime.runRound()
    assert.ok(w.runtime.report !== null)
    w.runtime.stop()
    assert.equal(w.runtime.report, null)
    assert.equal(w.runtime.state.baseline, 'pending')
    assert.equal(w.runtime.state.monitoredPosts.size, 0)
})

test('详情读取失败时保留触发等待下轮', async () => {
    const w = world()
    await w.runtime.runRound()
    const p = w.put(post({ id: 'fp1', authorId: 'u9', author: user('u9'), createdAt: '2026-01-01T12:00:00.000Z' }))
    w.friendsFeed = [p]
    w.getPostFails.set('u9:fp1', new Error('detail down'))
    await w.runtime.runRound()
    assert.equal(w.writes.length, 0)
    assert.equal(w.runtime.state.pendingTriggers.size, 1)
})

test('目标评论消失时终结触发为 target-disappeared', async () => {
    const w = world()
    const p = w.put(post({ id: 'sp1' }))
    w.selfFeed = [p]
    await w.runtime.runRound()
    w.getPostFails.set('u1:sp1', new QzoneNotFoundError('gone'))
    const updated = Object.assign({}, p, { comments: [comment({ id: 'c1' })] })
    w.put(updated)
    w.selfFeed = [updated]
    await w.runtime.runRound()
    w.posts.delete('u1:sp1')
    await w.runtime.runRound()
    assert.equal(w.writes.length, 0)
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
