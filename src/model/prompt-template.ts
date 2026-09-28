const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu

export const renderPromptTemplate = (
    template: string,
    values: Readonly<Record<string, string>>
): string => {
    return template.replace(
        PLACEHOLDER_PATTERN,
        (whole, key: string) => {
            const value = values[key]
            return value === undefined ? '' : value
        }
    )
}

export const templateHasPlaceholder = (
    template: string,
    key: string
): boolean => {
    PLACEHOLDER_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = PLACEHOLDER_PATTERN.exec(template)) !== null) {
        if (match[1] === key) return true
    }
    return false
}

export interface SectionSpec {
    readonly key: string
    readonly tag: string
    readonly value: string
}

export const appendMissingSections = (
    rendered: string,
    template: string,
    sections: readonly SectionSpec[]
): string => {
    const extra = sections.filter(
        (section) =>
            section.value.trim().length > 0 &&
            !templateHasPlaceholder(template, section.key)
    )
    if (extra.length === 0) return rendered
    const blocks = extra.map((section) =>
        [
            '<' + section.tag + '>',
            section.value.trim(),
            '</' + section.tag + '>'
        ].join('\n')
    )
    return [rendered.trimEnd(), ...blocks].join('\n\n')
}
