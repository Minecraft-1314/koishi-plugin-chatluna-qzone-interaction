import { createRuntimeReports } from './status'
import type { Context } from 'koishi'
import type { Config } from './config'
import * as autoInteractionEntry from './auto-interaction'
import { applyCommands } from './commands'
import { DigestRuntime } from './digest/runtime'
import { renderPresetPersona } from './persona'
import * as personaEntry from './persona'
import { LivingDiaryService } from './service'
import { PublishXmlTool } from './xml-tool'
export { Config } from './config'

export const name = 'chatluna-qzone-interaction'

export const inject = {
    chatluna: { required: true },
    chatluna_character: { required: false },
    chatluna_memory: { required: false },
    chatluna_living_memory: { required: false },
    chatluna_storage: { required: false },
    chatluna_qzone_interaction: { required: false }
}

export function apply(ctx: Context, config: Config) {
    const reports = createRuntimeReports()
    ctx.plugin(LivingDiaryService, config)
    ctx.plugin(personaEntry)
    const digest = new DigestRuntime(ctx, config, {
        now: () => new Date(),
        logger: ctx.logger,
        resolveModel: async (modelRef) =>
            (await ctx.chatluna.createChatModel(modelRef)).value ?? null,
        renderPersona: (presetId) => renderPresetPersona(ctx, presetId)
    })
    let digestRef: DigestRuntime | null = digest
    const publishTool = new PublishXmlTool(ctx, config, ctx.logger)
    applyCommands(ctx, config, reports, {
        digest: () => digestRef
    })
    ctx.plugin({
        inject: autoInteractionEntry.inject,
        apply: (ctx: Context) =>
            autoInteractionEntry.apply(ctx, config, reports)
    })
    ctx.inject(['chatluna_character'], () => {
        publishTool.start()
    })
    ctx.on('ready', () => {
        digest.start()
    })
    ctx.on('dispose', () => {
        publishTool.stop()
        digest.stop()
        digestRef = null
    })
}
