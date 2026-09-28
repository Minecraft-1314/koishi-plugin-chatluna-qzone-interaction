import type { Context } from 'koishi'
import type { ChatLunaChatModel } from '../chatluna'
import type { Config } from '../config'
import type { LivingDiaryLogger } from '../logging'
import { publishQzonePost } from '../publish'
import { isModelConfigured } from '../persona'
import {
    buildDigestPrompt,
    generateDigestDecision
} from './generator'
import { readTodayMemories } from './memory-source'
import { emptyDigestReport, type DigestReport } from './report'

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/
const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS

export interface DigestDeps {
    readonly now: () => Date
    readonly logger: LivingDiaryLogger
    readonly resolveModel: (modelRef: string) => Promise<ChatLunaChatModel | null>
    readonly renderPersona: (presetId: string) => Promise<string>
}

export const parseDigestTime = (value: string): { hour: number; minute: number } | null => {
    const matched = TIME_PATTERN.exec(value.trim())
    if (matched === null) return null
    return { hour: Number(matched[1]), minute: Number(matched[2]) }
}

const nextTriggerAt = (now: Date, hour: number, minute: number): number => {
    const target = new Date(now)
    target.setHours(hour, minute, 0, 0)
    if (target.getTime() <= now.getTime()) {
        target.setDate(target.getDate() + 1)
    }
    return target.getTime()
}

const dateLabel = (now: Date): string =>
    new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(now)

export class DigestRuntime {
    #report: DigestReport
    #timer: NodeJS.Timeout | null = null
    #inFlight: Promise<DigestReport> | null = null
    #stopped = false

    constructor(
        private readonly ctx: Context,
        private readonly config: Config,
        private readonly deps: DigestDeps
    ) {
        this.#report = config.enableDailyDigest
            ? emptyDigestReport('idle', '等待触发时刻')
            : emptyDigestReport('disabled', '每日记忆动态未启用')
    }

    get report(): DigestReport {
        return this.#report
    }

    start(): void {
        if (this.#stopped) return
        if (!this.config.enableDailyDigest) return
        const parsed = parseDigestTime(this.config.digestTime)
        if (parsed === null) {
            this.#report = emptyDigestReport(
                'failed',
                `digestTime 格式非法：${this.config.digestTime}（应为 HH:mm）`
            )
            this.deps.logger.warn(
                `每日记忆动态：digestTime 格式非法（${this.config.digestTime}），定时发布已挂起`
            )
            return
        }
        this.ctx.on('dispose', () => this.stop())
        this.#schedule(parsed)
    }

    stop(): void {
        this.#stopped = true
        if (this.#timer !== null) {
            clearTimeout(this.#timer)
            this.#timer = null
        }
    }

    async runOnce(trigger: 'timer' | 'manual'): Promise<DigestReport> {
        if (this.#inFlight !== null) {
            this.deps.logger.warn('每日记忆动态：上一次执行仍在进行，跳过本次触发')
            return this.#report
        }
        const task = this.#execute(trigger)
        this.#inFlight = task
        try {
            return await task
        } finally {
            this.#inFlight = null
        }
    }

    #schedule(parsed: { hour: number; minute: number }): void {
        const now = this.deps.now()
        const at = nextTriggerAt(now, parsed.hour, parsed.minute)
        this.#report = {
            ...this.#report,
            phase: 'idle',
            nextRunAt: new Date(at).toISOString()
        }
        const delay = at - now.getTime()
        this.#timer = setTimeout(() => {
            void this.runOnce('timer')
                .catch((error) => {
                    this.deps.logger.error(
                        `每日记忆动态执行异常：${errorText(error)}`
                    )
                })
                .finally(() => {
                    this.#timer = null
                    if (!this.#stopped) this.#schedule(parsed)
                })
        }, Math.max(delay, MINUTE_MS))
        this.#timer.unref?.()
        this.deps.logger.info(
            `每日记忆动态：已排期，下次触发 ${new Date(at).toLocaleString('zh-CN')}`
        )
    }

    async #execute(trigger: 'timer' | 'manual'): Promise<DigestReport> {
        const startedAt = this.deps.now()
        this.#report = { ...this.#report, phase: 'running', detail: '正在汇总当日记忆' }
        try {
            const presetId = this.config.personaPresetId.trim()
            if (presetId.length === 0) {
                return this.#finish(
                    'suspended',
                    '未配置 personaPresetId，每日记忆动态挂起',
                    startedAt
                )
            }
            const model = isModelConfigured(this.config.mainModel)
                ? await this.deps.resolveModel(this.config.mainModel.trim())
                : null
            if (model === null) {
                return this.#finish(
                    'suspended',
                    '未配置可用的 mainModel，每日记忆动态挂起',
                    startedAt
                )
            }
            const memory = await readTodayMemories(
                this.ctx,
                presetId,
                this.config.digestMemoryLimit,
                startedAt
            )
            if (!memory.serviceAvailable) {
                return this.#finish(
                    'suspended',
                    '未安装记忆插件（chatluna-memory 或 chatluna-livingmemory），' +
                        '每日记忆动态挂起',
                    startedAt
                )
            }
            if (this.config.debug && memory.pluginName !== null) {
                this.deps.logger.info(
                    `[每日记忆动态] 记忆来源插件：${memory.pluginName}`
                )
            }
            if (memory.memories.length === 0) {
                this.deps.logger.info('每日记忆动态：当日没有记忆，本次跳过')
                return this.#finish('skipped', '当日没有记忆，已跳过', startedAt, 0)
            }
            const persona = await this.deps.renderPersona(presetId)
            const prompt = buildDigestPrompt({
                assistantLabel: this.config.personaPresetId,
                persona,
                memories: memory.memories,
                dateLabel: dateLabel(startedAt),
                promptTask: this.config.promptDigestTask,
                promptVoice: this.config.promptDigestVoice,
                promptSystem: this.config.promptSystemDigest
            })
            const decision = await generateDigestDecision(model, prompt, {
                onDiagnostic: (stage, detail) => {
                    if (!this.config.debug) return
                    this.deps.logger.info(
                        `[每日记忆动态/${stage}] ${detail}`
                    )
                }
            })
            if (decision.value === null) {
                this.deps.logger.warn(
                    `每日记忆动态：模型未产出有效结果（${decision.error ?? '未知原因'}）`
                )
                return this.#finish(
                    'failed',
                    `模型未产出有效结果：${decision.error ?? '未知原因'}`,
                    startedAt,
                    memory.memories.length
                )
            }
            if (!decision.value.publish) {
                this.deps.logger.info('每日记忆动态：模型判定今日无适合公开的内容，已跳过')
                return this.#finish(
                    'skipped',
                    '模型判定今日无适合公开的内容，已跳过',
                    startedAt,
                    memory.memories.length
                )
            }
            const published = await publishQzonePost(this.ctx, {
                content: decision.value.content,
                imageUrls: [],
                debug: this.config.debug
            })
            if (!published.ok) {
                this.deps.logger.warn(`每日记忆动态：${published.text}`)
                return this.#finish(
                    'failed',
                    published.text,
                    startedAt,
                    memory.memories.length
                )
            }
            this.deps.logger.info(`每日记忆动态：${published.text}`)
            return this.#finish(
                'published',
                `已发布（${trigger === 'manual' ? '手动' : '定时'}）：${published.text}`,
                startedAt,
                memory.memories.length,
                published.outcome
            )
        } catch (error) {
            this.deps.logger.error(
                `每日记忆动态执行失败：${errorText(error)}`
            )
            return this.#finish(
                'failed',
                `执行失败：${errorText(error)}`,
                startedAt
            )
        }
    }

    #finish(
        phase: DigestReport['phase'],
        detail: string,
        startedAt: Date,
        memoryCount = this.#report.memoryCount,
        lastOutcome: string | null = this.#report.lastOutcome
    ): DigestReport {
        this.#report = {
            phase,
            detail,
            lastRunAt: startedAt.toISOString(),
            nextRunAt: this.#report.nextRunAt,
            lastOutcome,
            memoryCount
        }
        return this.#report
    }
}

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)
