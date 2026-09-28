import type { ChatLunaChatModel } from '../chatluna'
import { QzoneNotFoundError } from 'qzone-sdk'
import type {
    CommentMutationResult,
    CommentOptions,
    FeedPage,
    GetPostOptions,
    LikeMutationResult,
    LikeOptions,
    QzonePost,
    ReplyOptions
} from 'qzone-sdk'
import type {
    InteractionDecisionDeps,
    InteractionDecisionOutcome
} from './agent'
import type { DecisionPolicy } from './decision'
import { buildInteractionPrompt } from './prompt'
import { isCommentInBotThread } from './state'
import { declaresImageInput, type PreparedInteractionMedia } from './media'
import {
    advanceFriendFeedWatermark,
    baselineMonitoredPost,
    createFriendFeedWatermark,
    createFriendPostTrigger,
    createInteractionRuntimeState,
    createMonitoredPost,
    discoverCommentTriggers,
    enqueueTrigger,
    findCommentByKey,
    type FriendFeedWatermark,
    type InteractionRuntimeState,
    isPostBeforeWatermark,
    isPostAfterWatermark,
    type MonitoredPost,
    type PendingTrigger,
    postKey,
    pruneTerminalTriggers,
    raiseFriendFeedWatermark,
    removeMonitoredPost,
    sortPendingTriggers,
    terminalizeTrigger,
    trimMonitoredPosts
} from './state'
import { mapWithConcurrency } from './concurrency'
import { describeError, safeStringify } from './errors'
import type { AutoInteractionDeps, AutoInteractionOptions } from './types'
import { isUserAllowed } from './types'
export type { AutoInteractionDeps, AutoInteractionOptions } from './types'
import {
    emptyRoundStats,
    type InteractionErrorKind,
    type InteractionPhase,
    type InteractionReport,
    type InteractionRoundStats
} from './report'
import { QzoneWriteAuthError } from '../qzone/manager'
import { type LivingDiaryLogger } from '../logging'

export const FRIEND_FEED_PAGE_LIMIT = 6
const FEED_PAGE_SIZE = 20
const MAX_PENDING_LIKES = 200
const KNOWN_SELF_POST_MINIMUM = 64


const postTimestamp = (post: QzonePost, fallback: number): number => {
    if (post.createdAt === null) return fallback
    const parsed = Date.parse(post.createdAt)
    return Number.isFinite(parsed) ? parsed : fallback
}

const mutableRoundStats = (): {
    -readonly [Key in keyof InteractionRoundStats]: InteractionRoundStats[Key]
} => ({ ...emptyRoundStats() })


export class AutoInteractionRuntime {
    private currentReport: InteractionReport | null = null

    get report(): InteractionReport | null {
        return this.currentReport
    }

    state: InteractionRuntimeState = createInteractionRuntimeState()
    readonly #deps: AutoInteractionDeps
    readonly #options: AutoInteractionOptions
    readonly #controller = new AbortController()
    readonly #knownSelfPosts = new Set<string>()
    readonly #pendingLikes = new Map<string, QzonePost>()
    #friendFeedCursor: string | undefined
    #friendFeedCandidateWatermark: FriendFeedWatermark | null = null
    #botId: string | null = null
    #roundStartedAt: string | null = null
    #lastRoundAt: string | null = null
    #lastRound: InteractionRoundStats | null = null
    #lastError: InteractionErrorKind | null = null

    constructor(deps: AutoInteractionDeps, options: AutoInteractionOptions) {
        this.#deps = deps
        this.#options = options
    }

    get stopped(): boolean {
        return this.#controller.signal.aborted
    }

    cancel(): void {
        this.#controller.abort()
    }

    stop(): void {
        this.cancel()
        this.state = createInteractionRuntimeState()
        this.#knownSelfPosts.clear()
        this.#pendingLikes.clear()
        this.#friendFeedCursor = undefined
        this.#friendFeedCandidateWatermark = null
        this.#botId = null
        this.#roundStartedAt = null
        this.#lastRoundAt = null
        this.#lastRound = null
        this.#lastError = null
        this.currentReport = null
    }

    async runRound(): Promise<void> {
        if (this.stopped) return
        if (this.state.baseline !== 'ready' && !this.#deps.isBotOnline()) {
            this.#lastError = null
            this.#setReport('waiting-bot', '所选机器人上线后自动建立基线')
            this.#debug('wait-bot', '机器人未上线，等待中')
            return
        }
        if (this.state.baseline !== 'ready') {
            this.#debug('baseline-start', '开始建立启动基线')
            await this.establishBaseline()
            return
        }
        const stats = mutableRoundStats()
        this.#roundStartedAt = this.#deps.now().toISOString()
        this.#lastError = null
        this.#setReport('running', '正在轮询', stats)
        this.#debug('round-start', '轮次开始', {
            monitorLimit: this.#options.monitorLimit,
            maxWritesPerRound: this.#options.maxWritesPerRound,
            friendPostCommentMode: this.#options.friendPostCommentMode,
            friendPostLikeMode: this.#options.friendPostLikeMode,
            interactionWhitelistEnabled:
                this.#options.interactionWhitelist.enabled,
            interactionWhitelistSize:
                this.#options.interactionWhitelist.allowed.size,
            monitoredPosts: this.state.monitoredPosts.size,
            pendingTriggers: this.state.pendingTriggers.size,
            terminalTriggers: this.state.terminalTriggers.size,
            friendWatermark: this.state.friendFeedWatermark?.timestamp ?? null
        })
        try {
            await this.#stage('monitored-read', stats, () =>
                this.#discoverMonitoredComments(stats)
            )
            await this.#stage('round-read', stats, () =>
                this.#discoverSelfPosts(stats)
            )
            await this.#stage('round-read', stats, () =>
                this.#drainPendingLikes(stats)
            )
            await this.#stage('round-read', stats, () =>
                this.#discoverFriendPosts(stats)
            )
            trimMonitoredPosts(this.state, this.#options.monitorLimit)
            await this.#stage('model-decision', stats, () =>
                this.#processPending(stats)
            )
            if (this.stopped) return
            const pruned = pruneTerminalTriggers(
                this.state,
                this.#deps.now().getTime()
            )
            if (pruned.expired > 0 || pruned.overflow > 0) {
                this.#debug(
                    'state-pruned',
                    '已收敛历史终态记录',
                    pruned
                )
            }
            this.#lastRoundAt = this.#deps.now().toISOString()
            this.#lastRound = { ...stats }
            this.#setReport('ready', '等待下一轮')
            this.#debug('round-end', '轮次结束', {
                stats,
                lastError: this.#lastError,
                monitoredPosts: this.state.monitoredPosts.size,
                pendingTriggers: this.state.pendingTriggers.size
            })
            const idleRound =
                stats.discovered === 0 &&
                stats.writeAttempts === 0 &&
                stats.incompleteSnapshots === 0 &&
                stats.errors === 0
            const roundSummary =
                '自动互动轮次完成：' +
                `发现 ${stats.discovered}，写入 ${stats.writeAttempts}，` +
                `不完整快照 ${stats.incompleteSnapshots}，错误 ${stats.errors}`
            if (idleRound) {
                this.#deps.logger.debug(roundSummary)
            } else {
                this.#deps.logger.info(roundSummary)
            }
            if (stats.incompleteSnapshots > 0) {
                this.#deps.logger.warn(
                    '自动互动：本轮存在评论快照不完整，' +
                        '相关触发已保留等待后续轮询'
                )
            }
        } catch (error) {
            if (this.stopped) return
            this.#recordError('round-read', stats)
            this.#lastRoundAt = this.#deps.now().toISOString()
            this.#lastRound = { ...stats }
            this.#setReport('failed', '轮询失败')
            this.#deps.logger.error(
                '自动互动轮次失败：读取或编排阶段异常 ' + describeError(error)
            )
        }
    }

    async establishBaseline(): Promise<void> {
        if (this.stopped) return
        this.#setReport('baselining', '正在读取当前动态与评论基线')
        const next = createInteractionRuntimeState()
        const nextKnownSelf = new Set<string>()
        try {
            const now = this.#deps.now().getTime()
            if (this.#options.monitorLimit > 0) {
                const selfPosts = await this.#readLatestSelfPosts(
                    this.#options.monitorLimit
                )
                for (const post of selfPosts) nextKnownSelf.add(postKey(post))
                const details = await mapWithConcurrency(
                    selfPosts,
                    (post) =>
                        this.#deps.getPost({
                            post,
                            signal: this.#controller.signal
                        })
                )
                details.forEach((outcome, index) => {
                    if (!outcome.ok) {
                        this.#deps.logger.warn(
                            `自动互动基线：读取自身动态详情失败` +
                                `（post=${selfPosts[index].id}）` +
                                describeError(outcome.error)
                        )
                        return
                    }
                    const detail = outcome.value!
                    const monitored = createMonitoredPost(
                        detail,
                        'self',
                        postTimestamp(detail, now),
                        false
                    )
                    baselineMonitoredPost(monitored, detail, now)
                    next.monitoredPosts.set(monitored.key, monitored)
                })
                trimMonitoredPosts(next, this.#options.monitorLimit)
            }
            if (
                this.#options.friendPostCommentMode !== 'off' ||
                this.#options.friendPostLikeMode !== 'off'
            ) {
                const friendBaselineAt = this.#deps.now().getTime()
                const page = await this.#deps.listFeedPage({
                    scope: 'friends',
                    limit: FEED_PAGE_SIZE,
                    signal: this.#controller.signal
                })
                next.friendFeedWatermark = createFriendFeedWatermark(
                    page.items,
                    friendBaselineAt
                )
            }
            const botId = this.#deps.getAccountId()
            if (!botId) {
                throw new Error('QQ 空间 Session 未提供当前账号 ID')
            }
            next.baseline = 'ready'
            next.baselineCompletedAt = this.#deps.now().getTime()
            for (const monitored of next.monitoredPosts.values()) {
                monitored.ignoreCommentsThrough = next.baselineCompletedAt
                monitored.baselineObservationPending = true
            }
            if (
                next.friendFeedWatermark !== null &&
                next.friendFeedWatermark.timestamp < next.baselineCompletedAt
            ) {
                next.friendFeedWatermark = raiseFriendFeedWatermark(
                    next.friendFeedWatermark,
                    next.baselineCompletedAt
                )
            }
            if (this.stopped) return
            this.state = next
            this.#botId = botId
            this.#knownSelfPosts.clear()
            this.#friendFeedCursor = undefined
            this.#friendFeedCandidateWatermark = null
            for (const key of nextKnownSelf) this.#knownSelfPosts.add(key)
            this.#trimKnownSelfPosts()
            this.#lastError = null
            this.#setReport('ready', '启动基线已建立')
            this.#deps.logger.info('自动互动：启动基线已建立')
            this.#debug('baseline-done', '启动基线已建立', {
                botId,
                monitorLimit: this.#options.monitorLimit,
                monitored: [...next.monitoredPosts.values()].map((post) => ({
                    key: post.key,
                    owner: post.owner,
                    activityAt: post.activityAt,
                    seenComments: post.seenComments.size
                })),
                friendWatermark: next.friendFeedWatermark?.timestamp ?? null,
                baselineCompletedAt: next.baselineCompletedAt,
                note: '基线完成前已存在的动态与评论不会被补扫，请在本条之后再发布内容'
            })
        } catch (error) {
            if (this.stopped) return
            this.#lastError = 'baseline'
            this.#setReport('failed', '启动基线建立失败')
            this.#deps.logger.error(
                '自动互动基线失败：' + describeError(error)
            )
            throw error
        }
    }

    async #readLatestSelfPosts(limit: number): Promise<readonly QzonePost[]> {
        const posts: QzonePost[] = []
        let cursor: string | undefined
        const pageLimit = Math.ceil(limit / FEED_PAGE_SIZE)
        for (let pageIndex = 0; pageIndex < pageLimit; pageIndex++) {
            if (posts.length >= limit) break
            const page = await this.#deps.listFeedPage({
                scope: 'self',
                limit: Math.min(FEED_PAGE_SIZE, limit - posts.length),
                ...(cursor ? { cursor } : {}),
                signal: this.#controller.signal
            })
            for (const post of page.items) {
                if (!posts.some((item) => postKey(item) === postKey(post))) {
                    posts.push(post)
                }
            }
            if (!page.nextCursor || page.items.length === 0) break
            cursor = page.nextCursor
        }
        return posts.slice(0, limit)
    }

    async #discoverMonitoredComments(
        stats: ReturnType<typeof mutableRoundStats>
    ): Promise<void> {
        if (this.#options.monitorLimit === 0 || !this.#botId) return
        const monitoredPosts = [...this.state.monitoredPosts.values()]
        if (monitoredPosts.length === 0) return
        const botId = this.#botId
        const details = await mapWithConcurrency(monitoredPosts, (monitored) =>
            this.#deps.getPost({
                    post: monitored.post,
                    signal: this.#controller.signal
            })
        )
        if (this.stopped) return
        details.forEach((outcome, index) => {
            const monitored = monitoredPosts[index]
            if (!outcome.ok) {
                const error = outcome.error
                if (error instanceof QzoneNotFoundError) {
                    removeMonitoredPost(this.state, monitored.key)
                    this.#deps.logger.debug(
                        '自动互动：受监控动态已不存在，已停止监控'
                    )
                    return
                }
                this.#recordError('monitored-read', stats)
                this.#deps.logger.warn(
                    `自动互动：读取监控动态失败（post=${monitored.post.id}）` +
                        describeError(error)
                )
                return
            }
            const detail = outcome.value!
            if (!detail.commentsComplete) {
                stats.incompleteSnapshots += 1
                return
            }
            for (const trigger of discoverCommentTriggers(monitored, detail, {
                botId,
                detectedAt: this.#deps.now().getTime()
            })) {
                if (enqueueTrigger(this.state, trigger)) stats.discovered += 1
            }
        })
    }

    async #discoverSelfPosts(
        stats: ReturnType<typeof mutableRoundStats>
    ): Promise<void> {
        if (this.#options.monitorLimit === 0 || !this.#botId) return
        const posts = await this.#readLatestSelfPosts(
            this.#options.monitorLimit
        )
        const baselineAt =
            this.state.baselineCompletedAt ?? Number.MAX_SAFE_INTEGER
        const botId = this.#botId
        const candidates: MonitoredPost[] = []
        for (const post of posts) {
            const key = postKey(post)
            if (this.#knownSelfPosts.has(key)) continue
            this.#knownSelfPosts.add(key)
            if (postTimestamp(post, 0) <= baselineAt) continue
            const monitored = createMonitoredPost(
                post,
                'self',
                postTimestamp(post, this.#deps.now().getTime()),
                true
            )
            this.state.monitoredPosts.set(key, monitored)
            candidates.push(monitored)
        }
        this.#trimKnownSelfPosts()
        if (candidates.length === 0) return
        const details = await mapWithConcurrency(candidates, (monitored) =>
            this.#deps.getPost({
                post: monitored.post,
                signal: this.#controller.signal
            })
        )
        if (this.stopped) return
        details.forEach((outcome, index) => {
            const monitored = candidates[index]
            if (!outcome.ok) {
                this.#recordError('round-read', stats)
                this.#deps.logger.warn(
                    `自动互动：读取自身动态详情失败` +
                        `（post=${monitored.post.id}）` +
                        describeError(outcome.error)
                )
                return
            }
            const detail = outcome.value!
            if (!detail.commentsComplete) {
                stats.incompleteSnapshots += 1
                return
            }
            for (const trigger of discoverCommentTriggers(monitored, detail, {
                botId,
                detectedAt: this.#deps.now().getTime()
            })) {
                if (enqueueTrigger(this.state, trigger)) stats.discovered += 1
            }
        })
    }

    async #discoverFriendPosts(
        stats: ReturnType<typeof mutableRoundStats>
    ): Promise<void> {
        const commentMode = this.#options.friendPostCommentMode
        const likeMode = this.#options.friendPostLikeMode
        const wantTrigger = commentMode !== 'off' || likeMode === 'decide'
        if (!wantTrigger && likeMode !== 'forced') return
        const watermark = this.state.friendFeedWatermark
        if (!watermark) throw new Error('好友动态 Feed 水位尚未建立')
        let cursor = this.#friendFeedCursor
        let candidate = this.#friendFeedCandidateWatermark ?? watermark
        for (let round = 0; round < FRIEND_FEED_PAGE_LIMIT; round++) {
            const page = await this.#deps.listFeedPage({
                scope: 'friends',
                limit: FEED_PAGE_SIZE,
                ...(cursor ? { cursor } : {}),
                signal: this.#controller.signal
            })
            candidate = advanceFriendFeedWatermark(candidate, page.items)
            for (const post of page.items) {
                if (!isPostAfterWatermark(post, watermark)) {
                    this.#debug(
                        'post-before-watermark',
                        `动态早于水位线，不处理（post=${post.id}）`,
                        {
                            createdAt: post.createdAt,
                            author: post.author.nickname,
                            authorId: post.author.id,
                            content: post.content
                        }
                    )
                    continue
                }
                if (this.#botId !== null && post.author.id === this.#botId) {
                    this.#debug(
                        'skip-own-post',
                        `跳过 bot 自己的动态（post=${post.id}）`
                    )
                    continue
                }
                if (
                    !isUserAllowed(
                        this.#options.interactionWhitelist,
                        post.author.id
                    )
                ) {
                    this.#debug(
                        'skip-not-whitelisted',
                        `不在互动白名单，跳过（post=${post.id}）`,
                        { authorId: post.author.id }
                    )
                    continue
                }
                if (likeMode === 'forced') {
                    await this.#likeDiscoveredPost(post, stats, 'forced')
                    if (this.stopped) return
                }
                if (!wantTrigger) continue
                const enqueued = enqueueTrigger(
                    this.state,
                    createFriendPostTrigger(post, this.#deps.now().getTime())
                )
                this.#debug(
                    enqueued ? 'post-discovered' : 'post-duplicate',
                    enqueued
                        ? `发现好友新动态（post=${post.id}）`
                        : `好友动态已入队，忽略重复（post=${post.id}）`,
                    {
                        createdAt: post.createdAt,
                        author: post.author.nickname,
                        authorId: post.author.id,
                        content: post.content,
                        media: post.media?.length ?? 0
                    }
                )
                if (enqueued) {
                    stats.discovered += 1
                }
            }
            const reachedOld = page.items.some((post) => {
                return isPostBeforeWatermark(post, watermark)
            })
            if (reachedOld || !page.nextCursor || page.items.length === 0) {
                this.state.friendFeedWatermark = candidate
                this.#friendFeedCursor = undefined
                this.#friendFeedCandidateWatermark = null
                return
            }
            cursor = page.nextCursor
            if (round === FRIEND_FEED_PAGE_LIMIT - 1) {
                this.#friendFeedCursor = cursor
                this.#friendFeedCandidateWatermark = candidate
                stats.feedPageLimitHits += 1
                this.#deps.logger.warn(
                    '自动互动：好友 Feed 扫描达到 6 页保护上限'
                )
                return
            }
        }
    }

    async #likeDiscoveredPost(
        post: QzonePost,
        stats: ReturnType<typeof mutableRoundStats>,
        source: 'forced' | 'model' | 'retry'
    ): Promise<void> {
        const key = postKey(post)
        if (post.liked) {
            this.#debug(
                'like-skipped',
                `动态已处于点赞态，跳过（post=${post.id}）`
            )
            this.#pendingLikes.delete(key)
            return
        }
        if (
            stats.writeAttempts + stats.likeAttempts >=
            this.#options.maxWritesPerRound
        ) {
            this.#debug(
                'like-capped',
                `已达单轮写请求上限，跳过点赞（post=${post.id}）`
            )
            this.#enqueuePendingLike(post)
            return
        }
        stats.likeAttempts += 1
        try {
            const result = await this.#deps.like({
                post,
                signal: this.#controller.signal
            })
            if (this.stopped) return
            this.#pendingLikes.delete(key)
            if (result.outcome === 'already-applied') {
                stats.likeAlreadyApplied += 1
            } else {
                stats.likesApplied += 1
            }
            this.#debug('like-result', `点赞完成 outcome=${result.outcome}`, {
                post: post.id,
                source,
                outcome: result.outcome,
                liked: result.liked,
                note:
                    result.outcome === 'unknown'
                        ? '结果不确定，插件不会自动重发'
                        : undefined
            })
        } catch (error) {
            if (this.stopped) return
            this.#debug('like-failed', `点赞失败（post=${post.id}）`, {
                source,
                error: describeError(error),
                authFailure: error instanceof QzoneWriteAuthError
            })
            if (error instanceof QzoneNotFoundError) {
                this.#pendingLikes.delete(key)
            } else {
                this.#enqueuePendingLike(post)
            }
            this.#recordError(
                error instanceof QzoneWriteAuthError ? 'write-auth' : 'write',
                stats
            )
        }
    }

    #enqueuePendingLike(post: QzonePost): void {
        const key = postKey(post)
        if (this.#pendingLikes.has(key)) return
        this.#pendingLikes.set(key, post)
        while (this.#pendingLikes.size > MAX_PENDING_LIKES) {
            const oldest = this.#pendingLikes.keys().next()
            if (oldest.done) break
            this.#pendingLikes.delete(oldest.value)
        }
    }

    #trimKnownSelfPosts(): void {
        const limit = Math.max(
            KNOWN_SELF_POST_MINIMUM,
            this.#options.monitorLimit * 4
        )
        while (this.#knownSelfPosts.size > limit) {
            const oldest = this.#knownSelfPosts.values().next()
            if (oldest.done) break
            this.#knownSelfPosts.delete(oldest.value)
        }
    }

    async #drainPendingLikes(
        stats: ReturnType<typeof mutableRoundStats>
    ): Promise<void> {
        if (this.#pendingLikes.size === 0) return
        for (const [key, post] of [...this.#pendingLikes]) {
            if (this.stopped) return
            if (!this.#pendingLikes.has(key)) continue
            if (
                stats.writeAttempts + stats.likeAttempts >=
                this.#options.maxWritesPerRound
            ) {
                return
            }
            this.#pendingLikes.delete(key)
            await this.#likeDiscoveredPost(post, stats, 'retry')
        }
    }

    async #processPending(
        stats: ReturnType<typeof mutableRoundStats>
    ): Promise<void> {
        const blockedPosts = new Set<string>()
        let model: ChatLunaChatModel | null = null
        let persona: string | null = null
        for (const trigger of sortPendingTriggers(
            this.state.pendingTriggers.values()
        )) {
            if (this.stopped) return
            if (
                stats.writeAttempts + stats.likeAttempts >=
                this.#options.maxWritesPerRound
            ) {
                return
            }
            if (!this.state.pendingTriggers.has(trigger.key)) continue
            if (blockedPosts.has(postKey(trigger.post))) continue
            this.#debug('trigger-start', `开始处理触发（${trigger.kind}）`, {
                post: trigger.post.id,
                actorId: trigger.actorId,
                commentKey: trigger.commentKey,
                occurredAt: trigger.occurredAt,
                detectedAt: trigger.detectedAt
            })
            let detail: QzonePost
            try {
                detail = await this.#deps.getPost({
                    post: trigger.post,
                    signal: this.#controller.signal
                })
            } catch (error) {
                if (this.stopped) return
                this.#debug(
                    'detail-failed',
                    `读取动态详情失败（post=${trigger.post.id}）`,
                    (error as Error).message
                )
                this.#recordError('detail-refresh', stats)
                continue
            }
            if (!detail.commentsComplete) {
                this.#debug(
                    'snapshot-incomplete',
                    `评论快照不完整，保留待处理（post=${trigger.post.id}）`
                )
                stats.incompleteSnapshots += 1
                blockedPosts.add(postKey(trigger.post))
                continue
            }
            const activeComment =
                trigger.commentKey === null
                    ? null
                    : findCommentByKey(detail, trigger.commentKey)
            if (trigger.commentKey !== null && activeComment === null) {
                this.#debug(
                    'target-gone',
                    `目标评论已不存在（post=${trigger.post.id}）`
                )
                terminalizeTrigger(
                    this.state,
                    trigger.key,
                    'target-disappeared',
                    this.#deps.now().getTime()
                )
                continue
            }
            const actorId = activeComment?.author.id ?? detail.author.id
            if (actorId === this.#botId) {
                this.#debug(
                    'skip-self',
                    `跳过 bot 自己的动态或评论（author=${actorId}）`
                )
                terminalizeTrigger(
                    this.state,
                    trigger.key,
                    'authorization-revoked',
                    this.#deps.now().getTime()
                )
                continue
            }
            if (
                !isUserAllowed(this.#options.interactionWhitelist, actorId)
            ) {
                this.#debug(
                    'skip-not-whitelisted',
                    `互动对象不在白名单，跳过（post=${trigger.post.id}）`,
                    { actorId, kind: trigger.kind }
                )
                terminalizeTrigger(
                    this.state,
                    trigger.key,
                    'not-whitelisted',
                    this.#deps.now().getTime()
                )
                continue
            }
            if (trigger.kind === 'friend-thread-reply') {
                const monitored = this.state.monitoredPosts.get(
                    postKey(trigger.post)
                )
                if (
                    !activeComment ||
                    !monitored?.botThreadRoot ||
                    !isCommentInBotThread(
                        activeComment,
                        monitored.botThreadRoot
                    )
                ) {
                    terminalizeTrigger(
                        this.state,
                        trigger.key,
                        'authorization-revoked',
                        this.#deps.now().getTime()
                    )
                    continue
                }
            }
            if (model === null) {
                try {
                    model = await this.#deps.resolveModel(
                        this.#options.modelRef
                    )
                } catch (error) {
                    this.#debug(
                        'model-failed',
                        '模型创建失败',
                        (error as Error).message
                    )
                    this.#recordError('model-unavailable', stats)
                    return
                }
                if (model === null) {
                    this.#debug(
                        'model-null',
                        `模型不可用（modelRef=${this.#options.modelRef}）`
                    )
                    this.#recordError('model-unavailable', stats)
                    return
                }
                this.#debug('model-ready', '模型已就绪', {
                    modelRef: this.#options.modelRef,
                    modelName: model.modelName,
                    capabilities: model.modelInfo?.capabilities ?? null,
                    declaresImageInput: declaresImageInput(model),
                    fileHandlingMimeTypes: [
                        ...(model.fileHandlingConfig?.supportedMimeTypes ?? [])
                    ]
                })
            }
            if (persona === null) {
                try {
                    persona = await this.#deps.renderPersona(
                        this.#options.presetId
                    )
                } catch (error) {
                    this.#debug(
                        'persona-failed',
                        '人设渲染失败',
                        (error as Error).message
                    )
                    this.#recordError('persona', stats)
                    return
                }
            }
            const media = await this.#deps.prepareMedia(
                detail.media,
                model,
                this.#deps.canDescribeMedia(),
                this.#controller.signal
            )
            if (this.stopped) return
            this.#debug('media-ready', '媒体准备完成', {
                sourceMedia: detail.media?.length ?? 0,
                attached: media.imageParts.length,
                described: [...media.descriptions.keys()],
                unresolved: media.downloadFailedMedia,
                lines: media.lines
            })
            if (media.storageFallbacks > 0) {
                this.#deps.logger.warn(
                    '自动互动：storage 中转上传失败 ' +
                        `${media.storageFallbacks} 张，已回退 base64 直附`
                )
            }
            if (media.downloadFailedMedia.length > 0) {
                this.#deps.logger.warn(
                    '自动互动：图片下载失败 ' +
                        `${media.downloadFailedMedia.length} 张` +
                        `（${media.downloadFailedMedia.join('、')}），` +
                        '已降级为元数据'
                )
            }
            const policy: DecisionPolicy =
                trigger.kind === 'friend-post'
                    ? {
                          commentMode: this.#options.friendPostCommentMode,
                          likeMode: this.#options.friendPostLikeMode
                      }
                    : { commentMode: 'forced', likeMode: 'off' }
            const targetText = (
                activeComment?.content ?? detail.content
            ).trim()
            const perceptible =
                targetText.length > 0 ||
                media.imageParts.length > 0 ||
                media.descriptions.size > 0
            if (policy.commentMode !== 'off' && !perceptible) {
                this.#debug(
                    'not-perceptible',
                    `目标无可感知内容，不发起评论（post=${trigger.post.id}）`,
                    {
                        postContentLength: detail.content.trim().length,
                        attached: media.imageParts.length,
                        described: media.descriptions.size,
                        mediaLines: media.lines
                    }
                )
                terminalizeTrigger(
                    this.state,
                    trigger.key,
                    'nothing-perceptible',
                    this.#deps.now().getTime()
                )
                continue
            }
            const prompt = buildInteractionPrompt({
                assistantLabel: this.#options.assistantLabel,
                persona,
                detail,
                trigger,
                activeComment,
                media,
                promptTask: this.#options.promptTask,
                promptMedia: this.#options.promptMedia,
                promptWriting: this.#options.promptWriting,
                promptSystem: this.#options.promptSystem,
                policy
            })
            this.#debug('prompt-built', '提示词已构建', {
                systemPromptLength: prompt.systemPrompt.length,
                hasActiveComment: activeComment !== null,
                commentCount: detail.comments.length
            })
            let decision: InteractionDecisionOutcome
            try {
                decision = await this.#deps.decide({
                    model,
                    prompt,
                    media,
                    signal: this.#controller.signal,
                    postId: trigger.post.id,
                    policy,
                    debugSink: this.#options.debug ? this.#deps.logger : null
                })
            } catch (error) {
                if (this.stopped) return
                this.#debug(
                    'decide-failed',
                    `模型决策异常（post=${trigger.post.id}）`,
                    (error as Error).message
                )
                this.#deps.logger.warn(
                    `自动互动：模型决策失败（post=${trigger.post.id}）`
                )
                this.#recordError('model-decision', stats)
                continue
            }
            if (this.stopped) return
            if (decision.value === null) {
                this.#debug(
                    'decide-invalid',
                    `模型未产出有效评论，保留待处理（post=${trigger.post.id}）`,
                    {
                        reason: decision.error ?? 'unknown',
                        note: '下一轮会重新尝试'
                    }
                )
                this.#deps.logger.warn(
                    `自动互动：模型决策无效（post=${trigger.post.id}，` +
                        `原因=${decision.error ?? 'unknown'}）`
                )
                this.#recordError('model-decision', stats)
                continue
            }
            if (this.stopped) return
            if (policy.likeMode === 'decide' && decision.value.like) {
                await this.#likeDiscoveredPost(detail, stats, 'model')
                if (this.stopped) return
            }
            if (!decision.value.publish) {
                this.#debug(
                    'decide-skipped',
                    policy.commentMode === 'off'
                        ? `仅点赞模式，本次不评论（post=${trigger.post.id}）`
                        : `模型决定不评论（post=${trigger.post.id}）`,
                    {
                        commentMode: policy.commentMode,
                        note: '该触发已终结，不会在后续轮次重复询问'
                    }
                )
                terminalizeTrigger(
                    this.state,
                    trigger.key,
                    'model-declined',
                    this.#deps.now().getTime()
                )
                continue
            }
            const content = decision.value.content?.trim() ?? ''
            if (content.length === 0) {
                this.#debug(
                    'decide-empty',
                    `模型未产出评论正文，保留待处理（post=${trigger.post.id}）`
                )
                this.#deps.logger.warn(
                    `自动互动：模型未产出评论正文（post=${trigger.post.id}）`
                )
                this.#recordError('model-decision', stats)
                continue
            }
            stats.writeAttempts += 1
            this.#debug(
                'write',
                trigger.kind === 'friend-post'
                    ? `评论好友动态 post=${trigger.post.id}`
                    : `回复评论 post=${trigger.post.id} ` +
                          `comment=${activeComment?.id ?? 'unknown'}`,
                { content }
            )
            let result: CommentMutationResult
            try {
                result =
                    trigger.kind === 'friend-post'
                        ? await this.#deps.comment({
                              post: detail,
                              content
                          })
                        : await this.#deps.reply({
                              post: detail,
                              comment: activeComment!,
                              content
                          })
            } catch (error) {
                if (this.stopped) return
                this.#debug(
                    'write-failed',
                    `写入失败（post=${trigger.post.id}）`,
                    {
                        error: describeError(error),
                        authFailure: error instanceof QzoneWriteAuthError
                    }
                )
                terminalizeTrigger(
                    this.state,
                    trigger.key,
                    error instanceof QzoneWriteAuthError
                        ? 'write-auth-failed'
                        : 'write-failed-no-retry',
                    this.#deps.now().getTime()
                )
                this.#recordError(
                    error instanceof QzoneWriteAuthError
                        ? 'write-auth'
                        : 'write',
                    stats
                )
                continue
            }
            if (this.stopped) return
            this.#debug('write-result', `写入完成 outcome=${result.outcome}`, {
                outcome: result.outcome,
                note:
                    result.outcome === 'unknown'
                        ? '结果不确定，插件不会自动重发，请人工核对'
                        : undefined
            })
            terminalizeTrigger(
                this.state,
                trigger.key,
                result.outcome,
                this.#deps.now().getTime()
            )
            if (result.outcome === 'verified') stats.verified += 1
            if (result.outcome === 'accepted') stats.accepted += 1
            if (result.outcome === 'unknown') stats.unknown += 1
            await this.#stage('detail-refresh', stats, async () => {
                if (trigger.kind === 'friend-post') {
                    await this.#startFriendThread(detail, result, stats)
                } else {
                    await this.#refreshSeenAfterWrite(trigger.post, stats)
                }
            })
        }
    }

    async #startFriendThread(
        detail: QzonePost,
        result: CommentMutationResult,
        stats: ReturnType<typeof mutableRoundStats>
    ): Promise<void> {
        if (this.#options.monitorLimit === 0 || !this.#botId) return
        const reference = result.comment ?? result.reference
        if (!reference) return
        if ('kind' in reference && reference.kind !== 'comment') return
        const botThreadRoot =
            'author' in reference
                ? { id: reference.id, authorId: reference.author.id }
                : { id: reference.id, authorId: reference.authorId }
        if (botThreadRoot.authorId !== this.#botId) return
        const monitored = createMonitoredPost(
            detail,
            'friend',
            this.#deps.now().getTime(),
            false,
            botThreadRoot
        )
        baselineMonitoredPost(monitored, detail, this.#deps.now().getTime())
        this.state.monitoredPosts.set(monitored.key, monitored)
        trimMonitoredPosts(this.state, this.#options.monitorLimit)
        await this.#refreshSeenAfterWrite(detail, stats)
    }

    async #refreshSeenAfterWrite(
        post: QzonePost | PendingTrigger['post'],
        stats: ReturnType<typeof mutableRoundStats>
    ) {
        const monitored = this.state.monitoredPosts.get(postKey(post))
        const botId = this.#botId
        if (!monitored || !botId) return
        try {
            const refreshed = await this.#deps.getPost({
                post,
                signal: this.#controller.signal
            })
            if (this.stopped) return
            if (refreshed.commentsComplete) {
                for (const trigger of discoverCommentTriggers(
                    monitored,
                    refreshed,
                    {
                        botId,
                        detectedAt: this.#deps.now().getTime()
                    }
                )) {
                    if (enqueueTrigger(this.state, trigger)) {
                        stats.discovered += 1
                    }
                }
            }
        } catch {
            if (!this.stopped) {
                this.#recordError('detail-refresh', stats)
            }
        }
    }

    async #stage(
        kind: InteractionErrorKind,
        stats: ReturnType<typeof mutableRoundStats>,
        run: () => Promise<void>
    ): Promise<void> {
        try {
            await run()
        } catch (error) {
            if (this.stopped) return
            this.#recordError(kind, stats)
            this.#deps.logger.warn(
                `自动互动阶段失败（${kind}）${describeError(error)}`
            )
        }
    }

    #recordError(
        kind: InteractionErrorKind,
        stats: ReturnType<typeof mutableRoundStats>
    ): void {
        stats.errors += 1
        this.#lastError = kind
    }

    #debug(event: string, message: string, detail?: unknown): void {
        if (!this.#options.debug) return
        if (detail === undefined) {
            this.#deps.logger.info(`[自动互动/${event}] ${message}`)
            return
        }
        const rendered =
            typeof detail === 'string'
                ? detail
                : (safeStringify(detail) ?? String(detail))
        this.#deps.logger.info(`[自动互动/${event}] ${message}\n${rendered}`)
    }

    #setReport(
        phase: InteractionPhase,
        detail: string,
        currentRound?: InteractionRoundStats
    ): void {
        this.currentReport = {
            phase,
            detail,
            baselineCompletedAt:
                this.state.baselineCompletedAt === null
                    ? null
                    : new Date(this.state.baselineCompletedAt).toISOString(),
            roundStartedAt: this.#roundStartedAt,
            lastRoundAt: this.#lastRoundAt,
            monitoredPosts: this.state.monitoredPosts.size,
            monitorLimit: this.#options.monitorLimit,
            pendingTriggers: this.state.pendingTriggers.size,
            maxWritesPerRound: this.#options.maxWritesPerRound,
            round: currentRound ?? this.#lastRound,
            lastError: this.#lastError
        }
    }
}
