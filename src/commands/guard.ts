import type { Command } from 'koishi'
import type { Config } from '../config'

const normalize = (value: string): string => value.trim()

export function createAllowGuard(config: Config) {
    const allowed = new Set(
        (config.allowUserIds ?? [])
            .map((item) => normalize(String(item)))
            .filter((item) => item.length > 0)
    )
    const guard: Command.Action = (argv) => {
        if (allowed.size === 0) {
            return (
                'QQ 空间指令未开放：配置项 allowUserIds 为空，所有指令均已关闭。'
            )
        }
        const userId = normalize(argv.session?.userId ?? '')
        if (userId.length === 0 || !allowed.has(userId)) {
            return '你没有使用 QQ 空间指令的权限。'
        }
        return undefined
    }
    return guard
}
