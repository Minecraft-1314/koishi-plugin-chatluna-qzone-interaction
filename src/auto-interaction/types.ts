import type {
    CommentMutationResult,
    CommentOptions,
    FeedPage,
    GetPostOptions,
    LikeMutationResult,
    LikeOptions,
    QzoneMedia,
    QzonePost,
    ReplyOptions
} from 'qzone-sdk'
import type { LivingDiaryLogger } from '../logging'
import type { ChatLunaChatModel } from '../chatluna'
import type { InteractionMode } from '../config'
import type {
    InteractionDecisionDeps,
    InteractionDecisionOutcome
} from './agent'
import type { PreparedInteractionMedia } from './media'
export interface AutoInteractionDeps {
    readonly now: () => Date
    readonly logger: LivingDiaryLogger
    readonly isBotOnline: () => boolean
    readonly listFeedPage: (request: {
        readonly scope: 'self' | 'friends'
        readonly limit: number
        readonly cursor?: string
        readonly signal?: AbortSignal
    }) => Promise<FeedPage>
    readonly getPost: (request: GetPostOptions) => Promise<QzonePost>
    readonly comment: (
        request: CommentOptions
    ) => Promise<CommentMutationResult>
    readonly reply: (request: ReplyOptions) => Promise<CommentMutationResult>
    readonly like: (request: LikeOptions) => Promise<LikeMutationResult>
    readonly getAccountId: () => string | null
    readonly resolveModel: (
        modelRef: string
    ) => Promise<ChatLunaChatModel | null>
    readonly renderPersona: (presetId: string) => Promise<string>
    readonly canDescribeMedia: () => boolean
    readonly prepareMedia: (
        media: readonly QzonePost['media'][number][],
        model: ChatLunaChatModel,
        readerAvailable: boolean,
        signal?: AbortSignal
    ) => Promise<PreparedInteractionMedia>
    readonly decide: (
        deps: Omit<InteractionDecisionDeps, 'ctx'>
    ) => Promise<InteractionDecisionOutcome>
}

export interface AutoInteractionOptions {
    readonly friendPostCommentMode: InteractionMode
    readonly friendPostLikeMode: InteractionMode
    readonly interactionWhitelist: InteractionWhitelist
    readonly monitorLimit: number
    readonly maxWritesPerRound: number
    readonly modelRef: string
    readonly presetId: string
    readonly assistantLabel: string
    readonly debug: boolean
    readonly promptTask: string
    readonly promptMedia: string
    readonly promptWriting: string
    readonly promptSystem: string
}

export interface InteractionWhitelist {
    readonly enabled: boolean
    readonly allowed: ReadonlySet<string>
}

export const createInteractionWhitelist = (
    enabled: boolean,
    userIds: readonly string[]
): InteractionWhitelist => ({
    enabled,
    allowed: new Set(
        userIds
            .map((item) => String(item).trim())
            .filter((item) => item.length > 0)
    )
})

export const isWhitelistUsable = (list: InteractionWhitelist): boolean =>
    !list.enabled || list.allowed.size > 0

export const isUserAllowed = (
    list: InteractionWhitelist,
    userId: string | null | undefined
): boolean => {
    if (!list.enabled) return true
    const id = (userId ?? '').trim()
    if (id.length === 0) return false
    return list.allowed.has(id)
}
