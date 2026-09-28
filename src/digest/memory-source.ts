import type { Context } from 'koishi'

export interface DigestMemory {
    readonly id: string
    readonly type: string
    readonly content: string
    readonly createdAt: Date
}

interface MemoryEntryLike {
    id?: unknown
    type?: unknown
    content?: unknown
    createdAt?: unknown
}

interface MemoryServiceLike {
    listMemories(query: {
        presetId: string
        status?: string
        page?: number
        pageSize?: number
    }): Promise<{ items?: MemoryEntryLike[] }>
}

export interface MemoryProvider {
    readonly service: MemoryServiceLike
    readonly pluginName: string
}

const MEMORY_SERVICE_CANDIDATES: readonly {
    readonly property: string
    readonly pluginName: string
}[] = [
    { property: 'chatluna_memory', pluginName: 'chatluna-memory' },
    {
        property: 'chatluna_living_memory',
        pluginName: 'chatluna-livingmemory'
    }
]

const toDate = (value: unknown): Date | null => {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value
    }
    if (typeof value === 'string' || typeof value === 'number') {
        const parsed = new Date(value)
        return Number.isNaN(parsed.getTime()) ? null : parsed
    }
    return null
}

const toMemory = (entry: MemoryEntryLike): DigestMemory | null => {
    const content = typeof entry.content === 'string' ? entry.content : ''
    const createdAt = toDate(entry.createdAt)
    if (createdAt === null) return null
    return {
        id: typeof entry.id === 'string' ? entry.id : '',
        type: typeof entry.type === 'string' ? entry.type : 'other',
        content: content.trim(),
        createdAt
    }
}

export const readMemoryProvider = (ctx: Context): MemoryProvider | null => {
    const holder = ctx as unknown as Record<string, unknown>
    for (const { property, pluginName } of MEMORY_SERVICE_CANDIDATES) {
        const candidate = holder[property]
        if (candidate == null) continue
        const service = candidate as Partial<MemoryServiceLike>
        if (typeof service.listMemories === 'function') {
            return { service: service as MemoryServiceLike, pluginName }
        }
    }
    return null
}

export const readMemoryService = (ctx: Context): MemoryServiceLike | null =>
    readMemoryProvider(ctx)?.service ?? null

const DAY_MS = 24 * 60 * 60 * 1000

export const startOfLocalDay = (now: Date): number =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

export async function readTodayMemories(
    ctx: Context,
    presetId: string,
    limit: number,
    now: Date
): Promise<{
    memories: DigestMemory[]
    serviceAvailable: boolean
    pluginName: string | null
}> {
    const provider = readMemoryProvider(ctx)
    if (provider === null) {
        return { memories: [], serviceAvailable: false, pluginName: null }
    }
    const since = startOfLocalDay(now)
    const until = since + DAY_MS
    const pageSize = Math.min(1000, Math.max(limit * 5, 200))
    const result = await provider.service.listMemories({
        presetId,
        status: 'active',
        page: 1,
        pageSize
    })
    const entries = Array.isArray(result?.items) ? result.items : []
    const memories: DigestMemory[] = []
    for (const entry of entries) {
        const memory = toMemory(entry)
        if (memory === null) continue
        if (memory.content.length === 0) continue
        const at = memory.createdAt.getTime()
        if (at < since || at >= until) continue
        memories.push(memory)
    }
    memories.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
    return {
        memories: memories.slice(-limit),
        serviceAvailable: true,
        pluginName: provider.pluginName
    }
}
