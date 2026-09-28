import { Context, Service, Universal } from 'koishi'
import { QzoneClient } from 'qzone-sdk'
import type {
    CommentMutationResult,
    CommentOptions,
    FeedPage,
    GetPostOptions,
    LikeMutationResult,
    LikeOptions,
    PostMutationResult,
    PublishPostOptions,
    QzoneLogger,
    QzonePost,
    ReplyOptions
} from 'qzone-sdk'
import {
    acquireQzoneCookies,
    type CookieBot,
    COOKIE_PLATFORM_LABELS,
    type CookiePlatform,
    describePlatformOrder,
    NoBotAvailableError,
    type QzoneCookieGrant,
    resolvePlatformOrder,
    selectCookieBot,
    selectCookieBotView
} from './qzone/cookie-source'
import type { Config } from './config'
import { QzoneManager, type QzoneManagerStatus } from './qzone/manager'

declare module 'koishi' {
    interface Context {
        chatluna_qzone_interaction: LivingDiaryService
    }
}

export const REBIND_BACKOFF_MAX_SECONDS = 300

export interface LivingDiaryBotStatus {
    readonly platform: string
    readonly selfId: string
    readonly online: boolean
}

export interface LivingDiaryStatus {
    readonly bot: LivingDiaryBotStatus | null
    readonly client: QzoneManagerStatus
}

export interface FeedRequest {
    readonly scope: 'self' | 'profile' | 'friends'
    readonly userId?: string
    readonly limit: number
    readonly cursor?: string
    readonly signal?: AbortSignal
}

export class LivingDiaryService extends Service<Config> {
    private readonly manager: QzoneManager

    constructor(ctx: Context, config: Config) {
        super(ctx, 'chatluna_qzone_interaction', true)
        this.config = config
        this.manager = new QzoneManager({
            acquire: async () => acquireQzoneCookies(this.requireBot()),
            createClient: (grant) => this.createClient(grant),
            logger: ctx.logger,
            rebind: {
                minIntervalSeconds: config.rebindMinIntervalSeconds,
                backoffSeconds: config.rebindBackoffSeconds,
                maxBackoffSeconds: REBIND_BACKOFF_MAX_SECONDS,
                maxConsecutiveFailures: config.rebindMaxConsecutiveFailures
            }
        })
    }

    listFeedPage(request: FeedRequest): Promise<FeedPage> {
        return this.manager.listFeedPage(request)
    }

    getPost(request: GetPostOptions): Promise<QzonePost> {
        return this.manager.getPost(request)
    }

    comment(request: CommentOptions): Promise<CommentMutationResult> {
        return this.manager.comment(request)
    }

    reply(request: ReplyOptions): Promise<CommentMutationResult> {
        return this.manager.reply(request)
    }

    like(request: LikeOptions): Promise<LikeMutationResult> {
        return this.manager.like(request)
    }

    publishPost(request: PublishPostOptions): Promise<PostMutationResult> {
        return this.manager.publishPost(request)
    }

    status(): LivingDiaryStatus {
        const order = resolvePlatformOrder(this.config.platform)
        const selected = selectCookieBotView(this.ctx.bots, this.config.selfId, order)
        return {
            bot: selected
                ? {
                      platform: COOKIE_PLATFORM_LABELS[selected.platform],
                      selfId: selected.bot.selfId,
                      online:
                          selected.bot.status === Universal.Status.ONLINE
                  }
                : null,
            client: this.manager.status()
        }
    }

    protected async stop(): Promise<void> {
        await this.manager.close()
    }

    private requireBot(): CookieBot {
        const order = resolvePlatformOrder(this.config.platform)
        const bot = selectCookieBot(this.ctx.bots, this.config.selfId, order)
        if (!bot) {
            throw new NoBotAvailableError(
                '没有可用的机器人（协议优先级 ' +
                    `${describePlatformOrder(order)}；未上线或 selfId 不匹配），` +
                    '无法获取 QQ 空间登录态'
            )
        }
        return bot
    }

    private createClient(grant: QzoneCookieGrant): QzoneClient {
        return new QzoneClient({
            session: { cookies: grant.cookies },
            logger: this.sdkLogger()
        })
    }

    private sdkLogger(): QzoneLogger {
        return (event) => {
            const parts = ['qzone-sdk', event.phase]
            if (event.endpoint) parts.push(event.endpoint)
            if (event.statusCode !== undefined) {
                parts.push(`HTTP ${event.statusCode}`)
            }
            if (event.errorCode) parts.push(`code=${event.errorCode}`)
            if (event.retryCount !== undefined) {
                parts.push(`retry=${event.retryCount}`)
            }
            if (event.durationMs !== undefined) {
                parts.push(`${event.durationMs}ms`)
            }
            this.ctx.logger[event.level](parts.join(' '))
        }
    }
}
