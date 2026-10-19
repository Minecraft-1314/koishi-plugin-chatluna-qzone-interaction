import type { InteractionReport } from './auto-interaction/report'

function createReportSlot<T>() {
    let current: (() => T | null) | null = null
    return {
        get: (): T | null => current?.() ?? null,
        bind(read: () => T | null): () => void {
            current = read
            return () => {
                if (current === read) current = null
            }
        }
    }
}

export interface InteractionRuntimeHandle {
    dropRetry(key: string): boolean
}

export function createRuntimeReports() {
    return {
        interaction: createReportSlot<InteractionReport>(),
        interactionRuntime: createReportSlot<InteractionRuntimeHandle>()
    }
}

export type RuntimeReports = ReturnType<typeof createRuntimeReports>
