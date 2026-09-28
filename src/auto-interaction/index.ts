import type { Context } from 'koishi'
import type {} from '../chatluna'
import type { Config } from '../config'
import {
    isModelConfigured,
    renderPresetPersona,
    resolveAssistantLabel
} from '../persona'
import { decideInteractionAction } from './agent'
import { canDescribeWithTransformer, describeMedia } from './describe-media'
import { prepareInteractionMedia } from './media'
import type { InteractionReport } from './report'
import type { RuntimeReports } from '../status'
import {
    createInteractionWhitelist,
    isWhitelistUsable
} from './types'
import { type AutoInteractionDeps, AutoInteractionRuntime } from './runtime'

export * from './runtime'

export const inject = {
    chatluna: { required: true },
    chatluna_qzone_interaction: { required: true },
    chatluna_character: { required: false },
    chatluna_storage: { required: false }
}

export function createAutoInteractionDeps(
    ctx: Context,
    config: Config
): AutoInteractionDeps {
    return {
        now: () => new Date(),
        logger: ctx.logger,
        isBotOnline: () =>
            ctx.chatluna_qzone_interaction.status().bot?.online === true,
        listFeedPage: (request) =>
            ctx.chatluna_qzone_interaction.listFeedPage(request),
        getPost: (request) => ctx.chatluna_qzone_interaction.getPost(request),
        comment: (request) => ctx.chatluna_qzone_interaction.comment(request),
        reply: (request) => ctx.chatluna_qzone_interaction.reply(request),
        like: (request) => ctx.chatluna_qzone_interaction.like(request),
        getAccountId: () => ctx.chatluna_qzone_interaction.status().client.accountId,
        resolveModel: async (modelRef) =>
            (await ctx.chatluna.createChatModel(modelRef)).value ?? null,
        renderPersona: (presetId) => renderPresetPersona(ctx, presetId),
        canDescribeMedia: () => canDescribeWithTransformer(ctx),
        prepareMedia: (media, model, canDescribe, signal) =>
            prepareInteractionMedia(
                ctx.http,
                media,
                model,
                canDescribe
                    ? async (urls) => {
                          const described = await describeMedia(
                              ctx,
                              urls,
                              config.subModel
                          )
                          return described.map((item) => item.text || null)
                      }
                    : null,
                ctx.chatluna_storage ?? null,
                signal
            ),
        decide: (deps) => decideInteractionAction({ ctx, ...deps })
    }
}

export function apply(
    ctx: Context,
    config: Config,
    reports: RuntimeReports,
    depsOverride?: AutoInteractionDeps
): void {
    const needsModel =
        config.friendPostCommentMode !== 'off' ||
        config.friendPostLikeMode === 'decide' ||
        config.interactionMonitorPostLimit > 0
    const enabled = needsModel || config.friendPostLikeMode !== 'off'
    const interactionWhitelist = createInteractionWhitelist(
        config.enableInteractionWhitelist,
        config.interactionAllowUserIds
    )
    const whitelistUsable = isWhitelistUsable(interactionWhitelist)
    if (!enabled) {
        const report: InteractionReport = {
            phase: 'disabled',
            detail: '好友动态评论与点赞均为关闭，且评论区监控数为 0',
            baselineCompletedAt: null,
            roundStartedAt: null,
            lastRoundAt: null,
            monitoredPosts: 0,
            monitorLimit: config.interactionMonitorPostLimit,
            pendingTriggers: 0,
            maxWritesPerRound: config.interactionMaxWritesPerRound,
            round: null,
            lastError: null
        }
        ctx.on(
            'dispose',
            reports.interaction.bind(() => report)
        )
        return
    }
    if (!whitelistUsable) {
        const report: InteractionReport = {
            phase: 'disabled',
            detail:
                '互动白名单已启用但列表为空，自动互动保持挂起；' +
                '请填写 interactionAllowUserIds 或关闭 enableInteractionWhitelist',
            baselineCompletedAt: null,
            roundStartedAt: null,
            lastRoundAt: null,
            monitoredPosts: 0,
            monitorLimit: config.interactionMonitorPostLimit,
            pendingTriggers: 0,
            maxWritesPerRound: config.interactionMaxWritesPerRound,
            round: null,
            lastError: null
        }
        ctx.logger.warn(
            '自动互动：互动白名单已启用但列表为空，功能保持挂起（qzone.status 可查看）'
        )
        ctx.on(
            'dispose',
            reports.interaction.bind(() => report)
        )
        return
    }
    const presetId = config.personaPresetId.trim()
    const missing: string[] = []
    if (needsModel) {
        if (!presetId) missing.push('personaPresetId')
        if (!isModelConfigured(config.subModel)) {
            missing.push('subModel')
        }
    }
    if (missing.length > 0) {
        const report: InteractionReport = {
            phase: 'waiting-config',
            detail: `缺少 ${missing.join('、')}`,
            baselineCompletedAt: null,
            roundStartedAt: null,
            lastRoundAt: null,
            monitoredPosts: 0,
            monitorLimit: config.interactionMonitorPostLimit,
            pendingTriggers: 0,
            maxWritesPerRound: config.interactionMaxWritesPerRound,
            round: null,
            lastError: null
        }
        ctx.logger.warn(`自动互动：未布防，缺少 ${missing.join('、')}`)
        ctx.on(
            'dispose',
            reports.interaction.bind(() => report)
        )
        return
    }
    const deps = depsOverride ?? createAutoInteractionDeps(ctx, config)
    const runtime = new AutoInteractionRuntime(deps, {
        friendPostCommentMode: config.friendPostCommentMode,
        friendPostLikeMode: config.friendPostLikeMode,
        interactionWhitelist,
        monitorLimit: config.interactionMonitorPostLimit,
        maxWritesPerRound: config.interactionMaxWritesPerRound,
        modelRef: config.subModel,
        presetId,
        assistantLabel: resolveAssistantLabel(presetId),
        debug: config.debug,
        promptTask: config.promptTask,
        promptMedia: config.promptMedia,
        promptWriting: config.promptWriting,
        promptSystem: config.promptSystemInteraction
    })
    const releaseReport = reports.interaction.bind(() => runtime.report)
    let inFlight: Promise<void> | null = null
    let started = false
    const run = () => {
        if (inFlight !== null) {
            ctx.logger.warn('自动互动：上一轮仍在运行，跳过重叠轮次')
            return
        }
        const task = runtime.runRound()
        inFlight = task
        task.finally(() => {
            inFlight = null
        }).catch(() => {})
    }
    ctx.on('ready', () => {
        started = true
        run()
        ctx.setInterval(
            run,
            Math.trunc(config.interactionPollIntervalMinutes) * 60 * 1000
        )
    })
    ctx.on('bot-status-updated', () => {
        if (
            started &&
            inFlight === null &&
            runtime.state.baseline !== 'ready' &&
            deps.isBotOnline()
        ) {
            run()
        }
    })
    ctx.on('dispose', async () => {
        runtime.cancel()
        await inFlight?.catch(() => {})
        runtime.stop()
        releaseReport()
    })
}
