
export const escapeXmlText = (value: string): string =>
    value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')

export const formatXmlBlock = (name: string, value: string): string[] => [
    `<${name}>`,
    escapeXmlText(value),
    `</${name}>`
]
