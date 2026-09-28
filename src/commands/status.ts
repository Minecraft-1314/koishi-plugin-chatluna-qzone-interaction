import type { Command, Context } from 'koishi'
import type { InteractionReport } from '../auto-interaction/report'
import type { DigestReport } from '../digest/report'
import type { RebindStats } from '../qzone/rebind'

const TIME = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'short',
    timeStyle: 'medium',
    hour12: false
})

const formatTime = (value: string | null): string =>
    value === null ? '无' : TIME.format(new Date(value))

const formatEpoch = (seconds: number | null): string =>
    seconds === null ? '无' : TIME.format(new Date(seconds * 1000))

const yesNo = (value: boolean): string => (value ? '是' : '否')

const describeRebind = (rebind: RebindStats): string => {
    if (rebind.disabled) {
        return `已停用（连续失败 ${rebind.consecutiveFailures} 次，重新登录机器人后重载插件可恢复）`
    }
    if (rebind.inFlight) return '正在续绑'
    if (rebind.consecutiveFailures > 0) {
        return `连续失败退避中（${rebind.consecutiveFailures} 次，` +
            `下次尝试 ${formatEpoch(rebind.nextAllowedAtSeconds)}）`
    }
    return `正常（上次成功 ${formatEpoch(rebind.lastSuccessAtSeconds)}）`
}

const describeInteraction = (report: InteractionReport | null): string => {
    if (report === null) return '未挂起'
    const lines = [
        `阶段：${report.detail}`,
        `监控动态：${report.monitoredPosts}/${report.monitorLimit}`,
        `待处理触发：${report.pendingTriggers}`,
        `单轮写上限：${report.maxWritesPerRound}`
    ]
    if (report.lastError !== null) lines.push(`最近错误：${report.lastError}`)
    if (report.round !== null) {
        const round = report.round
        lines.push(
            `上轮统计：发现 ${round.discovered}，写入 ${round.writeAttempts}` +
                `（确认 ${round.verified} / 已接受 ${round.accepted} / 不确定 ${round.unknown}），` +
                `点赞 ${round.likesApplied}，不完整快照 ${round.incompleteSnapshots}，错误 ${round.errors}`
        )
    }
    lines.push(`基线建立于：${formatTime(report.baselineCompletedAt)}`)
    lines.push(`最近一轮：${formatTime(report.lastRoundAt)}`)
    return lines.join('\n')
}

const describeDigest = (report: DigestReport | null): string => {
    if (report === null) return '未挂起'
    const lines = [
        `阶段：${report.detail}`,
        `最近执行：${formatTime(report.lastRunAt)}`
    ]
    if (report.nextRunAt !== null) {
        lines.push(`下次触发：${formatTime(report.nextRunAt)}`)
    }
    if (report.memoryCount > 0) {
        lines.push(`本次使用记忆条数：${report.memoryCount}`)
    }
    if (report.lastOutcome !== null) {
        lines.push(`最近结果：${report.lastOutcome}`)
    }
    return lines.join('\n')
}

export interface StatusDeps {
    readonly interaction: () => InteractionReport | null
    readonly digest: () => DigestReport | null
}

export function registerStatus(
    command: Command,
    pluginCtx: Context,
    deps: StatusDeps
): void {
    command
        .subcommand('.status')
        .usage('查看 QQ 空间登录态与各功能运行状态')
        .action(async () => {
            const status = pluginCtx.chatluna_qzone_interaction.status()
            const bot = status.bot
            const client = status.client
            return [
                '【QQ 空间 · 运行状态】',
                '',
                '登录态：',
                `  协议：${bot?.platform ?? '未绑定'}`,
                `  账号：${bot?.selfId ?? '无'}`,
                `  在线：${bot ? yesNo(bot.online) : '无'}`,
                `  客户端已初始化：${yesNo(client.initialized)}`,
                `  账号 ID：${client.accountId ?? '无'}`,
                `  登录态有效：${yesNo(client.authenticated)}`,
                `  Session 更新时间：${formatTime(client.sessionUpdatedAt)}`,
                `  自动续绑：${describeRebind(client.rebind)}`,
                '',
                'QQ 空间自动互动：',
                describeInteraction(deps.interaction()),
                '',
                '每日记忆动态：',
                describeDigest(deps.digest())
            ].join('\n')
        })
}
