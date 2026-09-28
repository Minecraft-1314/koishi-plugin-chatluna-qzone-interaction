import { h } from 'koishi'
import type { Context } from 'koishi'
import type { BaseMessage } from '@langchain/core/messages'
import { readChatLuna } from '../chatluna'
import { mapWithConcurrency } from './concurrency'

export interface DescribedMedia {
    readonly text: string
    readonly images: BaseMessage['content']
}

const EMPTY: DescribedMedia = { text: '', images: [] }
const DESCRIBE_CONCURRENCY = 3
const DESCRIBE_TIMEOUT_MS = 30000

const withTimeout = async <T>(task: Promise<T>, ms: number): Promise<T> => {
    let timer: NodeJS.Timeout | undefined
    try {
        return await Promise.race([
            task,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error('图片描述超时')),
                    ms
                )
                timer.unref?.()
            })
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

export function canDescribeWithTransformer(ctx: Context): boolean {
    return readChatLuna(ctx)?.messageTransformer != null
}

export async function describeMedia(
    ctx: Context,
    urls: readonly string[],
    model: string
): Promise<DescribedMedia[]> {
    const chatluna = readChatLuna(ctx)
    const transformer = chatluna?.messageTransformer
    if (!transformer || urls.length === 0) {
        return urls.map(() => EMPTY)
    }
    const session = {
        username: 'livingdiary'
    } as unknown as Parameters<
        NonNullable<typeof transformer>['transform']
    >[0]
    const outcomes = await mapWithConcurrency(
        urls,
        async (url) => {
            if (!url) return EMPTY
            const message = await withTimeout(
                transformer.transform(
                    session,
                    [h('img', { url })],
                    model,
                    { content: '', name: 'livingdiary', additional_kwargs: {} },
                    { quote: false, includeQuoteReply: false }
                ),
                DESCRIBE_TIMEOUT_MS
            )
            return splitContent(message.content)
        },
        DESCRIBE_CONCURRENCY
    )
    return outcomes.map((outcome) =>
        outcome.ok ? (outcome.value ?? EMPTY) : EMPTY
    )
}

const splitContent = (content: unknown): DescribedMedia => {
    if (typeof content === 'string') {
        const text = content.trim()
        return text.length > 0 ? { text, images: [] } : EMPTY
    }
    if (!Array.isArray(content)) return EMPTY
    let text = ''
    const images: NonNullable<BaseMessage['content']> = []
    for (const part of content) {
        if (part == null || typeof part !== 'object') continue
        const record = part as { type?: string; text?: string }
        if (record.type === 'text' && typeof record.text === 'string') {
            text += record.text
        } else if (record.type === 'image_url') {
            images.push(part as never)
        }
    }
    const trimmed = text.trim()
    return trimmed.length > 0 || images.length > 0
        ? { text: trimmed, images }
        : EMPTY
}
