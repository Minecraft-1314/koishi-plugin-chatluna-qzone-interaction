export type DigestPhase =
    | 'disabled'
    | 'suspended'
    | 'idle'
    | 'running'
    | 'published'
    | 'skipped'
    | 'failed'

export interface DigestReport {
    readonly phase: DigestPhase
    readonly detail: string
    readonly lastRunAt: string | null
    readonly nextRunAt: string | null
    readonly lastOutcome: string | null
    readonly memoryCount: number
}

export const emptyDigestReport = (
    phase: DigestPhase,
    detail: string
): DigestReport => ({
    phase,
    detail,
    lastRunAt: null,
    nextRunAt: null,
    lastOutcome: null,
    memoryCount: 0
})
