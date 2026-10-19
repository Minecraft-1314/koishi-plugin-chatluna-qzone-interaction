const MAX_CODE_POINT = 0x10ffff

const safeFromCodePoint = (code: number): string => {
    if (!Number.isFinite(code) || code < 0 || code > MAX_CODE_POINT) return ''
    try {
        return String.fromCodePoint(code)
    } catch {
        return ''
    }
}

export const escapeXmlText = (value: string): string =>
    value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')

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

export const formatXmlBlock = (name: string, value: string): string[] => [
    `<${name}>`,
    escapeXmlText(value),
    `</${name}>`
]
