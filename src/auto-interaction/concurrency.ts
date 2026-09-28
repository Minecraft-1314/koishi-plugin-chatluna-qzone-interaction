export const DEFAULT_CONCURRENCY = 4

export interface MapOutcome<T> {
    readonly index: number
    readonly ok: boolean
    readonly value?: T
    readonly error?: unknown
}

export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    worker: (item: T, index: number) => Promise<R>,
    limit: number = DEFAULT_CONCURRENCY
): Promise<MapOutcome<R>[]> {
    const results: MapOutcome<R>[] = new Array(items.length)
    if (items.length === 0) return results
    const width = Math.max(1, Math.min(limit, items.length))
    let cursor = 0
    const runners = Array.from({ length: width }, async () => {
        for (;;) {
            const index = cursor
            cursor += 1
            if (index >= items.length) return
            try {
                results[index] = {
                    index,
                    ok: true,
                    value: await worker(items[index], index)
                }
            } catch (error) {
                results[index] = { index, ok: false, error }
            }
        }
    })
    await Promise.all(runners)
    return results
}
