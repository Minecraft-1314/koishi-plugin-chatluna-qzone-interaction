import {
    COOKIE_PLATFORM_LABELS,
    type CookieBot,
    type CookiePlatform,
    resolvePlatformOrder,
    selectCookieBot,
    selectCookieBotView
} from './cookie-platform'

export {
    COOKIE_PLATFORM_LABELS,
    type CookieBot,
    type CookiePlatform,
    resolvePlatformOrder,
    selectCookieBot,
    selectCookieBotView
}

export const COOKIE_DOMAIN_CANDIDATES: readonly string[] = [
    'user.qzone.qq.com',
    'qzone.qq.com',
    'h5.qzone.qq.com',
    'mobile.qzone.qq.com'
]

const UIN_CANDIDATE_KEYS: readonly string[] = [
    'uin',
    'p_uin',
    'ptui_loginuin',
    'luin'
]

const QZONE_TICKET_KEYS: readonly string[] = ['p_skey', 'skey', 'skey2']

export interface QzoneCookieGrant {
    readonly cookies: string
    readonly accountId: string
    readonly domain: string
}

export class NoBotAvailableError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'NoBotAvailableError'
    }
}

export class CookieAcquireError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'CookieAcquireError'
    }
}

export function parseCookieHeader(header: string): Record<string, string> {
    const jar: Record<string, string> = {}
    for (const segment of header.split(';')) {
        const index = segment.indexOf('=')
        if (index <= 0) continue
        const name = segment.slice(0, index).trim()
        if (!name) continue
        jar[name] = segment.slice(index + 1).trim()
    }
    return jar
}

export function extractUin(
    jar: Readonly<Record<string, string>>
): string | null {
    for (const key of UIN_CANDIDATE_KEYS) {
        const raw = jar[key]
        if (!raw) continue
        const cleaned = raw.trim().replace(/^[oO]+/u, '')
        if (/^\d+$/u.test(cleaned)) return cleaned
    }
    return null
}

export function hasQzoneTicket(jar: Readonly<Record<string, string>>): boolean {
    return QZONE_TICKET_KEYS.some((key) => Boolean(jar[key]))
}

export function describePlatformOrder(
    order: readonly CookiePlatform[]
): string {
    return order.map((item) => COOKIE_PLATFORM_LABELS[item]).join(' → ')
}

export async function acquireQzoneCookies(
    bot: CookieBot
): Promise<QzoneCookieGrant> {
    const label = COOKIE_PLATFORM_LABELS[bot.platform]
    const failures: string[] = []
    let loginUinResolved = false
    let loginUin: string | null = null
    for (const domain of COOKIE_DOMAIN_CANDIDATES) {
        let header: string
        try {
            header = await bot.getCookieHeader(domain)
        } catch (error) {
            failures.push(
                `${domain}：${error instanceof Error ? error.message : String(error)}`
            )
            continue
        }
        const jar = parseCookieHeader(header ?? '')
        if (!hasQzoneTicket(jar)) {
            failures.push(`${domain}：Cookie 缺少空间票据（p_skey/skey/skey2）`)
            continue
        }
        let accountId = extractUin(jar)
        if (!accountId && !loginUinResolved) {
            loginUinResolved = true
            loginUin = await bot.getLoginUin()
        }
        if (!accountId) {
            accountId = loginUin
        }
        if (accountId) {
            return { cookies: header, accountId, domain }
        }
        failures.push(`${domain}：无法识别账号`)
    }
    throw new CookieAcquireError(
        `无法从 ${label} 获取可用的 QQ 空间 Cookie：${failures.join('；')}`
    )
}
