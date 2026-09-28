import {
    type CommentMutationResult,
    type CommentOptions,
    type FeedPage,
    type GetPostOptions,
    type LikeMutationResult,
    type LikeOptions,
    type ListFeedsOptions,
    type PostMutationResult,
    type PublishPostOptions,
    QzoneAuthError,
    QzoneCancelledError,
    type QzoneClient,
    type QzonePost,
    type ReplyOptions,
    type SessionInfo
} from 'qzone-sdk'
import type { QzoneCookieGrant } from './cookie-source'
import type { LivingDiaryLogger } from '../logging'
import {
    RebindController,
    type RebindOptions,
    RebindRejectedError,
    type RebindStats
} from './rebind'

export interface FeedQuery {
    readonly scope: 'self' | 'profile' | 'friends'
    readonly userId?: string
    readonly limit: number
    readonly cursor?: string
    readonly signal?: AbortSignal
}

export interface QzoneManagerStatus {
    readonly initialized: boolean
    readonly accountId: string | null
    readonly authenticated: boolean
    readonly sessionUpdatedAt: string | null
    readonly rebind: RebindStats
}

export type QzoneWriteOperation = 'comment' | 'reply' | 'like' | 'publish'

export class QzoneWriteAuthError extends Error {
    readonly operation: QzoneWriteOperation
    readonly rebound: boolean

    constructor(operation: QzoneWriteOperation, rebound: boolean) {
        const labels: Record<QzoneWriteOperation, string> = {
            comment: '评论动态',
            reply: '回复评论',
            like: '点赞动态',
            publish: '发布动态'
        }
        super(
            rebound
                ? `${labels[operation]}时登录态失效，续绑已完成`
                : `${labels[operation]}时登录态失效，续绑不可用`
        )
        this.name = 'QzoneWriteAuthError'
        this.operation = operation
        this.rebound = rebound
    }
}

export interface QzoneManagerDeps {
    readonly acquire: () => Promise<QzoneCookieGrant>
    readonly createClient: (grant: QzoneCookieGrant) => QzoneClient
    readonly logger: LivingDiaryLogger
    readonly rebind: RebindOptions
}

export class QzoneManager {
    readonly rebind: RebindController
    readonly #deps: QzoneManagerDeps
    #client: QzoneClient | null = null
    #initInFlight: Promise<void> | null = null
    #closed = false

    constructor(deps: QzoneManagerDeps) {
        this.#deps = deps
        this.rebind = new RebindController({
            ...deps.rebind,
            logger: deps.rebind.logger ?? deps.logger
        })
    }

    async listFeedPage(query: FeedQuery): Promise<FeedPage> {
        const options = toListOptions(query)
        return this.#runRead('读取动态', (client) => client.listFeeds(options))
    }

    getPost(request: GetPostOptions): Promise<QzonePost> {
        return this.#runRead('读取动态详情', (client) =>
            client.getPost(request)
        )
    }

    comment(request: CommentOptions): Promise<CommentMutationResult> {
        return this.#runWrite('comment', '评论动态', (client) =>
            client.comment(request)
        )
    }

    reply(request: ReplyOptions): Promise<CommentMutationResult> {
        return this.#runWrite('reply', '回复评论', (client) =>
            client.reply(request)
        )
    }

    like(request: LikeOptions): Promise<LikeMutationResult> {
        return this.#runWrite('like', '点赞动态', (client) =>
            client.like(request)
        )
    }

    publishPost(request: PublishPostOptions): Promise<PostMutationResult> {
        return this.#runWrite('publish', '发布动态', (client) =>
            client.publishPost(request)
        )
    }

    status(): QzoneManagerStatus {
        const info: SessionInfo | null = this.#client?.getSessionInfo() ?? null
        return {
            initialized: this.#client !== null,
            accountId: info?.accountId ?? null,
            authenticated: info?.authenticated ?? false,
            sessionUpdatedAt: info?.updatedAt ?? null,
            rebind: this.rebind.stats()
        }
    }

    async close(): Promise<void> {
        this.#closed = true
        await this.#initInFlight?.catch(() => {})
        const client = this.#client
        this.#client = null
        if (client) {
            await client.close()
        }
    }

    async #getClient(): Promise<QzoneClient> {
        if (this.#closed) {
            throw new QzoneCancelledError('QQ 空间客户端已随插件停止释放')
        }
        if (this.#client) {
            return this.#client
        }
        if (this.#initInFlight) {
            await this.#initInFlight
            if (this.#closed) {
                throw new QzoneCancelledError('QQ 空间客户端已随插件停止释放')
            }
            return this.#requireClient()
        }
        const task = (async () => {
            const grant = await this.#deps.acquire()
            if (this.#closed) {
                throw new QzoneCancelledError('QQ 空间客户端已随插件停止释放')
            }
            this.#client = this.#deps.createClient(grant)
        })()
        this.#initInFlight = task
        try {
            await task
        } finally {
            this.#initInFlight = null
        }
        if (this.#closed) {
            throw new QzoneCancelledError('QQ 空间客户端已随插件停止释放')
        }
        return this.#requireClient()
    }

    #requireClient(): QzoneClient {
        if (!this.#client) {
            throw new Error('QQ 空间客户端未初始化')
        }
        return this.#client
    }

    async #runRead<T>(
        phase: string,
        operation: (client: QzoneClient) => Promise<T>
    ): Promise<T> {
        const client = await this.#getClient()
        try {
            return await operation(client)
        } catch (error) {
            if (!(error instanceof QzoneAuthError)) {
                throw error
            }
            const rebound = await this.#tryRebind(phase)
            if (!rebound) {
                throw error
            }
            return operation(await this.#getClient())
        }
    }

    async #runWrite<T>(
        kind: QzoneWriteOperation,
        phase: string,
        operation: (client: QzoneClient) => Promise<T>
    ): Promise<T> {
        const client = await this.#getClient()
        try {
            return await operation(client)
        } catch (error) {
            if (error instanceof QzoneAuthError) {
                const rebound = await this.#tryRebind(phase)
                throw new QzoneWriteAuthError(kind, rebound)
            }
            throw error
        }
    }

    async #tryRebind(phase: string): Promise<boolean> {
        if (this.#closed) {
            return false
        }
        try {
            await this.rebind.attempt(async () => {
                const grant = await this.#deps.acquire()
                if (this.#closed) {
                    throw new QzoneCancelledError('插件已停止，放弃续绑')
                }
                const client = this.#client
                if (client) {
                    await client.updateSession({ cookies: grant.cookies })
                } else {
                    this.#client = this.#deps.createClient(grant)
                }
            })
            return true
        } catch (error) {
            if (error instanceof RebindRejectedError) {
                this.#deps.logger.warn(
                    `续绑被拒绝（${phase}）：${error.message}`
                )
            } else {
                const stats = this.rebind.stats()
                const retry = stats.nextAllowedAtSeconds
                    ? `，${Math.max(
                          0,
                          Math.ceil(
                              stats.nextAllowedAtSeconds - Date.now() / 1000
                          )
                      )} 秒后可重试`
                    : ''
                this.#deps.logger.warn(
                    `续绑失败（${phase}）：${(error as Error).message}` +
                        `（连续失败 ${stats.consecutiveFailures} 次${retry}）`
                )
            }
            return false
        }
    }
}

function toListOptions(query: FeedQuery): ListFeedsOptions {
    const page = {
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.signal ? { signal: query.signal } : {})
    }
    if (query.scope === 'profile') {
        if (!query.userId) {
            throw new Error('读取指定用户动态需要提供 QQ 号')
        }
        return { scope: 'profile', userId: query.userId, ...page }
    }
    return { scope: query.scope, ...page }
}
