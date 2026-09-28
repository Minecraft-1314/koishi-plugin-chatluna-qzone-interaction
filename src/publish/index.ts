import type { Context } from 'koishi'
import type { PostMutationResult } from 'qzone-sdk'
import { QzoneWriteAuthError } from '../qzone/manager'
import { fetchPublishImages } from './images'
import { truncateContent } from './constants'

export const PUBLISH_OUTCOME_TEXT: Record<string, string> = {
    verified: '发布成功（已经读取确认）',
    accepted: '服务端已接受、尚未读回：稍后可用 qzone.feeds 核对',
    unknown:
        '结果不确定：请求已发出但无法确认是否生效，插件不会自动重发，' +
        '请稍后用 qzone.feeds 人工核对，确认未发布后再重新执行',
    'already-applied': '该动态此前已发布过，SDK 判定为重复提交'
}

export interface PublishRequest {
    readonly content: string
    readonly imageUrls: readonly string[]
    readonly debug?: boolean
}

export type PublishResult =
    | {
          readonly ok: true
          readonly outcome: string
          readonly text: string
          readonly result: PostMutationResult
          readonly imageCount: number
          readonly truncated: boolean
      }
    | {
          readonly ok: false
          readonly text: string
          readonly authExpired: boolean
      }

export async function publishQzonePost(
    ctx: Context,
    request: PublishRequest
): Promise<PublishResult> {
    const { text: content, truncated } = truncateContent(request.content)
    if (content.length === 0) {
        return { ok: false, text: '动态正文为空，未发布。', authExpired: false }
    }
    let images: Awaited<
        ReturnType<typeof fetchPublishImages>
    >['images'] = []
    if (request.imageUrls.length > 0) {
        const fetched = await fetchPublishImages(ctx, request.imageUrls)
        if (fetched.errors.length > 0) {
            return {
                ok: false,
                text:
                    '本次不发布（不会出现只发了部分图片的情况）：\n' +
                    fetched.errors.map((line) => `- ${line}`).join('\n') +
                    '\n请修正后重新执行。',
                authExpired: false
            }
        }
        images = fetched.images
    }
    let result: PostMutationResult
    try {
        result = await ctx.chatluna_qzone_interaction.publishPost({
            content,
            ...(images.length > 0
                ? { images: images.map((item) => item.input) }
                : {})
        })
    } catch (error) {
        if (request.debug) {
            ctx.logger.warn(`[发布] 发布异常 ${describeError(error)}`)
        }
        const authExpired = error instanceof QzoneWriteAuthError
        return {
            ok: false,
            authExpired,
            text: authExpired
                ? 'QQ 空间登录态已失效，插件已尝试自动续绑；请重新执行一次发布指令。'
                : `发布失败：${describeError(error)}`
        }
    }
    if (request.debug) {
        ctx.logger.info(
            `[发布] 发布完成 outcome=${result.outcome}` +
                (truncated ? ' 正文已截断' : '')
        )
    }
    const base =
        PUBLISH_OUTCOME_TEXT[result.outcome] ??
        `发布返回未知结果：${result.outcome}`
    return {
        ok: true,
        outcome: result.outcome,
        result,
        imageCount: images.length,
        truncated,
        text: base
    }
}

const describeError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)
