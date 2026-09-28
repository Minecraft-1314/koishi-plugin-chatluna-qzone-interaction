import type { Command, Context } from 'koishi'
import type { FeedPage, QzonePost } from 'qzone-sdk'
import { describeError } from '../auto-interaction/errors'

const SUMMARY_MAX_LENGTH = 80
const SUMMARY_ELLIPSIS = '……'
const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
})

const summarize = (content: string): string => {
    const normalized = content.replace(/\s+/gu, ' ').trim()
    if (normalized.length === 0) return '（无文字）'
    if (normalized.length <= SUMMARY_MAX_LENGTH) return normalized
    return normalized.slice(0, SUMMARY_MAX_LENGTH) + SUMMARY_ELLIPSIS
}

const formatTime = (value: string | null): string => {
    if (value === null) return '未知时间'
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) return '未知时间'
    return TIME_FORMAT.format(new Date(parsed)).replaceAll('/', '-')
}

const describePost = (post: QzonePost, index: number): string =>
    [
        `${index + 1}. ${formatTime(post.createdAt)}`,
        `   作者：${post.author.nickname}(${post.author.id})`,
        `   内容：${summarize(post.content)}`,
        `   点赞 ${post.likeCount} · 评论 ${post.commentCount}` +
            (post.media.length > 0 ? ` · 媒体 ${post.media.length}` : '')
    ].join('\n')

export function registerFeeds(
    command: Command,
    pluginCtx: Context,
    defaultLimit: () => number
): void {
    command
        .subcommand('.feeds [count:text]')
        .option('-t, --target <qq>', '读取指定 QQ 的公开动态')
        .usage('读取 QQ 空间动态')
        .example('qzone.feeds           # 读取自己的动态')
        .example('qzone.feeds 3         # 读取自己的最近 3 条')
        .example('qzone.feeds -t 123456 # 读取该 QQ 的公开动态')
        .action(async (_argv, count, target) => {
            const limit = clampCount(count, defaultLimit())
            const userId = typeof target === 'string' ? target.trim() : ''
            const label = userId.length > 0 ? `QQ ${userId}` : '自己'
            let page: FeedPage
            try {
                page = await pluginCtx.chatluna_qzone_interaction.listFeedPage({
                    scope: userId.length > 0 ? 'profile' : 'self',
                    ...(userId.length > 0 ? { userId } : {}),
                    limit
                })
            } catch (error) {
                pluginCtx.logger.warn(
                    `qzone.feeds 读取失败（${label}）：${describeError(error)}`
                )
                return (
                    `读取${label}的空间动态失败：${describeError(error)}\n` +
                    '可用 qzone.status 查看登录态与自动续绑状态。'
                )
            }
            if (page.items.length === 0) {
                return `${label}没有可显示的动态。`
            }
            return (
                `${label}的空间动态（${page.items.length} 条）\n` +
                page.items.map(describePost).join('\n')
            )
        })
}

const clampCount = (value: unknown, fallback: number): number => {
    const parsed = Number.parseInt(String(value ?? ''), 10)
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback
    return Math.min(parsed, 10)
}
