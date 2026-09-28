import { watch } from '@vue/reactivity'
import { type Context, Schema } from 'koishi'
import type {} from './chatluna'

export const livingDiaryPresetSchemaKind = 'livingdiary-preset'
export const characterPresetSuffix = '（Character）'

export const resolveAssistantLabel = (presetId: string): string =>
    presetId.endsWith(characterPresetSuffix)
        ? presetId.slice(0, -characterPresetSuffix.length)
        : presetId

export const inject = {
    chatluna: { required: true }
}

interface CharacterPresetProvider {
    preset: {
        getAllPreset: () => Promise<unknown>
        getPreset: (
            presetName: string,
            loadForDisk?: boolean,
            throwError?: boolean
        ) => Promise<{ system: { rawString: string } }>
    }
}

declare module 'koishi' {
    interface Events {
        'chatluna_character/preset_updated': () => void
    }
}

const toPresetIdList = (value: unknown): string[] => {
    if (!Array.isArray(value)) return []
    return value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item.length > 0)
}

const stringifyPromptContent = (content: unknown): string => {
    if (typeof content === 'string') return content.trim()
    if (!Array.isArray(content)) return ''
    return content
        .map((part) => {
            if (
                part != null &&
                typeof part === 'object' &&
                typeof (part as Record<string, unknown>).text === 'string'
            ) {
                return ((part as { text: string }).text ?? '').trim()
            }
            return ''
        })
        .filter((text) => text.length > 0)
        .join('\n')
}

export const renderPresetPersona = async (
    ctx: Context,
    presetId: string
): Promise<string> => {
    if (presetId.endsWith(characterPresetSuffix)) {
        const character = (
            ctx as Context & {
                chatluna_character?: CharacterPresetProvider
            }
        ).chatluna_character
        if (character == null) {
            throw new Error(
                'chatluna-character 插件未运行，无法渲染 Character 预设人设'
            )
        }
        const presetName = presetId.slice(0, -characterPresetSuffix.length)
        const preset = await character.preset.getPreset(presetName, false)
        const rendered = await ctx.chatluna.promptRenderer.renderTemplate(
            preset.system.rawString,
            { time: '', stickers: '', status: '' }
        )
        return rendered.text.trim()
    }
    const preset = ctx.chatluna.preset.getPreset(presetId, false).value
    if (!preset) {
        throw new Error(`ChatLuna 预设不存在：${presetId}`)
    }
    const rendered =
        await ctx.chatluna.promptRenderer.renderPresetTemplate(preset)
    return rendered.messages
        .filter((message) => message.getType() === 'system')
        .map((message) => stringifyPromptContent(message.content))
        .filter((text) => text.length > 0)
        .join('\n')
}

export const isModelConfigured = (model: unknown): model is string => {
    if (typeof model !== 'string') return false
    const trimmed = model.trim()
    return trimmed.length > 0 && trimmed !== '无'
}

export function apply(ctx: Context): void {
    let characterPresetIds: readonly string[] = []
    let latestChatLunaIds: readonly string[] = []
    const refresh = () => {
        const ids = [
            ...new Set([...latestChatLunaIds, ...characterPresetIds])
        ].sort((left, right) => left.localeCompare(right))
        ctx.schema.set(
            livingDiaryPresetSchemaKind,
            Schema.union(ids.map((id) => Schema.const(id)))
        )
    }
    const stop = watch(
        ctx.chatluna.preset.getAllPreset(false),
        (ids) => {
            latestChatLunaIds = toPresetIdList(ids)
            refresh()
        },
        { immediate: true }
    )
    ctx.effect(() => stop)
    ctx.inject(['chatluna_character'], async (characterCtx) => {
        let active = true
        let refreshing = false
        let refreshPending = false
        let ignoreNextPresetUpdated = false
        const character = (
            characterCtx as Context & {
                chatluna_character: CharacterPresetProvider
            }
        ).chatluna_character
        const refreshCharacterPresets = async () => {
            if (refreshing) {
                refreshPending = true
                return
            }
            refreshing = true
            try {
                do {
                    refreshPending = false
                    ignoreNextPresetUpdated = true
                    try {
                        const ids = toPresetIdList(
                            await character.preset.getAllPreset()
                        ).map((id) => `${id}${characterPresetSuffix}`)
                        if (!active) return
                        characterPresetIds = ids
                        refresh()
                    } catch (error) {
                        if (!active) return
                        characterPresetIds = []
                        refresh()
                        characterCtx.logger.warn(
                            '获取 Character 预设列表失败：' +
                                `${(error as Error).message}，` +
                                '已清除 Character 候选项'
                        )
                    } finally {
                        ignoreNextPresetUpdated = false
                    }
                } while (refreshPending)
            } finally {
                refreshing = false
            }
        }
        characterCtx.on('chatluna_character/preset_updated', () => {
            if (ignoreNextPresetUpdated) {
                ignoreNextPresetUpdated = false
                return
            }
            return refreshCharacterPresets()
        })
        characterCtx.on('dispose', () => {
            active = false
            characterPresetIds = []
            if (ctx.scope.isActive) refresh()
        })
        await refreshCharacterPresets()
    })
}
