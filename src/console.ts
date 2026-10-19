import type { Context } from 'koishi'
import type { Client } from '@koishijs/console'
import { resolve } from 'node:path'
import type { Config } from './config'
import type { DigestReport } from './digest/report'
import type { DigestRuntime } from './digest/runtime'
import { createPublishContext, publishQzonePost } from './publish/context'
import {
    PUBLISH_MAX_IMAGES,
    PUBLISH_MAX_IMAGE_BYTES
} from './publish/constants'
import type { RuntimeReports } from './status'
import type { FeedPage, QzonePost } from 'qzone-sdk'
import type { LivingDiaryStatus } from './service'
import type { FeedRequest } from './service'
import type { PublishCapability } from './xml-tool'
import type {
    InteractionReport,
    InteractionRetryView
} from './auto-interaction/report'

const ADMIN_AUTHORITY = 4
const MAX_FEED_COUNT = 20
const MAX_IMAGE_INPUT = 32
const DATA_URL_PREFIX = /^data:image\//iu

interface QzoneServiceLike {
    status(): LivingDiaryStatus
    listFeedPage(request: FeedRequest): Promise<FeedPage>
    getPost(request: {
        post: { id: string; authorId: string }
    }): Promise<QzonePost>
}

export interface QzoneOverview {
    readonly status: unknown
    readonly interaction: InteractionReport | null
    readonly digest: DigestReport | null
    readonly publish: PublishCapability
    readonly retries: readonly InteractionRetryView[]
}

export interface QzoneSettings {
    readonly pluginName: string
    readonly allowUserIds: readonly string[]
    readonly platform: string
    readonly selfId: string
    readonly enablePublishTool: boolean
    readonly enableDailyDigest: boolean
    readonly digestTime: string
    readonly digestMemoryLimit: number
    readonly feedsDefaultLimit: number
    readonly personaPresetId: string
    readonly mainModel: string
    readonly subModel: string
    readonly friendPostCommentMode: string
    readonly friendPostLikeMode: string
    readonly enableInteractionWhitelist: boolean
    readonly interactionAllowUserIds: readonly string[]
    readonly interactionMonitorPostLimit: number
    readonly interactionPollIntervalMinutes: number
    readonly interactionMaxWritesPerRound: number
    readonly interactionWriteRetryLimit: number
    readonly friendFeedBaselineGraceMinutes: number
    readonly videoFrameMode: string
    readonly videoFrameCount: number
    readonly videoMaxMegabytes: number
    readonly ffmpegPath: string
    readonly debug: boolean
    readonly publishImageLimit: number
    readonly publishImageMegabytes: number
}

export interface QzoneFeedItemView {
    readonly id: string
    readonly authorId: string
    readonly authorName: string
    readonly content: string
    readonly createdAt: string | null
    readonly likeCount: number
    readonly commentCount: number
    readonly mediaKinds: readonly string[]
}

export interface QzoneFeedView {
    readonly scope: 'self' | 'profile' | 'friends'
    readonly target: string | null
    readonly items: readonly QzoneFeedItemView[]
}

export interface QzoneFeedQuery {
    readonly count?: number
    readonly target?: string
    readonly scope?: 'self' | 'profile' | 'friends'
}

export interface QzonePostMediaView {
    readonly kind: string
    readonly url: string
    readonly name: string | null
    readonly previewUrl: string | null
    readonly durationMs: number | null
    readonly width: number | null
    readonly height: number | null
}

export interface QzonePostCommentView {
    readonly id: string
    readonly authorName: string
    readonly authorId: string
    readonly content: string
    readonly createdAt: string | null
    readonly kind: string
    readonly replyToName: string | null
}

export interface QzonePostDetailView {
    readonly id: string
    readonly authorId: string
    readonly authorName: string
    readonly authorAvatar: string | null
    readonly content: string
    readonly createdAt: string | null
    readonly likeCount: number
    readonly commentCount: number
    readonly liked: boolean
    readonly commentsComplete: boolean
    readonly media: readonly QzonePostMediaView[]
    readonly comments: readonly QzonePostCommentView[]
}

export interface QzonePostQuery {
    readonly id?: string
    readonly authorId?: string
}

export interface QzonePublishPayload {
    readonly content?: string
    readonly imageUrls?: readonly string[]
    readonly images?: readonly string[]
}

export interface QzoneActionResult {
    readonly ok: boolean
    readonly message: string
}

export interface QzoneRetryPayload {
    readonly key?: string
}

declare module '@koishijs/console' {
    interface Events {
        'qzone/overview'(this: Client): Promise<QzoneOverview>
        'qzone/settings'(this: Client): Promise<QzoneSettings>
        'qzone/feeds'(this: Client, query: QzoneFeedQuery): Promise<QzoneFeedView>
        'qzone/post'(this: Client, query: QzonePostQuery): Promise<QzonePostDetailView>
        'qzone/publish'(this: Client, payload: QzonePublishPayload): Promise<QzoneActionResult>
        'qzone/digest-run'(this: Client): Promise<QzoneActionResult>
        'qzone/retry-drop'(this: Client, payload: QzoneRetryPayload): Promise<QzoneActionResult>
    }
}

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

const DISABLED_PUBLISH: PublishCapability = {
    enabled: false,
    mounted: false,
    reason: 'mount-failed',
    detail: '读取发布能力状态失败',
    observed: 0,
    published: 0,
    failed: 0
}

const readService = (ctx: Context): QzoneServiceLike | null => {
    const service = ctx.get('chatluna_qzone_interaction' as never)
    return (service as QzoneServiceLike | undefined) ?? null
}

const safeRead = <T>(read: () => T, fallback: T): T => {
    try {
        return read()
    } catch {
        return fallback
    }
}

const normalizeCount = (value: unknown, fallback: number): number => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    const rounded = Math.trunc(parsed)
    if (rounded < 1) return 1
    return Math.min(rounded, MAX_FEED_COUNT)
}

const normalizeScope = (
    value: unknown,
    hasTarget: boolean
): 'self' | 'profile' | 'friends' => {
    if (value === 'friends' && !hasTarget) return 'friends'
    if (value === 'profile' && hasTarget) return 'profile'
    return hasTarget ? 'profile' : 'self'
}

const normalizeTarget = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : ''

const normalizeImageUrls = (value: unknown): string[] => {
    if (!Array.isArray(value)) return []
    const urls: string[] = []
    for (const item of value) {
        if (typeof item !== 'string') continue
        const url = item.trim()
        if (url.length === 0) continue
        if (!/^https?:\/\//iu.test(url)) continue
        if (urls.includes(url)) continue
        urls.push(url)
        if (urls.length >= MAX_IMAGE_INPUT) break
    }
    return urls
}

const normalizeDataUrls = (value: unknown): string[] => {
    if (!Array.isArray(value)) return []
    const urls: string[] = []
    for (const item of value) {
        if (typeof item !== 'string') continue
        const url = item.trim()
        if (!DATA_URL_PREFIX.test(url)) continue
        if (urls.includes(url)) continue
        urls.push(url)
        if (urls.length >= MAX_IMAGE_INPUT) break
    }
    return urls
}

const toFeedItem = (post: {
    id: string
    authorId: string
    author: { nickname: string }
    content: string
    createdAt: string | null
    likeCount: number
    commentCount: number
    media: readonly { kind: string }[]
}): QzoneFeedItemView => ({
    id: post.id,
    authorId: post.authorId,
    authorName: post.author.nickname,
    content: post.content,
    createdAt: post.createdAt,
    likeCount: post.likeCount,
    commentCount: post.commentCount,
    mediaKinds: post.media.map((item) => item.kind)
})

const toPostMedia = (media: QzonePost['media'][number]): QzonePostMediaView => ({
    kind: media.kind,
    url: media.url,
    name: media.name ?? null,
    previewUrl: media.kind === 'video' ? (media.previewUrl ?? null) : null,
    durationMs: media.kind === 'video' || media.kind === 'audio' ? (media.durationMs ?? null) : null,
    width: media.kind === 'image' ? (media.width ?? null) : null,
    height: media.kind === 'image' ? (media.height ?? null) : null
})

const toPostComment = (comment: QzonePost['comments'][number]): QzonePostCommentView => ({
    id: comment.id,
    authorName: comment.author.nickname,
    authorId: comment.author.id,
    content: comment.content,
    createdAt: comment.createdAt,
    kind: comment.kind,
    replyToName: comment.replyToUser?.nickname ?? null
})

const toPostDetail = (post: QzonePost): QzonePostDetailView => ({
    id: post.id,
    authorId: post.authorId,
    authorName: post.author.nickname,
    authorAvatar: post.author.avatarUrl ?? null,
    content: post.content,
    createdAt: post.createdAt,
    likeCount: post.likeCount,
    commentCount: post.commentCount,
    liked: post.liked,
    commentsComplete: post.commentsComplete,
    media: post.media.map(toPostMedia),
    comments: post.comments.map(toPostComment)
})

const buildSettings = (config: Config): QzoneSettings => ({
    pluginName: 'chatluna-qzone-interaction',
    allowUserIds: config.allowUserIds,
    platform: config.platform,
    selfId: config.selfId ?? '',
    enablePublishTool: config.enablePublishTool,
    enableDailyDigest: config.enableDailyDigest,
    digestTime: config.digestTime,
    digestMemoryLimit: config.digestMemoryLimit,
    feedsDefaultLimit: config.feedsDefaultLimit,
    personaPresetId: config.personaPresetId,
    mainModel: config.mainModel,
    subModel: config.subModel,
    friendPostCommentMode: config.friendPostCommentMode,
    friendPostLikeMode: config.friendPostLikeMode,
    enableInteractionWhitelist: config.enableInteractionWhitelist,
    interactionAllowUserIds: config.interactionAllowUserIds,
    interactionMonitorPostLimit: config.interactionMonitorPostLimit,
    interactionPollIntervalMinutes: config.interactionPollIntervalMinutes,
    interactionMaxWritesPerRound: config.interactionMaxWritesPerRound,
    interactionWriteRetryLimit: config.interactionWriteRetryLimit,
    friendFeedBaselineGraceMinutes: config.friendFeedBaselineGraceMinutes,
    videoFrameMode: config.videoFrameMode,
    videoFrameCount: config.videoFrameCount,
    videoMaxMegabytes: config.videoMaxMegabytes,
    ffmpegPath: config.ffmpegPath,
    debug: config.debug,
    publishImageLimit: PUBLISH_MAX_IMAGES,
    publishImageMegabytes: PUBLISH_MAX_IMAGE_BYTES / (1024 * 1024)
})

export function setupConsole(
    service: any,
    ctx: Context,
    config: Config,
    reports: RuntimeReports,
    digest: () => DigestRuntime | null,
    publish: () => PublishCapability
): void {
    service.addEntry({
        dev: resolve(__dirname, '../client/index.ts'),
        prod: resolve(__dirname, '../dist')
    })

    service.addListener(
        'qzone/overview',
        async () => {
            const interaction = safeRead(
                () => reports.interaction.get(),
                null
            )
            return {
                status: safeRead(
                    () => readService(ctx)?.status() ?? null,
                    null
                ),
                interaction,
                digest: safeRead(() => digest()?.report ?? null, null),
                publish: safeRead(() => publish(), DISABLED_PUBLISH),
                retries: interaction?.retries ?? []
            }
        },
        { authority: ADMIN_AUTHORITY }
    )

    service.addListener(
        'qzone/settings',
        async () => buildSettings(config),
        { authority: ADMIN_AUTHORITY }
    )

    service.addListener(
        'qzone/feeds',
        async (query: QzoneFeedQuery) => {
            const target = normalizeTarget(query?.target)
            const scope = normalizeScope(query?.scope, target.length > 0)
            const request: FeedRequest = {
                scope,
                limit: normalizeCount(query?.count, config.feedsDefaultLimit),
                ...(scope === 'profile' ? { userId: target } : {})
            }
            const service = readService(ctx)
            if (service === null) {
                throw new Error('QQ 空间服务尚未就绪')
            }
            const page = await service.listFeedPage(request)
            return {
                scope: request.scope,
                target: scope === 'profile' ? target : null,
                items: page.items.map(toFeedItem)
            }
        },
        { authority: ADMIN_AUTHORITY }
    )

    service.addListener(
        'qzone/post',
        async (query: QzonePostQuery) => {
            const id = String(query?.id ?? '').trim()
            const authorId = String(query?.authorId ?? '').trim()
            if (id.length === 0) {
                throw new Error('缺少动态 id')
            }
            const service = readService(ctx)
            if (service === null) {
                throw new Error('QQ 空间服务尚未就绪')
            }
            const post = await service.getPost({
                post: { id, authorId: authorId.length > 0 ? authorId : id }
            })
            return toPostDetail(post)
        },
        { authority: ADMIN_AUTHORITY }
    )

    service.addListener(
        'qzone/publish',
        async (payload: QzonePublishPayload) => {
            const target = createPublishContext(ctx)
            if (target === null) {
                return { ok: false, message: 'QQ 空间服务尚未就绪' }
            }
            const result = await publishQzonePost(target, {
                content: String(payload?.content ?? ''),
                imageUrls: normalizeImageUrls(payload?.imageUrls),
                images: normalizeDataUrls(payload?.images),
                debug: config.debug
            })
            return { ok: result.ok, message: result.text }
        },
        { authority: ADMIN_AUTHORITY }
    )

    service.addListener(
        'qzone/digest-run',
        async () => {
            try {
                const runtime = digest()
                if (runtime === null) {
                    return { ok: false, message: '每日记忆动态未挂载' }
                }
                const report = await runtime.runOnce('manual')
                return {
                    ok: report.phase !== 'failed',
                    message: report.detail
                }
            } catch (error) {
                return {
                    ok: false,
                    message: '执行每日记忆动态失败：' + errorText(error)
                }
            }
        },
        { authority: ADMIN_AUTHORITY }
    )

    service.addListener(
        'qzone/retry-drop',
        async (payload: QzoneRetryPayload) => {
            try {
                const runtime = reports.interactionRuntime.get()
                if (runtime === null) {
                    return { ok: false, message: '自动互动未运行' }
                }
                const key =
                    typeof payload?.key === 'string' ? payload.key : ''
                if (key.length === 0) {
                    return { ok: false, message: '缺少待放弃的重试标识' }
                }
                const dropped = runtime.dropRetry(key)
                return {
                    ok: dropped,
                    message: dropped
                        ? '已放弃该条重试'
                        : '未找到该条重试记录'
                }
            } catch (error) {
                return {
                    ok: false,
                    message: '放弃重试失败：' + errorText(error)
                }
            }
        },
        { authority: ADMIN_AUTHORITY }
    )

    ctx.logger.info('QQ 空间控制台页面已注册，路径 /qzone')
}
