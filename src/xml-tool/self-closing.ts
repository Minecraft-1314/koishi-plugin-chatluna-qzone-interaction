export const decodeXmlEntities = (value: string): string =>
    value
        .replace(/&lt;/gu, '<')
        .replace(/&gt;/gu, '>')
        .replace(/&quot;/gu, '"')
        .replace(/&apos;/gu, "'")
        .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) =>
            safeFromCodePoint(Number.parseInt(hex, 16))
        )
        .replace(/&#(\d+);/gu, (_, code: string) =>
            safeFromCodePoint(Number(code))
        )
        .replace(/&amp;/gu, '&')

const safeFromCodePoint = (code: number): string => {
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
    try {
        return String.fromCodePoint(code)
    } catch {
        return ''
    }
}

const ATTRIBUTE_PATTERN =
    /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gu

export const parseAttributes = (source: string): Record<string, string> => {
    const attributes: Record<string, string> = {}
    ATTRIBUTE_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = ATTRIBUTE_PATTERN.exec(source)) !== null) {
        const raw = match[2] ?? match[3] ?? match[4] ?? ''
        attributes[match[1]] = decodeXmlEntities(raw)
    }
    return attributes
}

const tagPattern = (tagName: string): RegExp =>
    new RegExp(`<${tagName}\\b([^>]*?)/\\s*>`, 'giu')

export function parseSelfClosingXmlTags(
    text: string,
    tagName: string
): Record<string, string>[] {
    if (typeof text !== 'string' || text.length === 0) return []
    const pattern = tagPattern(tagName)
    const results: Record<string, string>[] = []
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
        results.push(parseAttributes(match[1] ?? ''))
    }
    return results
}
