export interface LivingDiaryLogger {
    debug(message: string): void
    info(message: string): void
    warn(message: string): void
    error(message: string): void
}

export interface DiagnosticSink {
    info(message: string): void
    warn(message: string): void
}
