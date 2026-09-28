import type { BaseMessage } from '@langchain/core/messages'
import type { ComputedRef } from '@vue/reactivity'
import type {} from 'koishi'
import type { Context } from 'koishi'

export const IMAGE_INPUT_CAPABILITY = 'image_input'

export interface ChatLunaFileHandlingConfig {
    readonly supportedMimeTypes: ReadonlySet<string>
    readonly maxFileSizeBytes?: number
    readonly maxTotalSizeBytes?: number
    readonly maxFileSizeBytesOverrides?: Readonly<Record<string, number>>
}

export interface ChatLunaModelInfo {
    readonly capabilities?: readonly string[]
}

export type ChatLunaModelInput = unknown
export type ChatLunaModelOptions = unknown

export interface ChatLunaChatModel {
    readonly modelName?: string
    readonly modelInfo: ChatLunaModelInfo
    readonly fileHandlingConfig?: ChatLunaFileHandlingConfig | null
    invoke(
        input: ChatLunaModelInput,
        options?: ChatLunaModelOptions
    ): Promise<BaseMessage>
}

export interface ChatLunaPromptRendererLike {
    renderTemplate(
        text: string,
        variables: Record<string, unknown>
    ): Promise<{ text: string }>
    renderPresetTemplate(preset: unknown): Promise<{ messages: BaseMessage[] }>
}

export interface ChatLunaPresetLike {
    getAllPreset(loadForDisk?: boolean): ComputedRef<readonly string[]>
    getPreset(id: string, loadForDisk?: boolean): ComputedRef<unknown>
}

export interface ChatLunaLike {
    createChatModel(
        modelRef: string
    ): Promise<{ value: ChatLunaChatModel | null | undefined }>
    readonly promptRenderer: ChatLunaPromptRendererLike
    readonly preset: ChatLunaPresetLike
    readonly messageTransformer?: ChatLunaMessageTransformerLike
}

export interface ChatLunaMessageLike {
    content?: unknown
    name?: string
    conversationId?: string
    additional_kwargs?: Record<string, unknown>
}

export interface ChatLunaMessageTransformerLike {
    transform(
        session: unknown,
        elements: unknown[],
        model: string,
        message?: ChatLunaMessageLike,
        options?: { quote: boolean; includeQuoteReply: boolean }
    ): Promise<ChatLunaMessageLike>
}

export interface ChatLunaStorageLike {
    createTempFile(
        buffer: Buffer,
        filename: string,
        expireHours?: number,
        mimeType?: string
    ): Promise<{ url: string }>
}

declare module 'koishi' {
    interface Context {
        chatluna: ChatLunaLike
        chatluna_storage?: ChatLunaStorageLike
    }
}

export function base64EncodedSize(rawBytes: number): number {
    if (!Number.isFinite(rawBytes) || rawBytes <= 0) return 0
    return Math.ceil(rawBytes / 3) * 4
}

export const readChatLuna = (ctx: Context): ChatLunaLike | undefined =>
    (ctx as Context & { chatluna?: ChatLunaLike }).chatluna
