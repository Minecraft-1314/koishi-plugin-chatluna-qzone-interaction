import type { PostMutationResult, PublishImageInput } from 'qzone-sdk'
import type { Context } from 'koishi'
import { QzoneWriteAuthError } from '../qzone/manager'
import type { PublishContext } from './context'
import { decodePublishImages, fetchPublishImages } from './images'
import {
    PUBLISH_MAX_IMAGES,
    PUBLISH_MAX_IMAGE_BYTES,
    truncateContent
} from './constants'

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
    readonly images?: readonly string[]
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
    ctx: PublishContext,
    request: PublishRequest
): Promise<PublishResult> {
    if (request === null || typeof request !== 'object') {
        return {
            ok: false,
            text: '发布参数无效，未发布。',
            authExpired: false
        }
    }
    const contentInput =
        typeof request.content === 'string' ? request.content : ''
    const { text: content, truncated } = truncateContent(contentInput)
    if (content.length === 0) {
        return { ok: false, text: '动态正文为空，未发布。', authExpired: false }
    }
    const imageInputs = Array.isArray(request.images)
        ? request.images.filter(
              (item): item is string => typeof item === 'string'
          )
        : []
    const imageUrls = Array.isArray(request.imageUrls)
        ? request.imageUrls.filter(
              (item): item is string => typeof item === 'string'
          )
        : []
    const totalRequested = imageInputs.length + imageUrls.length
    if (totalRequested > PUBLISH_MAX_IMAGES) {
        return {
            ok: false,
            text:
                '本次不发布：QQ 空间单条动态最多 ' +
                `${PUBLISH_MAX_IMAGES} 张图片，当前提交了 ${totalRequested} 张。` +
                '请减少后重新执行。',
            authExpired: false
        }
    }
    const errors: string[] = []
    let images: PublishImageInput[] = []
    if (imageInputs.length > 0) {
        const decoded = decodePublishImages(
            imageInputs,
            PUBLISH_MAX_IMAGE_BYTES
        )
        errors.push(...decoded.errors)
        images = decoded.images
    }
    const remaining = Math.max(0, PUBLISH_MAX_IMAGES - images.length)
    if (imageUrls.length > 0 && remaining > 0) {
        const fetched = await fetchPublishImages(
            ctx.http,
            imageUrls.slice(0, remaining)
        )
        errors.push(...fetched.errors)
        images = images.concat(fetched.images.map((item) => item.input))
    }
    if (errors.length > 0) {
        return {
            ok: false,
            text:
                '本次不发布（不会出现只发了部分图片的情况）：\n' +
                errors.map((line) => `- ${line}`).join('\n') +
                '\n请修正后重新执行。',
            authExpired: false
        }
    }
    let result: PostMutationResult
    try {
        result = await ctx.target.publishPost({
            content,
            ...(images.length > 0 ? { images } : {})
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
