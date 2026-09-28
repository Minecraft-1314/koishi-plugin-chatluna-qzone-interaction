import type { Context } from 'koishi'
import type { ChatLunaChatModel } from '../chatluna'
import type { DiagnosticSink } from '../logging'
import type { DecisionPolicy } from './decision'
import type { PreparedInteractionMedia } from './media'
import type { InteractionPrompt } from './prompt'
import {
    decideInteractionActionXml,
    type XmlDecisionOutcome
} from './xml-decider'

export type InteractionDecisionOutcome = XmlDecisionOutcome

export interface InteractionDecisionDeps {
    readonly ctx: Context
    readonly model: ChatLunaChatModel
    readonly prompt: InteractionPrompt
    readonly media: PreparedInteractionMedia
    readonly postId: string
    readonly policy: DecisionPolicy
    readonly signal?: AbortSignal
    readonly debugSink?: DiagnosticSink | null
}

export async function decideInteractionAction(
    deps: InteractionDecisionDeps
): Promise<InteractionDecisionOutcome> {
    return decideInteractionActionXml({
        model: deps.model,
        prompt: deps.prompt,
        signal: deps.signal,
        debugSink: deps.debugSink ?? null,
        postId: deps.postId,
        policy: deps.policy
    })
}
