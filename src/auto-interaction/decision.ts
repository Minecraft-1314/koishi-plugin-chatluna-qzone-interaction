import { z } from 'zod'
import type { InteractionMode } from '../config'

export const interactionDecisionSchema = z.object({
    action: z.enum(['publish', 'skip']).optional(),
    like: z.boolean().optional(),
    content: z.string().optional()
})

export type InteractionDecision = z.output<
    typeof interactionDecisionSchema
>

export interface ResolvedDecision {
    readonly publish: boolean
    readonly like: boolean
    readonly content: string | null
}

export interface DecisionPolicy {
    readonly commentMode: InteractionMode
    readonly likeMode: InteractionMode
}

const LIKE_TRUE = new Set(['true', '1', 'yes', '是'])
const LIKE_FALSE = new Set(['false', '0', 'no', '否'])

export function parseLikeFlag(value: string): boolean | null {
    const normalized = value.trim().toLowerCase()
    if (LIKE_TRUE.has(normalized)) return true
    if (LIKE_FALSE.has(normalized)) return false
    return null
}

const resolvePublish = (
    input: InteractionDecision,
    content: string,
    mode: InteractionMode
): boolean => {
    if (mode === 'off') return false
    if (mode === 'forced') return true
    if (input.action === 'skip') return false
    if (input.action === 'publish') return true
    return content.length > 0
}

const resolveLike = (
    input: InteractionDecision,
    mode: InteractionMode
): boolean => {
    if (mode === 'off') return false
    if (mode === 'forced') return true
    return input.like === true
}

export function resolveDecision(
    raw: unknown,
    policy: DecisionPolicy
): { value: ResolvedDecision | null; error: string | null } {
    const parsed = interactionDecisionSchema.safeParse(raw)
    if (!parsed.success) {
        return { value: null, error: '结构化参数无效' }
    }
    const content = (parsed.data.content ?? '').trim()
    const publish = resolvePublish(parsed.data, content, policy.commentMode)
    if (publish && content.length === 0) {
        return {
            value: null,
            error: '需要发布评论时 content 不能为空'
        }
    }
    return {
        value: {
            publish,
            like: resolveLike(parsed.data, policy.likeMode),
            content: publish ? content : null
        },
        error: null
    }
}
