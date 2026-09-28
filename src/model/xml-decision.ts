import { parseLikeFlag } from '../auto-interaction/decision'
import type { InteractionMode } from '../config'

const DECISION_BLOCK_TAG = 'qzone_decision'

const decodeXmlEntities = (value: string): string =>
    value
        .replace(/&lt;/gu, '<')
        .replace(/&gt;/gu, '>')
        .replace(/&quot;/gu, '"')
        .replace(/&apos;/gu, "'")
        .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) =>
            String.fromCodePoint(Number.parseInt(hex, 16))
        )
        .replace(/&#(\d+);/gu, (_, code: string) =>
            String.fromCodePoint(Number(code))
        )
        .replace(/&amp;/gu, '&')

const findClosingTagIndex = (
    text: string,
    tag: string,
    from: number
): number => {
    const lower = text.toLowerCase()
    const needle = `</${tag}>`
    let index = lower.indexOf(needle, from)
    while (index !== -1) {
        if (text[index - 1] !== '/' || text[index - 2] !== '<') return index
        index = lower.indexOf(needle, index + 1)
    }
    return -1
}

export const readTag = (
    text: string,
    tag: string
): { value: string; found: boolean } => {
    const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'iu')
    const match = open.exec(text)
    if (match === null) return { value: '', found: false }
    const start = match.index + match[0].length
    const closeIndex = findClosingTagIndex(text, tag, start)
    if (closeIndex === -1) return { value: '', found: false }
    return {
        value: decodeXmlEntities(text.slice(start, closeIndex).trim()),
        found: true
    }
}

const stripCodeFences = (text: string): string =>
    text.replace(/```[a-z]*\n?/giu, '')

export function extractDecisionBlock(
    text: string,
    tagName: string = DECISION_BLOCK_TAG
): string | null {
    const source = stripCodeFences(text)
    const lower = source.toLowerCase()
    const closeTag = `</${tagName}>`
    const closeIndex = lower.lastIndexOf(closeTag)
    if (closeIndex === -1) return null
    const scanner = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, 'giu')
    let openIndex = -1
    let match: RegExpExecArray | null
    while ((match = scanner.exec(source)) !== null) {
        if (match.index >= closeIndex) break
        openIndex = match.index
    }
    if (openIndex === -1) return null
    return source.slice(openIndex, closeIndex + closeTag.length)
}

export interface XmlDecision {
    readonly action?: 'publish' | 'skip'
    readonly like?: boolean
    readonly content: string
}

export interface XmlDecisionParseResult {
    readonly value: XmlDecision | null
    readonly error: string | null
}

export function parseXmlDecision(
    text: string,
    needsContent: boolean
): XmlDecisionParseResult {
    const block = extractDecisionBlock(text)
    if (block === null) {
        return { value: null, error: `未找到 <${DECISION_BLOCK_TAG}> 契约块` }
    }
    const actionRaw = readTag(block, 'action')
    const likeRaw = readTag(block, 'like')
    const content = readTag(block, 'content')
    let action: 'publish' | 'skip' | undefined
    if (actionRaw.found) {
        const normalized = actionRaw.value.trim().toLowerCase()
        if (normalized !== 'publish' && normalized !== 'skip') {
            return {
                value: null,
                error: `<action> 只能是 publish 或 skip，当前为 ${actionRaw.value}`
            }
        }
        action = normalized
    }
    let like: boolean | undefined
    if (likeRaw.found) {
        const parsed = parseLikeFlag(likeRaw.value)
        if (parsed === null) {
            return {
                value: null,
                error: `<like> 只能是 true 或 false，当前为 ${likeRaw.value}`
            }
        }
        like = parsed
    }
    if (content.found && content.value.trim().length > 0) {
        return { value: { action, like, content: content.value }, error: null }
    }
    if (!needsContent) {
        return { value: { action, like, content: '' }, error: null }
    }
    if (action === 'skip') {
        return { value: { action, like, content: '' }, error: null }
    }
    return { value: null, error: '缺少 <content> 标签或其内容为空' }
}

export const buildDecisionContract = (policy: {
    readonly commentMode: InteractionMode
    readonly likeMode: InteractionMode
}): string => {
    const wantsContent = policy.commentMode !== 'off'
    const canSkip = policy.commentMode === 'decide'
    const canDecideLike = policy.likeMode === 'decide'
    const lines: string[] = [
        `你必须输出且只输出一个 <${DECISION_BLOCK_TAG}> 契约块，不要输出任何其他内容。`,
        '契约块格式如下，尖括号标签必须原样出现：',
        `<${DECISION_BLOCK_TAG}>`
    ]
    if (canSkip) {
        lines.push('<action>publish 或 skip</action>')
    }
    if (canDecideLike) {
        lines.push('<like>true 或 false</like>')
    }
    if (wantsContent) {
        lines.push('<content>要公开写入的完整正文</content>')
    }
    lines.push(`</${DECISION_BLOCK_TAG}>`)
    lines.push('规则：')
    const rules: string[] = []
    if (canSkip) {
        rules.push(
            '先判断这条动态是否值得评论。值得就填 publish，不值得填 skip 并省略 content。'
        )
    } else if (wantsContent) {
        rules.push('本次互动必须产出评论，不存在跳过选项，content 填完整正文。')
    }
    if (canDecideLike) {
        rules.push('判断是否要点赞，值得就填 true，否则填 false。')
    }
    if (wantsContent) {
        rules.push(
            'content 内部可以正常换行；其中的 & < > 必须写成 &amp; &lt; &gt;。'
        )
    }
    rules.push('不要使用 Markdown 标题、列表、加粗或代码块标记。')
    rules.push('不要输出思考过程，不要解释，不要复述本契约。')
    lines.push(...rules.map((rule, index) => `${index + 1}. ${rule}`))
    return lines.join('\n')
}
