import type { LivingDiaryLogger } from '../logging'

export class RebindRejectedError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'RebindRejectedError'
    }
}

export interface RebindOptions {
    readonly minIntervalSeconds: number
    readonly backoffSeconds: number
    readonly maxBackoffSeconds: number
    readonly maxConsecutiveFailures: number
    readonly nowSeconds?: () => number
    readonly logger?: LivingDiaryLogger
}

export interface RebindStats {
    readonly inFlight: boolean
    readonly disabled: boolean
    readonly consecutiveFailures: number
    readonly lastAttemptAtSeconds: number | null
    readonly lastSuccessAtSeconds: number | null
    readonly nextAllowedAtSeconds: number | null
}

export class RebindController {
    readonly #options: RebindOptions
    readonly #nowSeconds: () => number
    #inFlight: Promise<void> | null = null
    #lastAttemptAtSeconds: number | null = null
    #lastSuccessAtSeconds: number | null = null
    #consecutiveFailures = 0
    #disabled = false

    constructor(options: RebindOptions) {
        this.#options = options
        this.#nowSeconds = options.nowSeconds ?? (() => Date.now() / 1000)
    }

    attempt(action: () => Promise<void>): Promise<void> {
        if (this.#disabled) {
            throw new RebindRejectedError(
                '自动续绑已因连续失败停用，请处理登录态后重载插件'
            )
        }
        if (this.#inFlight) {
            return this.#inFlight
        }
        const nowSeconds = this.#nowSeconds()
        if (this.#lastAttemptAtSeconds !== null) {
            const wait = Math.max(
                this.#options.minIntervalSeconds,
                this.#backoffDelay()
            )
            const elapsed = nowSeconds - this.#lastAttemptAtSeconds
            if (elapsed < wait) {
                throw new RebindRejectedError(
                    `续绑触发过于频繁，请在 ${Math.ceil(wait - elapsed)} 秒后重试`
                )
            }
        }
        this.#lastAttemptAtSeconds = nowSeconds
        const task = this.#runAttempt(action)
        this.#inFlight = task
        return task
    }

    async #runAttempt(action: () => Promise<void>): Promise<void> {
        try {
            await action()
            if (this.#consecutiveFailures > 0) {
                this.#options.logger?.info('续绑：成功，自动续绑已恢复')
            }
            this.#consecutiveFailures = 0
            this.#lastSuccessAtSeconds = this.#nowSeconds()
        } catch (error) {
            this.#consecutiveFailures += 1
            if (
                this.#consecutiveFailures >=
                this.#options.maxConsecutiveFailures
            ) {
                this.#disabled = true
                this.#options.logger?.error(
                    `续绑：连续失败 ${this.#consecutiveFailures} 次，` +
                        '自动续绑已停用，请处理登录态后重载插件'
                )
            }
            throw error
        } finally {
            this.#inFlight = null
        }
    }

    stats(): RebindStats {
        let nextAllowedAtSeconds: number | null = null
        if (this.#lastAttemptAtSeconds !== null && !this.#disabled) {
            const wait = Math.max(
                this.#options.minIntervalSeconds,
                this.#backoffDelay()
            )
            nextAllowedAtSeconds = this.#lastAttemptAtSeconds + wait
        }
        return {
            inFlight: this.#inFlight !== null,
            disabled: this.#disabled,
            consecutiveFailures: this.#consecutiveFailures,
            lastAttemptAtSeconds: this.#lastAttemptAtSeconds,
            lastSuccessAtSeconds: this.#lastSuccessAtSeconds,
            nextAllowedAtSeconds
        }
    }

    reset(): void {
        this.#consecutiveFailures = 0
        this.#disabled = false
    }

    #backoffDelay(): number {
        if (this.#consecutiveFailures === 0) {
            return 0
        }
        const factor = 2 ** (this.#consecutiveFailures - 1)
        return Math.min(
            this.#options.backoffSeconds * factor,
            this.#options.maxBackoffSeconds
        )
    }
}
