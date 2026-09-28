const GET_TEMP_TAG = 'chatlunaQzoneGetTempPatched'
const GET_TEMP_ORIGINAL = 'chatlunaQzoneGetTempOriginal'
const GET_TEMP_LISTENERS = 'chatlunaQzoneGetTempListeners'
const PUSH_DISPATCHER = 'chatlunaQzonePushDispatcher'

const ns = (prefix: string) => Symbol.for(`${prefix}`)

export interface TempLike {
    completionMessages?: unknown
}

export interface MessageLike {
    content?: unknown
    _getType?: () => string
    getType?: () => string
}

export const isAiMessage = (message: unknown): boolean => {
    if (message == null || typeof message !== 'object') return false
    const record = message as MessageLike
    try {
        const type =
            typeof record._getType === 'function'
                ? record._getType()
                : typeof record.getType === 'function'
                  ? record.getType()
                  : undefined
        return type === 'ai'
    } catch {
        return false
    }
}

export const extractAssistantText = (message: unknown): string => {
    const content = (message as MessageLike)?.content
    if (typeof content === 'string') return content.trim()
    if (!Array.isArray(content)) return ''
    return content
        .map((part) => {
            if (part == null || typeof part !== 'object') return ''
            const record = part as { type?: string; text?: string }
            return record.type === 'text' ? (record.text ?? '') : ''
        })
        .join('')
        .trim()
}

export interface GetTempListener {
    (temp: TempLike, session: unknown): void
}

export function registerGetTempListener(
    service: Record<PropertyKey, unknown>,
    listener: GetTempListener,
    resolveSession: (args: unknown[]) => unknown
): (() => void) | null {
    const getTemp = service['getTemp']
    if (typeof getTemp !== 'function') return null
    const tagKey = ns(GET_TEMP_TAG)
    const originalKey = ns(GET_TEMP_ORIGINAL)
    const listenersKey = ns(GET_TEMP_LISTENERS)
    let listeners = service[listenersKey] as
        | Set<GetTempListener>
        | undefined
    if (!listeners) {
        listeners = new Set<GetTempListener>()
        service[listenersKey] = listeners
    }
    if (!service[tagKey]) {
        Object.defineProperty(service, originalKey, {
            value: getTemp,
            configurable: true,
            enumerable: false,
            writable: true
        })
        service['getTemp'] = async (...args: unknown[]) => {
            const original = service[originalKey] as
                | ((...inner: unknown[]) => Promise<TempLike>)
                | undefined
            const temp = await original?.apply(service, args)
            const active = service[listenersKey] as Set<GetTempListener>
            if (temp && active.size > 0) {
                const session = resolveSession(args)
                for (const handler of Array.from(active)) {
                    try {
                        handler(temp, session)
                    } catch {
                        void 0
                    }
                }
            }
            return temp
        }
        service[tagKey] = true
    }
    listeners.add(listener)
    return () => {
        const active = service[listenersKey] as Set<GetTempListener> | undefined
        active?.delete(listener)
        if (active && active.size > 0) return
        const original = service[originalKey] as unknown
        if (original && service['getTemp'] !== original) {
            service['getTemp'] = original
        }
        delete service[originalKey]
        delete service[tagKey]
        delete service[listenersKey]
    }
}

interface PushDispatcher {
    readonly messages: unknown[]
    readonly originalPush: (...items: unknown[]) => number
    readonly patchedPush: (...items: unknown[]) => number
    readonly listeners: Set<PushListener>
}

export interface AssistantResponse {
    readonly response: string
    readonly message: MessageLike
    readonly session: unknown
}

export type PushListener = (payload: AssistantResponse) => void

const dispatcherKey = ns(PUSH_DISPATCHER)

const getDispatcher = (messages: unknown[]): PushDispatcher | null =>
    (messages as unknown as Record<symbol, PushDispatcher>)[dispatcherKey] ??
    null

const setDispatcher = (
    messages: unknown[],
    dispatcher: PushDispatcher | null
): void => {
    const record = messages as unknown as Record<symbol, PushDispatcher>
    if (dispatcher === null) {
        delete record[dispatcherKey]
        return
    }
    Object.defineProperty(record, dispatcherKey, {
        value: dispatcher,
        configurable: true,
        enumerable: false,
        writable: true
    })
}

export function subscribeAssistantResponses(
    messages: unknown[],
    getSession: () => unknown,
    onResponse: PushListener,
    onListenerError?: (error: unknown) => void
): () => void {
    let dispatcher = getDispatcher(messages)
    if (dispatcher === null) {
        const listeners = new Set<PushListener>()
        const seen = new WeakSet<object>()
        const originalPush = messages.push
        const patchedPush = function patchedPush(
            this: unknown[],
            ...items: unknown[]
        ): number {
            const result = originalPush.apply(this, items)
            for (const item of items) {
                if (!isAiMessage(item)) continue
                if (typeof item === 'object' && item !== null) {
                    if (seen.has(item)) continue
                    seen.add(item)
                }
                const response = extractAssistantText(item)
                if (response.length === 0) continue
                for (const listener of Array.from(listeners)) {
                    try {
                        listener({
                            response,
                            message: item as MessageLike,
                            session: getSession()
                        })
                    } catch (error) {
                        onListenerError?.(error)
                    }
                }
            }
            return result
        }
        dispatcher = {
            messages,
            originalPush,
            patchedPush,
            listeners
        }
        Object.defineProperty(messages, 'push', {
            value: patchedPush,
            configurable: true,
            enumerable: false,
            writable: true
        })
        setDispatcher(messages, dispatcher)
    }
    const listener: PushListener = (payload) => onResponse(payload)
    dispatcher.listeners.add(listener)
    return () => {
        const current = getDispatcher(messages)
        if (current === null) return
        current.listeners.delete(listener)
        if (current.listeners.size > 0) return
        if (current.messages.push === current.patchedPush) {
            current.messages.push = current.originalPush
        }
        setDispatcher(messages, null)
    }
}
