import { randomUUID } from 'node:crypto'
import { Logger } from 'koishi'
import type { BaseMessage } from '@langchain/core/messages'
import type { ChatLunaChatModel } from '../chatluna'

import type { DiagnosticSink } from '../logging'

export interface LivingDiaryLogBlock {
    readonly title: string
    readonly value: unknown
    readonly key?: string
    readonly fields?: Record<string, unknown>
}

const formatFieldValue = (value: unknown): string =>
    typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))

const formatBlockValue = (value: unknown): string =>
    typeof value === 'string'
        ? value
        : (JSON.stringify(value, null, 2) ?? String(value))

const formatBlock = (block: LivingDiaryLogBlock): string => {
    const title = block.title.replace(/\r?\n/gu, ' ')
    const fields = block.fields ?? {}
    const detail = Object.keys(fields)
        .filter((key) => fields[key] !== undefined)
        .map((key) => `${key}=${formatFieldValue(fields[key])}`)
        .join(' ')
    const heading = detail.length > 0 ? `${title} ${detail}` : title
    return `--- ${heading} ---\n${formatBlockValue(block.value)}`
}

const emitCompleteMessage = (sink: DiagnosticSink, emit: () => void): void => {
    if (!(sink instanceof Logger)) {
        emit()
        return
    }
    const targets = Logger.targets as (Logger.Target & {
        maxLength?: number
    })[]
    const originalLimits = targets.map((target) => ({
        target,
        hasOwnLimit: Object.prototype.hasOwnProperty.call(target, 'maxLength'),
        maxLength: target.maxLength
    }))
    try {
        for (const target of targets) {
            target.maxLength = Number.POSITIVE_INFINITY
        }
        emit()
    } finally {
        for (const original of originalLimits) {
            if (original.hasOwnLimit) {
                original.target.maxLength = original.maxLength
            } else {
                delete original.target.maxLength
            }
        }
    }
}

export const emitDiagnostic = (
    sink: DiagnosticSink,
    event: string,
    fields: Record<string, unknown>,
    blocks:
        readonly LivingDiaryLogBlock[] | (() => readonly LivingDiaryLogBlock[])
): void => {
    try {
        const detail = Object.keys(fields)
            .filter((key) => fields[key] !== undefined)
            .map((key) => `${key}=${formatFieldValue(fields[key])}`)
            .join(' ')
        const heading =
            detail.length > 0 ? `event=${event} ${detail}` : `event=${event}`
        const resolved = typeof blocks === 'function' ? blocks() : blocks
        const message =
            resolved.length === 0
                ? heading
                : [
                      heading,
                      ...resolved.map(formatBlock),
                      `--- end ${event} ---`
                  ].join('\n')
        emitCompleteMessage(sink, () => sink.info(message))
    } catch (error) {
        sink.warn(`debug 日志输出失败（${event}）：${(error as Error).message}`)
    }
}

const messageType = (message: BaseMessage): string => {
    try {
        return message._getType()
    } catch {
        return message.constructor.name
    }
}

interface NormalizedMessage {
    readonly role: string
    readonly content: BaseMessage['content']
    readonly name?: unknown
    readonly toolCalls?: unknown
    readonly invalidToolCalls?: unknown
    readonly toolCallId?: unknown
}

const normalizeMessage = (message: BaseMessage): NormalizedMessage => {
    const candidate = message as BaseMessage & {
        name?: unknown
        tool_calls?: unknown
        invalid_tool_calls?: unknown
        tool_call_id?: unknown
    }
    return {
        role: messageType(message),
        name: candidate.name,
        content: message.content,
        toolCalls:
            candidate.tool_calls ?? message.additional_kwargs?.tool_calls,
        invalidToolCalls: candidate.invalid_tool_calls,
        toolCallId: candidate.tool_call_id
    }
}

const toMessages = (input: unknown): NormalizedMessage[] => {
    if (typeof input === 'string') {
        return [{ role: 'text', content: input }]
    }
    const messages: readonly BaseMessage[] = Array.isArray(input)
        ? (input as BaseMessage[])
        : (input as { toChatMessages(): BaseMessage[] }).toChatMessages()
    return messages.map(normalizeMessage)
}

const toPromptBlocks = (input: unknown): LivingDiaryLogBlock[] => {
    const blocks: LivingDiaryLogBlock[] = []
    for (const [index, message] of toMessages(input).entries()) {
        blocks.push({
            title: `message[${index}]`,
            fields: {
                role: message.role,
                name: message.name,
                toolCallId: message.toolCallId
            },
            key: 'content',
            value: stringifyPromptContent(message.content)
        })
        if (message.toolCalls !== undefined) {
            blocks.push({
                title: `message[${index}].toolCalls`,
                key: 'toolCalls',
                value: message.toolCalls
            })
        }
        if (message.invalidToolCalls !== undefined) {
            blocks.push({
                title: `message[${index}].invalidToolCalls`,
                key: 'invalidToolCalls',
                value: message.invalidToolCalls
            })
        }
    }
    return blocks
}

const stringifyPromptContent = (content: BaseMessage['content']): string => {
    if (typeof content === 'string') return content
    return content
        .map((part) => {
            if (part == null || typeof part !== 'object') {
                return part == null ? '' : String(part)
            }
            const record = part as Record<string, unknown>
            if (record.type === 'text' && typeof record.text === 'string') {
                return record.text
            }
            if (record.type === 'image_url') {
                const url = (record.image_url as { url?: unknown })?.url
                return typeof url === 'string'
                    ? `[image_url: ${url}]`
                    : (JSON.stringify(part) ?? '')
            }
            return JSON.stringify(part) ?? ''
        })
        .filter((section) => section.length > 0)
        .join('\n')
}

const stringifyModelContent = (content: BaseMessage['content']): string => {
    if (typeof content === 'string') {
        return content
    }
    if (Array.isArray(content)) {
        return content
            .map((part) =>
                part != null &&
                typeof part === 'object' &&
                (part as Record<string, unknown>).type === 'text' &&
                typeof (part as Record<string, unknown>).text === 'string'
                    ? (part as { text: string }).text
                    : ''
            )
            .join('')
    }
    return JSON.stringify(content) ?? ''
}

const toResponseBlocks = (
    response: BaseMessage,
    logResponseText: boolean
): LivingDiaryLogBlock[] => {
    const message = normalizeMessage(response)
    const text = stringifyModelContent(message.content)
    const blocks: LivingDiaryLogBlock[] = []
    if (logResponseText && text.length > 0) {
        blocks.push({ title: 'response.text', key: 'text', value: text })
    }
    if (
        message.toolCalls !== undefined &&
        (!Array.isArray(message.toolCalls) || message.toolCalls.length > 0)
    ) {
        blocks.push({
            title: 'response.tool_calls',
            key: 'tool_calls',
            value: message.toolCalls
        })
    }
    if (logResponseText && blocks.length === 0) {
        blocks.push({ title: 'response.text', key: 'text', value: text })
    }
    return blocks
}

const summarizeError = (error: unknown): string =>
    error instanceof Error ? `${error.name}: ${error.message}` : String(error)

export interface LoggedModelContext {
    readonly sink: DiagnosticSink
    readonly stage: string
    readonly attempt?: number | (() => number)
    readonly fields?: Record<string, unknown>
    readonly promptLogging?: 'all' | 'first' | 'none'
    readonly logResponseText?: boolean
}

const invokeLogged = async (
    runnable: Pick<ChatLunaChatModel, 'invoke'>,
    modelName: string | undefined,
    input: Parameters<ChatLunaChatModel['invoke']>[0],
    runConfig: Parameters<ChatLunaChatModel['invoke']>[1],
    context: LoggedModelContext
): Promise<BaseMessage> => {
    const attempt =
        typeof context.attempt === 'function'
            ? context.attempt()
            : context.attempt
    const fields = {
        ...context.fields,
        modelCallId: randomUUID(),
        stage: context.stage,
        ...(attempt !== undefined ? { attempt } : {}),
        model: modelName
    }
    const promptLogging = context.promptLogging ?? 'all'
    const logPrompt =
        promptLogging === 'all' || (promptLogging === 'first' && attempt === 1)
    if (logPrompt) {
        emitDiagnostic(context.sink, 'model.prompt', fields, () =>
            toPromptBlocks(input)
        )
    }
    try {
        const response = await runnable.invoke(input, runConfig)
        emitDiagnostic(context.sink, 'model.response', fields, () =>
            toResponseBlocks(response, context.logResponseText ?? true)
        )
        return response
    } catch (error) {
        emitDiagnostic(
            context.sink,
            'model.failed',
            { ...fields, error: summarizeError(error) },
            []
        )
        throw error
    }
}

export const invokeModelLogged = async (
    model: ChatLunaChatModel,
    input: Parameters<ChatLunaChatModel['invoke']>[0],
    runConfig: Parameters<ChatLunaChatModel['invoke']>[1],
    context: LoggedModelContext
): Promise<BaseMessage> =>
    invokeLogged(model, model.modelName, input, runConfig, context)
