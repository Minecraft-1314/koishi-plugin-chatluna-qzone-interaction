import type {
    CommentReference,
    MutationOutcome,
    PostReference,
    QzoneComment,
    QzonePost
} from 'qzone-sdk'

export type InteractionTriggerKind =
    'friend-thread-reply' | 'self-comment' | 'friend-post'

export type TriggerTerminal =
    | MutationOutcome
    | 'write-auth-failed'
    | 'write-failed-no-retry'
    | 'target-disappeared'
    | 'authorization-revoked'
    | 'nothing-perceptible'
    | 'model-declined'
    | 'not-whitelisted'

export interface PendingTrigger {
    readonly key: string
    readonly kind: InteractionTriggerKind
    readonly post: PostReference
    readonly actorId: string
    readonly commentKey: string | null
    readonly occurredAt: number | null
    readonly detectedAt: number
}

export interface TriggerTerminalRecord {
    readonly result: TriggerTerminal
    readonly completedAt: number
}

export interface MonitoredPost {
    readonly key: string
    post: PostReference
    readonly owner: 'self' | 'friend'
    activityAt: number
    baselineReady: boolean
    botThreadRoot: CommentReference | null
    ignoreCommentsThrough: number | null
    baselineObservationPending: boolean
    readonly seenComments: Set<string>
}

export interface FriendFeedWatermark {
    readonly timestamp: number
    /**
     * 水位线附近已见过的动态，key 为 postKey，值为发布时间戳。
     * 包含时间戳恰好等于水位线的动态，因此水位线前移时无需额外保留同刻集合。
     */
    readonly recentKeys: ReadonlyMap<string, number>
}

export const FRIEND_FEED_GRACE_MS = 10 * 60 * 1000
export const TERMINAL_TRIGGER_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_TERMINAL_TRIGGERS = 2000

const graceFloor = (timestamp: number, graceMs: number): number =>
    graceMs > 0 ? timestamp - graceMs : Number.NEGATIVE_INFINITY

export interface InteractionRuntimeState {
    baseline: 'pending' | 'ready'
    baselineCompletedAt: number | null
    friendFeedWatermark: FriendFeedWatermark | null
    readonly monitoredPosts: Map<string, MonitoredPost>
    readonly pendingTriggers: Map<string, PendingTrigger>
    readonly terminalTriggers: Map<string, TriggerTerminalRecord>
}

const timestampOf = (value: string | null): number | null => {
    if (value === null) return null
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
}

export function postKey(post: PostReference): string {
    return `${post.authorId}:${post.id}`
}

export function sameCommentReference(
    left: CommentReference | null,
    right: CommentReference | null
): boolean {
    if (left === null || right === null) return left === right
    return left.id === right.id && left.authorId === right.authorId
}

export function commentKey(post: PostReference, comment: QzoneComment): string {
    return [
        postKey(post),
        comment.kind,
        comment.threadRoot?.authorId ?? '-',
        comment.threadRoot?.id ?? '-',
        comment.author.id,
        comment.id
    ].join(':')
}

export function triggerKey(
    kind: InteractionTriggerKind,
    post: PostReference,
    nodeKey: string | null = null
): string {
    return `${kind}:${postKey(post)}:${nodeKey ?? '-'}`
}

export function createInteractionRuntimeState(): InteractionRuntimeState {
    return {
        baseline: 'pending',
        baselineCompletedAt: null,
        friendFeedWatermark: null,
        monitoredPosts: new Map(),
        pendingTriggers: new Map(),
        terminalTriggers: new Map()
    }
}

export function createMonitoredPost(
    post: PostReference,
    owner: 'self' | 'friend',
    activityAt: number,
    baselineReady: boolean,
    botThreadRoot: CommentReference | null = null
): MonitoredPost {
    return {
        key: postKey(post),
        post: { id: post.id, authorId: post.authorId },
        owner,
        activityAt,
        baselineReady,
        botThreadRoot,
        ignoreCommentsThrough: null,
        baselineObservationPending: false,
        seenComments: new Set()
    }
}

export function baselineMonitoredPost(
    monitored: MonitoredPost,
    detail: QzonePost,
    detectedAt: number
): void {
    if (!detail.commentsComplete) return
    monitored.post = { id: detail.id, authorId: detail.authorId }
    monitored.seenComments.clear()
    for (const comment of detail.comments) {
        monitored.seenComments.add(commentKey(detail, comment))
    }
    monitored.baselineReady = true
    monitored.ignoreCommentsThrough = null
    monitored.baselineObservationPending = false
    monitored.activityAt = Math.max(
        monitored.activityAt,
        timestampOf(detail.createdAt) ?? detectedAt,
        ...detail.comments.map(
            (comment) => timestampOf(comment.createdAt) ?? detectedAt
        )
    )
}

export interface DiscoverCommentsOptions {
    readonly botId: string
    readonly detectedAt: number
}

export function discoverCommentTriggers(
    monitored: MonitoredPost,
    detail: QzonePost,
    options: DiscoverCommentsOptions
): readonly PendingTrigger[] {
    if (!detail.commentsComplete) return []
    if (!monitored.baselineReady) {
        baselineMonitoredPost(monitored, detail, options.detectedAt)
        return []
    }

    const triggers: PendingTrigger[] = []
    const ignoreThrough = monitored.ignoreCommentsThrough
    const ignoreUndated = monitored.baselineObservationPending
    monitored.post = { id: detail.id, authorId: detail.authorId }
    for (const comment of detail.comments) {
        const nodeKey = commentKey(detail, comment)
        if (monitored.seenComments.has(nodeKey)) continue
        monitored.seenComments.add(nodeKey)
        const occurredAt = timestampOf(comment.createdAt)
        monitored.activityAt = Math.max(
            monitored.activityAt,
            occurredAt ?? options.detectedAt
        )
        if (
            ignoreThrough !== null &&
            (occurredAt === null ? ignoreUndated : occurredAt <= ignoreThrough)
        ) {
            continue
        }
        if (comment.author.id === options.botId) continue
        const kind: InteractionTriggerKind =
            monitored.owner === 'self' ? 'self-comment' : 'friend-thread-reply'
        if (
            monitored.owner === 'friend' &&
            (comment.kind !== 'reply' ||
                !sameCommentReference(
                    comment.threadRoot,
                    monitored.botThreadRoot
                ))
        ) {
            continue
        }
        triggers.push({
            key: triggerKey(kind, detail, nodeKey),
            kind,
            post: { id: detail.id, authorId: detail.authorId },
            actorId: comment.author.id,
            commentKey: nodeKey,
            occurredAt,
            detectedAt: options.detectedAt
        })
    }
    monitored.baselineObservationPending = false
    return triggers
}

export function createFriendPostTrigger(
    post: QzonePost,
    detectedAt: number
): PendingTrigger {
    return {
        key: triggerKey('friend-post', post),
        kind: 'friend-post',
        post: { id: post.id, authorId: post.authorId },
        actorId: post.author.id,
        commentKey: null,
        occurredAt: timestampOf(post.createdAt),
        detectedAt
    }
}

export function enqueueTrigger(
    state: InteractionRuntimeState,
    trigger: PendingTrigger
): boolean {
    if (
        state.pendingTriggers.has(trigger.key) ||
        state.terminalTriggers.has(trigger.key)
    ) {
        return false
    }
    state.pendingTriggers.set(trigger.key, trigger)
    return true
}

export function terminalizeTrigger(
    state: InteractionRuntimeState,
    key: string,
    result: TriggerTerminal,
    completedAt: number
): void {
    state.pendingTriggers.delete(key)
    state.terminalTriggers.set(key, { result, completedAt })
}

export interface TerminalPruneResult {
    readonly expired: number
    readonly overflow: number
    readonly remaining: number
}

export function pruneTerminalTriggers(
    state: InteractionRuntimeState,
    now: number,
    ttlMs: number = TERMINAL_TRIGGER_TTL_MS,
    maxCount: number = MAX_TERMINAL_TRIGGERS
): TerminalPruneResult {
    let expired = 0
    for (const [key, record] of state.terminalTriggers) {
        if (now - record.completedAt >= ttlMs) {
            state.terminalTriggers.delete(key)
            expired += 1
        }
    }
    let overflow = 0
    while (state.terminalTriggers.size > maxCount) {
        const oldest = state.terminalTriggers.keys().next()
        if (oldest.done) break
        state.terminalTriggers.delete(oldest.value)
        overflow += 1
    }
    return {
        expired,
        overflow,
        remaining: state.terminalTriggers.size
    }
}

const triggerPriority: Record<InteractionTriggerKind, number> = {
    'friend-thread-reply': 0,
    'self-comment': 1,
    'friend-post': 2
}

export function sortPendingTriggers(
    values: Iterable<PendingTrigger>
): PendingTrigger[] {
    return [...values].sort((left, right) => {
        const priority =
            triggerPriority[left.kind] - triggerPriority[right.kind]
        if (priority !== 0) return priority
        const leftAt = left.occurredAt ?? left.detectedAt
        const rightAt = right.occurredAt ?? right.detectedAt
        return leftAt - rightAt || left.key.localeCompare(right.key)
    })
}

export function removeMonitoredPost(
    state: InteractionRuntimeState,
    key: string
): void {
    state.monitoredPosts.delete(key)
    for (const [triggerId, trigger] of state.pendingTriggers) {
        if (postKey(trigger.post) === key) {
            state.pendingTriggers.delete(triggerId)
        }
    }
    for (const triggerId of state.terminalTriggers.keys()) {
        if (
            triggerId.startsWith(`self-comment:${key}:`) ||
            triggerId.startsWith(`friend-thread-reply:${key}:`)
        ) {
            state.terminalTriggers.delete(triggerId)
        }
    }
}

export function trimMonitoredPosts(
    state: InteractionRuntimeState,
    limit: number
): readonly string[] {
    const keep = [...state.monitoredPosts.values()]
        .sort(
            (left, right) =>
                right.activityAt - left.activityAt ||
                left.key.localeCompare(right.key)
        )
        .slice(0, Math.max(0, limit))
    const keepKeys = new Set(keep.map((item) => item.key))
    const evicted: string[] = []
    for (const key of state.monitoredPosts.keys()) {
        if (keepKeys.has(key)) continue
        removeMonitoredPost(state, key)
        evicted.push(key)
    }
    return evicted
}

export function findCommentByKey(
    detail: QzonePost,
    expectedKey: string
): QzoneComment | null {
    return (
        detail.comments.find(
            (comment) => commentKey(detail, comment) === expectedKey
        ) ?? null
    )
}

export function createFriendFeedWatermark(
    posts: readonly QzonePost[],
    fallbackTimestamp: number,
    graceMs: number = FRIEND_FEED_GRACE_MS
): FriendFeedWatermark {
    const valid = posts
        .map((post) => ({
            key: postKey(post),
            at: timestampOf(post.createdAt)
        }))
        .filter((item): item is { key: string; at: number } => item.at !== null)
    const timestamp =
        valid.length === 0
            ? fallbackTimestamp
            : Math.max(...valid.map((item) => item.at))
    const floor = graceFloor(timestamp, graceMs)
    const recentKeys = new Map<string, number>()
    for (const item of valid) {
        if (item.at >= floor) recentKeys.set(item.key, item.at)
    }
    return { timestamp, recentKeys }
}

export function advanceFriendFeedWatermark(
    current: FriendFeedWatermark,
    posts: readonly QzonePost[],
    graceMs: number = FRIEND_FEED_GRACE_MS
): FriendFeedWatermark {
    const next = createFriendFeedWatermark(posts, current.timestamp, graceMs)
    if (next.timestamp < current.timestamp) return current
    const floor = graceFloor(next.timestamp, graceMs)
    const recentKeys = new Map<string, number>()
    for (const [key, at] of current.recentKeys) {
        if (at >= floor) recentKeys.set(key, at)
    }
    for (const [key, at] of next.recentKeys) recentKeys.set(key, at)
    return { timestamp: next.timestamp, recentKeys }
}

export function isPostAfterWatermark(
    post: QzonePost,
    watermark: FriendFeedWatermark,
    graceMs: number = FRIEND_FEED_GRACE_MS
): boolean {
    const at = timestampOf(post.createdAt)
    if (at === null) return false
    if (at > watermark.timestamp) return true
    const key = postKey(post)
    if (at === watermark.timestamp) return !watermark.recentKeys.has(key)
    if (graceMs <= 0) return false
    if (at < graceFloor(watermark.timestamp, graceMs)) return false
    return !watermark.recentKeys.has(key)
}

export function isPostBeforeWatermark(
    post: QzonePost,
    watermark: FriendFeedWatermark,
    graceMs: number = FRIEND_FEED_GRACE_MS
): boolean {
    const at = timestampOf(post.createdAt)
    if (at === null) return false
    return at < graceFloor(watermark.timestamp, graceMs)
}

export function raiseFriendFeedWatermark(
    watermark: FriendFeedWatermark,
    timestamp: number,
    graceMs: number = FRIEND_FEED_GRACE_MS
): FriendFeedWatermark {
    if (timestamp <= watermark.timestamp) return watermark
    const floor = graceFloor(timestamp, graceMs)
    const recentKeys = new Map<string, number>()
    if (graceMs > 0) {
        for (const [key, at] of watermark.recentKeys) {
            if (at >= floor) recentKeys.set(key, at)
        }
    }
    return { timestamp, recentKeys }
}

export function isCommentInBotThread(
    comment: QzoneComment,
    threadRoot: CommentReference
): boolean {
    return (
        comment.kind === 'reply' &&
        sameCommentReference(comment.threadRoot, threadRoot)
    )
}
