import {
    AIMessage,
    HumanMessage,
    SystemMessage
} from '@langchain/core/messages'
import type { ChatLunaChatModel } from '../chatluna'
import type { DiagnosticSink } from '../logging'
import { invokeModelLogged } from '../model/logging'
import { buildDecisionContract, parseXmlDecision } from '../model/xml-decision'
import {
    type DecisionPolicy,
    resolveDecision,
    type ResolvedDecision
} from './decision'
import type { InteractionPrompt } from './prompt'

export const XML_DECISION_MAX_ATTEMPTS = 3

export interface XmlDecisionOutcome {
    readonly value: ResolvedDecision | null
    readonly error: string | null
}

export interface XmlDeciderDeps {
    readonly model: ChatLunaChatModel
    readonly prompt: InteractionPrompt
    readonly signal?: AbortSignal
    readonly maxAttempts?: number
    readonly debugSink?: DiagnosticSink | null
    readonly postId?: string
    readonly policy: DecisionPolicy
}

const messageText = (message: { content: unknown }): string => {
    const { content } = message
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
        return content
            .map((part) =>
                part != null &&
                typeof part === 'object' &&
                (part as { type?: string }).type === 'text'
                    ? ((part as { text?: string }).text ?? '')
                    : ''
            )
            .join('')
    }
    return content == null ? '' : JSON.stringify(content)
}

const buildRetryMessage = (error: string, contract: string): string =>
    `上一次输出不符合契约：${error}。` +
    '请重新输出一个完整的 <qzone_decision> 契约块，不要输出其他任何内容。\n' +
    contract

export async function decideInteractionActionXml(
    deps: XmlDeciderDeps
): Promise<XmlDecisionOutcome> {
    if (deps.signal?.aborted) {
        throw deps.signal.reason ?? new Error('自动互动已停止')
    }
    const maxAttempts = deps.maxAttempts ?? XML_DECISION_MAX_ATTEMPTS
    const needsContent = deps.policy.commentMode !== 'off'
    const contract = buildDecisionContract(deps.policy)
    const messages: (SystemMessage | HumanMessage | AIMessage)[] = [
        new SystemMessage(deps.prompt.systemPrompt),
        deps.prompt.inputMessage
    ]
    let lastError = '未获得有效决策'

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        deps.signal?.throwIfAborted()
        let text: string
        try {
            const response =
                deps.debugSink == null
                    ? await deps.model.invoke(messages as never, {
                          signal: deps.signal
                      })
                    : await invokeModelLogged(
                          deps.model,
                          messages as never,
                          { signal: deps.signal },
                          {
                              sink: deps.debugSink,
                              stage: 'interaction-xml',
                              attempt,
                              ...(deps.postId === undefined
                                  ? {}
                                  : { fields: { post: deps.postId } })
                          }
                      )
            text = messageText(response)
        } catch (error) {
            if (deps.signal?.aborted) throw error
            lastError = `模型调用失败：${(error as Error).message}`
            continue
        }
        deps.signal?.throwIfAborted()
        const parsed = parseXmlDecision(text, needsContent)
        if (parsed.value !== null) {
            const validated = resolveDecision(parsed.value, deps.policy)
            if (validated.value !== null) {
                return { value: validated.value, error: null }
            }
            lastError = validated.error ?? '决策结构无效'
        } else {
            lastError = parsed.error ?? '决策结构无效'
        }

        if (attempt < maxAttempts) {
            messages.push(new AIMessage(text))
            messages.push(
                new HumanMessage(buildRetryMessage(lastError, contract))
            )
        }
    }
    return { value: null, error: lastError }
}
