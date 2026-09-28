import type { Command } from 'koishi'
import type { DigestRuntime } from '../digest/runtime'

export function registerDigest(
    command: Command,
    resolve: () => DigestRuntime | null
): void {
    command
        .subcommand('.digest')
        .usage('手动执行一次今日记忆动态')
        .action(async () => {
            const runtime = resolve()
            if (runtime === null) {
                return '每日记忆动态不可用：未挂载运行时。'
            }
            const report = await runtime.runOnce('manual')
            const head = `【今日记忆动态 · ${report.phase}】`
            const lines = [head, report.detail]
            if (report.memoryCount > 0) {
                lines.push(`使用记忆条数：${report.memoryCount}`)
            }
            if (report.lastOutcome !== null) {
                lines.push(`发布结果：${report.lastOutcome}`)
            }
            return lines.join('\n')
        })
}
