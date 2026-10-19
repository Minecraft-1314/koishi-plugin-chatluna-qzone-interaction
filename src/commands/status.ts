import type { Command, Context } from 'koishi'
import type { InteractionReport } from '../auto-interaction/report'
import type { DigestReport } from '../digest/report'
import type { RebindStats } from '../qzone/rebind'
import type { LivingDiaryStatus } from '../service'
import type { PublishCapability } from '../xml-tool'

const TIME = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'short',
    timeStyle: 'medium',
    hour12: false
})

const formatInstant = (instant: Date): string =>
    Number.isNaN(instant.getTime()) ? '无' : TIME.format(instant)

const formatTime = (value: string | null | undefined): string =>
    value == null ? '无' : formatInstant(new Date(value))

const formatEpoch = (seconds: number | null | undefined): string =>
    typeof seconds === 'number' && Number.isFinite(seconds)
        ? formatInstant(new Date(seconds * 1000))
        : '无'

const yesNo = (value: boolean | null | undefined): string =>
    value === true ? '是' : '否'

const DISABLED_PUBLISH: PublishCapability = {
    enabled: false,
    mounted: false,
    reason: 'mount-failed',
    detail: '读取发布能力状态失败',
    observed: 0,
    published: 0,
    failed: 0
}

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

const safeRead = <T>(read: () => T, fallback: T): T => {
    try {
        return read()
    } catch {
        return fallback
    }
}

const describeRebind = (rebind: RebindStats | null | undefined): string => {
    if (rebind == null) return '无'
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
        `单轮写上限：${report.maxWritesPerRound}`,
        `失败重试：上限 ${report.retryLimit} 次，当前待重试 ${report.pendingRetries}`
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
    readonly publish: () => PublishCapability
}

const describePublish = (capability: PublishCapability): string[] => {
    const state = capability.mounted
        ? '可用'
        : capability.enabled
          ? '不可用'
          : '已关闭'
    const lines = [`状态：${state}`, `说明：${capability.detail}`]
    lines.push(
        '标签捕获 ' +
            capability.observed +
            ' 次，发布成功 ' +
            capability.published +
            ' 次，失败 ' +
            capability.failed +
            ' 次'
    )
    if (capability.enabled && !capability.mounted) {
        lines.push('模型此时无法主动发布，请勿相信它「已发布」的说法')
    }
    return lines
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
            let status: LivingDiaryStatus
            try {
                status = pluginCtx.chatluna_qzone_interaction.status()
            } catch (error) {
                return (
                    '读取 QQ 空间运行状态失败：' +
                    errorText(error) +
                    '\n请确认机器人已登录，或稍后重试。'
                )
            }
            const bot = status.bot ?? null
            const client: Partial<LivingDiaryStatus['client']> =
                status.client ?? {}
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
                describeInteraction(safeRead(deps.interaction, null)),
                '',
                '每日记忆动态：',
                describeDigest(safeRead(deps.digest, null)),
                '',
                '模型主动发布（<qzone_publish>）：',
                describePublish(safeRead(deps.publish, DISABLED_PUBLISH)).join('\n')
            ].join('\n')
        })
}
