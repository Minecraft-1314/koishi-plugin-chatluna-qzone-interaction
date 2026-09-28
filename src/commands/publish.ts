import type { Command, Context, h } from 'koishi'
import { collectImageUrls, extractImageUrls } from '../publish/images'
import { PUBLISH_MAX_IMAGES } from '../publish/constants'
import { publishQzonePost } from '../publish'

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
            const elements = readMessageElements(session)
            const urls = extractImageUrls(elements)
            const overflow =
                collectImageUrls(elements).length > PUBLISH_MAX_IMAGES
            const result = await publishQzonePost(pluginCtx, {
                content: String(content ?? ''),
                imageUrls: urls,
                debug: debug()
            })
            const suffix = overflow
                ? `\n（单条动态最多 ${PUBLISH_MAX_IMAGES} 张图片，多余的已忽略）`
                : ''
            return result.text + suffix
        })
}

const readMessageElements = (session: unknown): readonly h[] => {
    const record = session as { message?: h[] } | null
    return Array.isArray(record?.message) ? record.message : []
}
