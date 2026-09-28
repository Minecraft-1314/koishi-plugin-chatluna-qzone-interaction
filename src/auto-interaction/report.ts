export type InteractionPhase =
    | 'disabled'
    | 'waiting-config'
    | 'waiting-bot'
    | 'baselining'
    | 'ready'
    | 'running'
    | 'failed'

export interface InteractionRoundStats {
    readonly discovered: number
    readonly writeAttempts: number
    readonly verified: number
    readonly accepted: number
    readonly unknown: number
    readonly incompleteSnapshots: number
    readonly feedPageLimitHits: number
    readonly likeAttempts: number
    readonly likesApplied: number
    readonly likeAlreadyApplied: number
    readonly errors: number
}

export type InteractionErrorKind =
    | 'baseline'
    | 'monitored-read'
    | 'round-read'
    | 'detail-refresh'
    | 'model-unavailable'
    | 'persona'
    | 'model-decision'
    | 'write-auth'
    | 'write'

export interface InteractionReport {
    readonly phase: InteractionPhase
    readonly detail: string
    readonly baselineCompletedAt: string | null
    readonly roundStartedAt: string | null
    readonly lastRoundAt: string | null
    readonly monitoredPosts: number
    readonly monitorLimit: number
    readonly pendingTriggers: number
    readonly maxWritesPerRound: number
    readonly round: InteractionRoundStats | null
    readonly lastError: InteractionErrorKind | null
}

export function emptyRoundStats(): InteractionRoundStats {
    return {
        discovered: 0,
        writeAttempts: 0,
        verified: 0,
        accepted: 0,
        unknown: 0,
        incompleteSnapshots: 0,
        feedPageLimitHits: 0,
        likeAttempts: 0,
        likesApplied: 0,
        likeAlreadyApplied: 0,
        errors: 0
    }
}
