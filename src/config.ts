import { Schema } from 'koishi'
import type { CookiePlatform } from './qzone/cookie-platform'
import {
    DEFAULT_PROMPT_DIGEST_TASK,
    DEFAULT_PROMPT_DIGEST_VOICE,
    DEFAULT_PROMPT_MEDIA,
    DEFAULT_PROMPT_PUBLISH_TOOL,
    DEFAULT_PROMPT_SYSTEM_DIGEST,
    DEFAULT_PROMPT_SYSTEM_INTERACTION,
    DEFAULT_PROMPT_TASK,
    DEFAULT_PROMPT_WRITING
} from './prompt-defaults'

export type InteractionMode = 'off' | 'forced' | 'decide'
export type CookiePlatformMode = CookiePlatform | 'auto'

export interface Config {
    selfId?: string
    platform: CookiePlatformMode
    allowUserIds: string[]
    rebindMinIntervalSeconds: number
    rebindBackoffSeconds: number
    rebindMaxConsecutiveFailures: number
    debug: boolean
    personaPresetId: string
    mainModel: string
    subModel: string
    feedsDefaultLimit: number
    enablePublishTool: boolean
    enableDailyDigest: boolean
    digestTime: string
    digestMemoryLimit: number
    friendPostCommentMode: InteractionMode
    friendPostLikeMode: InteractionMode
    enableInteractionWhitelist: boolean
    interactionAllowUserIds: string[]
    interactionMonitorPostLimit: number
    interactionPollIntervalMinutes: number
    interactionMaxWritesPerRound: number
    promptTask: string
    promptMedia: string
    promptWriting: string
    promptDigestTask: string
    promptDigestVoice: string
    promptPublishTool: string
    promptSystemInteraction: string
    promptSystemDigest: string
}

const ModeSchema = Schema.union([
    Schema.const('off').description('关闭：完全不执行，不会调用模型'),
    Schema.const('forced').description('强制执行：不受模型判断影响，一定会执行'),
    Schema.const('decide').description('交由模型判断：模型可根据内容决定跳过')
])

const PlatformSchema = Schema.union([
    Schema.const('auto').description('自动：OneBot 优先，回退 Milky'),
    Schema.const('onebot').description('仅使用 OneBot'),
    Schema.const('milky').description('仅使用 Milky（协议端需实现 get_cookies）')
])

export const Config: Schema<Config> = Schema.intersect([
    Schema.object({
        selfId: Schema.string()
            .description(
                '绑定的 OneBot 机器人 selfId；留空时自动选择第一个在线的机器人'
            )
            .default(''),
        platform: PlatformSchema.description(
            '取登录态的机器人协议：自动（优先 OneBot，没有则回退 Milky）' +
            ' / 仅 OneBot / 仅 Milky'
        ).default('auto'),
        allowUserIds: Schema.array(Schema.string())
            .description(
                '允许使用指令的 QQ 号列表。留空表示所有指令对所有用户关闭；' +
                    '白名单外的用户无法使用任何指令'
            )
            .default([]),
        rebindMinIntervalSeconds: Schema.number()
            .description('两次自动续绑之间的最小间隔（秒）')
            .default(60),
        rebindBackoffSeconds: Schema.number()
            .description('续绑失败退避基数（秒），随连续失败次数指数增长，封顶 300')
            .default(60),
        rebindMaxConsecutiveFailures: Schema.number()
            .description('连续续绑失败达到该次数后停用自动续绑')
            .default(3),
        debug: Schema.boolean()
            .description('调试模式：输出插件的完整运行轨迹与模型提示词')
            .default(false)
    }).description('基础设置'),
    Schema.object({
        personaPresetId: Schema.dynamic('livingdiary-preset')
            .description(
                '评论互动使用的人设预设；Character 预设名带（Character）后缀'
            )
            .default(''),
        mainModel: Schema.dynamic('model')
            .description('主模型，用于生成每日记忆动态')
            .default('无'),
        subModel: Schema.dynamic('model')
            .description('模型，用于生成 QQ 空间评论与回复正文')
            .default('无')
    }).description('模型设置'),
    Schema.object({
        feedsDefaultLimit: Schema.natural()
            .description('qzone.feeds 默认读取的动态条数（上限 10）')
            .min(1)
            .max(10)
            .default(5),
        enablePublishTool: Schema.boolean()
            .description(
                '是否启用 qzone_publish XML 发布能力：' +
                    '模型可在回复中输出 <qzone_publish> 标签直接发布到空间'
            )
            .default(true)
    }).description('空间动态设置'),
    Schema.object({
        enableDailyDigest: Schema.boolean()
            .description(
                '启用每日记忆动态的定时发布（需要 ChatLuna 与 chatluna-memory）'
            )
            .default(false),
        digestTime: Schema.string()
            .description(
                '每日记忆动态触发时刻（HH:mm，服务器本地时区）；' +
                    '停机或重载错过不补发'
            )
            .default('23:00'),
        digestMemoryLimit: Schema.natural()
            .description('送入模型的当日记忆条数上限（10–200），超出保留最新条目')
            .min(10)
            .max(200)
            .default(100)
    }).description('每日记忆动态设置'),
    Schema.object({
        enableInteractionWhitelist: Schema.boolean()
            .description(
                '是否只与白名单中的 QQ 号互动；关闭后允许 Bot 与所有用户互动'
            )
            .default(true),
        interactionAllowUserIds: Schema.array(Schema.string())
            .description(
                '允许自动评论或回复的用户 QQ 号；与指令白名单 allowUserIds 相互独立。' +
                    '白名单模式下留空表示保持挂起'
            )
            .default([]),
        friendPostCommentMode: ModeSchema.description(
            '对好友新动态的评论方式：关闭（不评论）/ 强制评论（模型无权否决）' +
                ' / 交由模型判断（模型可自行跳过）'
        ).default('off'),
        friendPostLikeMode: ModeSchema.description(
            '对好友新动态的点赞方式：关闭（不点赞）/ 强制点赞 / 交由模型判断'
        ).default('off'),
        interactionMonitorPostLimit: Schema.natural()
            .description('持续监控的最新活动动态数（好友动态 + Bot 自身动态）')
            .min(0)
            .max(100)
            .default(10),
        interactionPollIntervalMinutes: Schema.natural()
            .description('好友动态与评论区详情的轮询间隔（分钟）')
            .min(1)
            .max(720)
            .default(60),
        interactionMaxWritesPerRound: Schema.natural()
            .description('每轮最多发起的写请求数（评论、回复、点赞共用）')
            .min(1)
            .max(20)
            .default(5)
    }).description('评论互动设置'),
    Schema.object({
        promptSystemInteraction: Schema.string()
            .description(
                '自动互动评论／回复的完整系统提示词。' +
                    '可用占位符：{{assistantLabel}} {{preset}} {{task}} ' +
                    '{{media}} {{writing}} {{contract}}；' +
                    '留空则由下方各段落自动拼装'
            )
            .default(DEFAULT_PROMPT_SYSTEM_INTERACTION),
        promptSystemDigest: Schema.string()
            .description(
                '每日记忆动态的完整系统提示词。' +
                    '可用占位符：{{assistantLabel}} {{preset}} {{task}} ' +
                    '{{voice}} {{contract}}；留空则由下方各段落自动拼装'
            )
            .default(DEFAULT_PROMPT_SYSTEM_DIGEST),
        promptTask: Schema.string()
            .description(
                '任务说明段落，决定模型如何理解本次互动的目标；留空则使用默认'
            )
            .default(DEFAULT_PROMPT_TASK),
        promptMedia: Schema.string()
            .description(
                '媒体规则段落，说明各 status 状态的含义；留空则使用默认'
            )
            .default(DEFAULT_PROMPT_MEDIA),
        promptWriting: Schema.string()
            .description('写作规则段落，约束语气、篇幅与称呼；留空则使用默认')
            .default(DEFAULT_PROMPT_WRITING),
        promptDigestTask: Schema.string()
            .description(
                '每日记忆动态的任务段落，规定如何组织当日记忆；留空则使用默认'
            )
            .default(DEFAULT_PROMPT_DIGEST_TASK),
        promptDigestVoice: Schema.string()
            .description(
                '每日记忆动态的语气段落，约束篇幅与口吻；留空则使用默认'
            )
            .default(DEFAULT_PROMPT_DIGEST_VOICE),
        promptPublishTool: Schema.string()
            .description(
                '注入模型的 qzone_publish 标签说明；留空则使用默认'
            )
            .default(DEFAULT_PROMPT_PUBLISH_TOOL)
    }).description('提示词设置')
])
  .description('QQ 空间自动互动')
