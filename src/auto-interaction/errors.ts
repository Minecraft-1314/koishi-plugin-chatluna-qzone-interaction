const SNIPPET_LIMIT = 200

const ERROR_CONTEXT_KEYS = [
    'endpoint',
    'statusCode',
    'serviceCode',
    'retryCount'
] as const

export function safeStringify(value: unknown): string | null {
    try {
        return JSON.stringify(value, null, 2) ?? String(value)
    } catch {
        return null
    }
}

export function describeError(error: unknown): string {
    if (!(error instanceof Error)) return String(error)
    const parts = [`${error.name}: ${error.message}`]
    const qzone = error as Error & {
        code?: string
        context?: Record<string, unknown>
    }
    if (qzone.code) parts.push(`code=${qzone.code}`)
    const context = qzone.context
    if (context != null && typeof context === 'object') {
        for (const key of ERROR_CONTEXT_KEYS) {
            const value = context[key]
            if (value !== undefined && value !== null && value !== '') {
                parts.push(`${key}=${String(value)}`)
            }
        }
        const snippet = context.responseSnippet
        if (typeof snippet === 'string' && snippet.length > 0) {
            parts.push(
                `response=${snippet.replace(/\s+/gu, ' ').slice(0, SNIPPET_LIMIT)}`
            )
        }
    }
    return parts.join(' ')
}
