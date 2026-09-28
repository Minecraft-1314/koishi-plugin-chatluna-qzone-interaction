import { Universal } from 'koishi'
import type { BaseBot as OneBotBot } from 'koishi-plugin-adapter-onebot'

export type CookiePlatform = 'onebot' | 'milky'

export const COOKIE_PLATFORM_LABELS: Record<CookiePlatform, string> = {
    onebot: 'OneBot',
    milky: 'Milky'
}

export const resolvePlatformOrder = (
    mode: CookiePlatform | 'auto'
): readonly CookiePlatform[] =>
    mode === 'auto' ? ['onebot', 'milky'] : [mode]

export interface CookieBotView {
    readonly platform?: string
    readonly selfId: string
    readonly status: Universal.Status
}

export interface CookieBot {
    readonly platform: CookiePlatform
    readonly selfId: string
    getCookieHeader(domain: string): Promise<string>
    getLoginUin(): Promise<string | null>
}

const normalizePlatform = (
    value: string | undefined
): CookiePlatform | null => {
    const raw = (value ?? '').trim().toLowerCase()
    if (raw === 'onebot') return 'onebot'
    if (raw === 'milky') return 'milky'
    return null
}

const isOnline = (bot: CookieBotView): boolean =>
    bot.status === Universal.Status.ONLINE

export const matchesSelfId = (
    bot: CookieBotView,
    selfId: string | undefined
): boolean => {
    const target = (selfId ?? '').trim()
    return target.length === 0 || bot.selfId === target
}

export function selectCookieBotView<T extends CookieBotView>(
    bots: Iterable<T>,
    selfId: string | undefined,
    order: readonly CookiePlatform[]
): { bot: T; platform: CookiePlatform } | null {
    const candidates = [...bots]
    for (const platform of order) {
        const found = candidates.find(
            (bot) =>
                normalizePlatform(bot.platform) === platform &&
                matchesSelfId(bot, selfId) &&
                isOnline(bot)
        )
        if (found) return { bot: found, platform }
    }
    return null
}

const asHeader = (value: unknown): string | null => {
    if (typeof value === 'string') return value
    if (value == null) return null
    if (Array.isArray(value)) {
        const parts: string[] = []
        for (const item of value) {
            if (item == null || typeof item !== 'object') continue
            const record = item as { name?: unknown; value?: unknown }
            if (typeof record.name !== 'string') continue
            parts.push(record.name + '=' + String(record.value ?? ''))
        }
        return parts.length > 0 ? parts.join('; ') : null
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>
        for (const key of ['cookies', 'cookie', 'data', 'result']) {
            const inner = record[key]
            const header = asHeader(inner)
            if (header !== null) return header
        }
    }
    return null
}

type InternalLike = Record<string, unknown>

const callInternal = async (
    internal: InternalLike,
    names: readonly string[],
    args: unknown[]
): Promise<string | null> => {
    for (const name of names) {
        const fn = internal[name]
        if (typeof fn !== 'function') continue
        try {
            const result = await (fn as (...a: unknown[]) => unknown).apply(
                internal,
                args
            )
            const header = asHeader(result)
            if (header !== null) return header
        } catch {
            void 0
        }
    }
    return null
}

export const adaptOneBotCookieBot = (bot: OneBotBot): CookieBot => ({
    platform: 'onebot',
    selfId: bot.selfId,
    getCookieHeader: (domain) => bot.internal.getCookies(domain),
    getLoginUin: async () => {
        try {
            const userId = String((await bot.internal.getLoginInfo()).user_id)
            return /^\d+$/.test(userId) ? userId : null
        } catch {
            return null
        }
    }
})

export const adaptMilkyCookieBot = (
    bot: Record<string, unknown>
): CookieBot | null => {
    const internal = (bot as { internal?: InternalLike }).internal
    if (internal == null || typeof internal !== 'object') return null
    const selfId = String(bot['selfId'] ?? '')
    if (selfId.length === 0) return null
    const hasProbe =
        ['getCookies', 'get_cookies', 'getCookie', 'get_cookies_string'].some(
            (name) => typeof internal[name] === 'function'
        )
    if (!hasProbe) return null
    return {
        platform: 'milky',
        selfId,
        getCookieHeader: async (domain) => {
            const flat = await callInternal(
                internal,
                ['getCookies', 'get_cookies', 'getCookie'],
                [domain]
            )
            if (flat !== null) return flat
            const wrapped = await callInternal(
                internal,
                ['get_cookies', 'getCookies'],
                [{ domain }]
            )
            if (wrapped !== null) return wrapped
            throw new Error(
                'Milky 机器人未返回可用的 Cookie（协议端需实现 get_cookies）'
            )
        },
        getLoginUin: async () => {
            const result = await callInternal(
                internal,
                ['getLoginInfo', 'get_login_info', 'getProfile', 'get_profile'],
                [{}]
            )
            if (result === null) return null
            try {
                const record = JSON.parse(result) as Record<string, unknown>
                const uin = String(record['uin'] ?? record['user_id'] ?? '')
                return /^\d+$/.test(uin) ? uin : null
            } catch {
                return null
            }
        }
    }
}

export function adaptCookieBot(
    bot: Record<string, unknown>,
    platform: CookiePlatform
): CookieBot | null {
    if (platform === 'onebot') {
        return adaptOneBotCookieBot(bot as unknown as OneBotBot)
    }
    return adaptMilkyCookieBot(bot)
}

export function selectCookieBot(
    bots: Iterable<CookieBotView>,
    selfId: string | undefined,
    order: readonly CookiePlatform[]
): CookieBot | null {
    const selected = selectCookieBotView(bots, selfId, order)
    if (selected === null) return null
    return adaptCookieBot(
        selected.bot as unknown as Record<string, unknown>,
        selected.platform
    )
}
