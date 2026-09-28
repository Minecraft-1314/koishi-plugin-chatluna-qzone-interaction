import type { Context } from 'koishi'
import type { Config } from '../config'
import type { DigestRuntime } from '../digest/runtime'
import type { RuntimeReports } from '../status'
import { registerDigest } from './digest'
import { registerFeeds } from './feeds'
import { createAllowGuard } from './guard'
import { registerPublish } from './publish'
import { registerStatus } from './status'

export const QZONE_COMMAND_NAME = 'qzone'

const USAGE_LINES = [
    'QQ 空间指令：',
    '  qzone.feeds [条数] [-t <qq>]  读取 QQ 空间动态',
    '  qzone.publish <正文>          发布动态（同条消息附图即为图文动态）',
    '  qzone.digest                  手动执行一次今日记忆动态',
    '  qzone.status                  查看登录态与各功能运行状态',
    '  qzone                         显示本说明'
]

export interface CommandDeps {
    readonly digest: () => DigestRuntime | null
}

export function applyCommands(
    ctx: Context,
    config: Config,
    reports: RuntimeReports,
    deps: CommandDeps
): void {
    const command = ctx.command(QZONE_COMMAND_NAME)
        .alias('空间')
        .before(createAllowGuard(config))
        .action(() => USAGE_LINES.join('\n'))

    registerFeeds(command, ctx, () => config.feedsDefaultLimit)
    registerPublish(command, ctx, () => config.debug)
    registerStatus(command, ctx, {
        interaction: () => reports.interaction.get(),
        digest: () => deps.digest()?.report ?? null
    })
    registerDigest(command, deps.digest)
}
