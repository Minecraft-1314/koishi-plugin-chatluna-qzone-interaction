import type { Context } from 'koishi'
import { SystemMessage } from '@langchain/core/messages'
import type { Config } from '../config'
import type { LivingDiaryLogger } from '../logging'
import { publishQzonePost } from '../publish'
import {
    registerGetTempListener,
    subscribeAssistantResponses,
    type TempLike
} from './character-runtime'
import { parsePublishTags } from './self-closing'

export const PUBLISH_TAG = 'qzone_publish'
const MAX_TAGS_PER_RESPONSE = 3
const PUBLISH_RETRY_DELAY_MS = 1000
const PUBLISH_MAX_RETRIES = 3
const MAX_FEEDBACK_PENDING = 8

const PUBLISH_OUTCOME_FEEDBACK: Record<string, string> = {
    verified: '已成功发布到 QQ 空间（已读回确认）：',
    accepted: '已提交到 QQ 空间，但服务端尚未读回确认：',
    unknown:
        '结果不确定，无法确认是否发布成功，请先用 qzone.feeds 核对后再答复用户：',
    'already-applied': '该动态此前已经发布过，本次未重复提交：'
}

const feedbackForOutcome = (outcome: string, detail: string): string =>
    (PUBLISH_OUTCOME_FEEDBACK[outcome] ??
        '发布返回未知结果，无法确认是否成功：') + detail

interface CharacterServiceLike {
    getTemp?: (...args: unknown[]) => Promise<TempLike>
}

interface PipelineHandler {
    (runtime: unknown, next: () => Promise<void>): Promise<void>
}

interface ContextManagerLike {
    pipeline?: (
        stage: string,
        handler: PipelineHandler,
        priority?: number
    ) => () => void
}

interface ToolStats {
    observed: number
    published: number
    failed: number
}

export type PublishCapabilityReason =
    | 'disabled'
    | 'missing-character'
    | 'mount-failed'
    | 'ready'

export interface PublishCapability {
    readonly enabled: boolean
    readonly mounted: boolean
    readonly reason: PublishCapabilityReason
    readonly detail: string
    readonly observed: number
    readonly published: number
    readonly failed: number
}

const readCharacterService = (
    ctx: Context
): CharacterServiceLike | null => {
    const holder = ctx as unknown as Record<string, unknown>
    const service = holder['chatluna_character']
    if (service == null) return null
    const candidate = service as CharacterServiceLike
    return typeof candidate.getTemp === 'function' ? candidate : null
}

const imageIndex = (key: string): number =>
    Number.parseInt(key.replace(/^image/iu, ''), 10) || 0

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

export class PublishXmlTool {
    #dispose: (() => void) | null = null
    #promptDispose: (() => void) | null = null
    #sessionDisposes: (() => void)[] = []
    #warned = false
    #stats: ToolStats = { observed: 0, published: 0, failed: 0 }
    #publishQueue: Array<{ attrs: Record<string, string>; retries: number }> = []
    #publishing = false
    #generation = 0
    #reason: PublishCapabilityReason = 'disabled'
    #detail = ''
    #pendingFeedback: string[] = []

    constructor(
        private readonly ctx: Context,
        private readonly config: Config,
        private readonly logger: LivingDiaryLogger
    ) {}

    get stats(): ToolStats {
        return this.#stats
    }

    get capability(): PublishCapability {
        return {
            enabled: this.config.enablePublishTool,
            mounted: this.#reason === 'ready',
            reason: this.#reason,
            detail: this.#detail,
            observed: this.#stats.observed,
            published: this.#stats.published,
            failed: this.#stats.failed
        }
    }

    start(): void {
        if (!this.config.enablePublishTool) {
            this.#reason = 'disabled'
            this.#detail = '配置项 enablePublishTool 已关闭，模型无法主动发布空间动态'
            this.logger.debug('qzone_publish XML 发布能力未启用')
            return
        }
        if (this.#dispose !== null) return
        const service = readCharacterService(this.ctx)
        if (service === null) {
            this.#warnMissingCharacter()
            return
        }
        const sessions = new WeakMap<object, unknown>()
        const unsubscribes = new WeakMap<object, () => void>()
        this.#sessionDisposes = []
        this.#generation += 1
        const detach = registerGetTempListener(
            service as unknown as Record<string, unknown>,
            (temp, session) => {
                const list = temp?.completionMessages
                if (!Array.isArray(list)) return
                this.#flushFeedback(list)
                const key = list as unknown as object
                sessions.set(key, session)
                if (unsubscribes.has(key)) return
                const unsubscribe = subscribeAssistantResponses(
                    list,
                    () => sessions.get(key) ?? null,
                    (payload) => this.#onResponse(payload.response),
                    (error) => {
                        this.logger.warn(
                            '[qzone_publish] 处理模型输出失败：' +
                                errorText(error)
                        )
                    }
                )
                unsubscribes.set(key, unsubscribe)
                this.#sessionDisposes.push(unsubscribe)
            },
            (args) => args[0] ?? null
        )
        if (detach === null) {
            this.#reason = 'mount-failed'
            this.#detail =
                'chatluna_character 服务存在但 getTemp 不可用，发布能力挂载失败'
            this.logger.warn('qzone_publish XML 发布能力挂起：' + this.#detail)
            return
        }
        this.#dispose = detach
        this.#promptDispose = this.#injectPrompt()
        this.#reason = 'ready'
        this.#detail = '已挂载，等待模型输出 <' + PUBLISH_TAG + '> 标签'
        this.logger.info('qzone_publish XML 发布能力已挂载（Character 流程）')
    }

    stop(): void {
        this.#dispose?.()
        this.#dispose = null
        this.#promptDispose?.()
        this.#promptDispose = null
        for (const dispose of this.#sessionDisposes) dispose()
        this.#sessionDisposes = []
        this.#generation += 1
        this.#publishQueue = []
        this.#publishing = false
        this.#pendingFeedback = []
        if (this.#reason === 'ready') {
            this.#reason = 'missing-character'
            this.#detail = '已随插件卸载'
        }
    }

    #warnMissingCharacter(): void {
        this.#reason = 'missing-character'
        this.#detail =
            '未检测到可用的 chatluna_character 服务，模型无法主动发布空间动态'
        if (this.#warned) return
        this.#warned = true
        this.logger.warn(
            'qzone_publish XML 发布能力挂起：' + this.#detail
        )
    }

    #onResponse(response: string): void {
        const tags = parsePublishTags(response, PUBLISH_TAG)
        if (tags.length === 0) return
        this.#stats.observed += tags.length
        if (this.config.debug) {
            this.logger.info(
                '[qzone_publish] 捕获 ' +
                    tags.length +
                    ' 个 <' +
                    PUBLISH_TAG +
                    '> 标签'
            )
        }
        for (const attrs of tags.slice(0, MAX_TAGS_PER_RESPONSE)) {
            this.#publishQueue.push({ attrs, retries: 0 })
        }
        void this.#processQueue()
    }

    #recordFeedback(text: string): void {
        if (this.#pendingFeedback.length >= MAX_FEEDBACK_PENDING) {
            this.#pendingFeedback.shift()
        }
        this.#pendingFeedback.push(text)
    }

    #flushFeedback(list: unknown[]): void {
        if (this.#pendingFeedback.length === 0) return
        const lines = this.#pendingFeedback
        this.#pendingFeedback = []
        list.push(
            new SystemMessage(
                '<qzone_publish_result>\n' +
                    lines
                        .map((line) => '- ' + line)
                        .join('\n') +
                    '\n</qzone_publish_result>\n' +
                    '以上是你上一轮请求发布 QQ 空间动态的真实结果。' +
                    '请据此如实告知用户：只有结果为成功时才能说已发布；' +
                    '失败时必须说明失败原因。不要凭猜测宣布发布成功。'
            )
        )
    }

    async #processQueue(): Promise<void> {
        if (this.#publishing) return
        this.#publishing = true
        const generation = this.#generation
        try {
            while (this.#publishQueue.length > 0) {
                if (generation !== this.#generation) return
                const item = this.#publishQueue.shift()
                if (!item) break
                await this.#publishOneWithRetry(item.attrs, item.retries)
            }
        } catch (error) {
            if (generation !== this.#generation) return
            this.#stats.failed += this.#publishQueue.length
            this.#publishQueue = []
            this.#recordFeedback(
                '未发布到 QQ 空间：发布队列异常中断 ' + errorText(error)
            )
            this.logger.warn(
                '[qzone_publish] 发布队列异常中断：' + errorText(error)
            )
        } finally {
            if (generation === this.#generation) this.#publishing = false
        }
    }

    async #publishOneWithRetry(
        attrs: Record<string, string>,
        currentRetries: number
    ): Promise<void> {
        const content = (attrs['content'] ?? '').trim()
        if (content.length === 0) {
            const text = '未发布：<qzone_publish> 标签缺少 content 属性'
            this.#recordFeedback(text)
            this.logger.warn('qzone_publish：' + text + '，已忽略')
            return
        }
        const imageUrls = Object.keys(attrs)
            .filter((key) => /^image\d+$/u.test(key))
            .sort((left, right) => imageIndex(left) - imageIndex(right))
            .map((key) => attrs[key].trim())
            .filter((url) => url.length > 0)
        try {
            const result = await publishQzonePost(this.ctx, {
                content,
                imageUrls,
                debug: this.config.debug
            })
            if (result.ok) {
                this.#stats.published += 1
                this.#recordFeedback(feedbackForOutcome(result.outcome, result.text))
                this.logger.info('[qzone_publish] ' + result.text)
                return
            }
            if (result.authExpired && currentRetries < PUBLISH_MAX_RETRIES) {
                this.logger.warn(
                    '[qzone_publish] 登录态已刷新，准备重试发布...'
                )
                await this.#delay(PUBLISH_RETRY_DELAY_MS)
                this.#publishQueue.push({ attrs, retries: currentRetries + 1 })
                return
            }
            this.#stats.failed += 1
            this.#recordFeedback('未发布到 QQ 空间：' + result.text)
            this.logger.warn('[qzone_publish] ' + result.text)
        } catch (error) {
            if (currentRetries < PUBLISH_MAX_RETRIES) {
                this.logger.warn(
                    '[qzone_publish] 发布异常，准备重试：' + errorText(error)
                )
                await this.#delay(PUBLISH_RETRY_DELAY_MS)
                this.#publishQueue.push({ attrs, retries: currentRetries + 1 })
                return
            }
            this.#stats.failed += 1
            this.#recordFeedback('未发布到 QQ 空间：发布异常 ' + errorText(error))
            this.logger.warn('[qzone_publish] 发布异常 ' + errorText(error))
        }
    }

    #delay(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, ms)
            timer.unref()
        })
    }

    #injectPrompt(): (() => void) | null {
        const template = this.config.promptPublishTool.trim()
        if (template.length === 0) return null
        const holder = this.ctx as unknown as Record<string, unknown>
        const chatluna = holder['chatluna'] as
            | { contextManager?: ContextManagerLike }
            | undefined
        const manager = chatluna?.contextManager
        if (typeof manager?.pipeline !== 'function') {
            this.logger.warn(
                '当前 ChatLuna 版本不支持自动注入参考提示词，请把配置项 ' +
                    'promptPublishTool 的内容手动加入 Character 预设提示词，' +
                    '否则模型不会输出 <' +
                    PUBLISH_TAG +
                    '> 标签'
            )
            return null
        }
        return manager.pipeline(
            'after_system_prompts',
            async (runtime, next) => {
                await this.#pushSystemPrompt(runtime, template)
                await next()
            },
            30
        )
    }

    async #pushSystemPrompt(
        runtime: unknown,
        template: string
    ): Promise<void> {
        try {
            const messages = (runtime as { result?: unknown[] })?.result
            if (!Array.isArray(messages)) return
            const { SystemMessage } = await import('@langchain/core/messages')
            messages.push(new SystemMessage(template))
        } catch (error) {
            this.logger.debug(
                '[qzone_publish] 注入参考提示词失败：' + errorText(error)
            )
        }
    }
}
