import type { Command, Context, h } from 'koishi'
import {
    collectImageUrls,
    collectUnsupportedFormats,
    collectVideoAttachments
} from '../publish/images'
import { PUBLISH_MAX_IMAGES } from '../publish/constants'
import { createPublishContext, publishQzonePost } from '../publish/context'
import { describeError } from '../auto-interaction/errors'

export function registerPublish(
    command: Command,
    pluginCtx: Context,
    debug: () => boolean
): void {
    command
        .subcommand('.publish <content:text>')
        .usage('向自己的 QQ 空间发布动态')
        .example('qzone.publish 今天天气不错，出去走了一圈。')
        .example('qzone.publish 今天的晚饭（同时附上一张或多张图片）')
        .action(async ({ session }, content) => {
            try {
                return await runPublish(
                    pluginCtx,
                    session,
                    content,
                    debug()
                )
            } catch (error) {
                return (
                    '发布流程异常中断：' +
                    describeError(error) +
                    '\n请稍后用 qzone.feeds 核对是否已发布。'
                )
            }
        })
}

const runPublish = async (
    pluginCtx: Context,
    session: unknown,
    content: unknown,
    debug: boolean
): Promise<string> => {
    const elements = readMessageElements(session)
    if (collectVideoAttachments(elements)) {
        return (
            '本次不发布：QQ 空间发布接口当前只支持文字与最多 ' +
            `${PUBLISH_MAX_IMAGES} 张图片，视频发布尚未支持。` +
            '请去掉视频后重新执行'
        )
    }
    const unsupported = collectUnsupportedFormats(elements)
    if (unsupported.length > 0) {
        return (
            '本次不发布：QQ 空间只支持文字、图片与视频，' +
            `不支持 ${unsupported.join('、')} 这类文件。` +
            '请去掉该附件后重新执行'
        )
    }
    const urls = collectImageUrls(elements)
    if (urls.length > PUBLISH_MAX_IMAGES) {
        return (
            '本次不发布：QQ 空间单条动态最多 ' +
            `${PUBLISH_MAX_IMAGES} 张图片，当前消息带了 ${urls.length} 张。` +
            '请减少后重新执行'
        )
    }
    const target = createPublishContext(pluginCtx)
    if (target === null) {
        return 'QQ 空间服务尚未就绪，请稍后重试（可用 qzone.status 查看登录态）'
    }
    const result = await publishQzonePost(target, {
        content: String(content ?? ''),
        imageUrls: urls,
        debug
    })
    return result.text
}

const readMessageElements = (session: unknown): readonly h[] => {
    const record = session as { elements?: h[] } | null
    return Array.isArray(record?.elements) ? record.elements : []
}
