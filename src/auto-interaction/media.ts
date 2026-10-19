import type { Context } from 'koishi'
import type { QzoneMedia } from 'qzone-sdk'
import {
    base64EncodedSize,
    type ChatLunaChatModel,
    IMAGE_INPUT_CAPABILITY
} from '../chatluna'
import { sniffImageMime } from '../image-mime'
import { extractVideoFrames, type VideoFrameOptions } from './video-frames'

export const INTERACTION_IMAGE_LIMIT = 9
export const INTERACTION_VIDEO_LIMIT = 1
export const FALLBACK_MAX_IMAGE_BASE64_BYTES = 20 * 1024 * 1024
export const FALLBACK_MAX_TOTAL_BASE64_BYTES = 60 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30000
const MEDIA_RELAY_EXPIRE_HOURS = 1
const DIRECT_IMAGE_MIME_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp'
] as const

export type InteractionImagePart = {
    readonly type: 'image_url'
    readonly image_url: { readonly url: string }
}

export interface InteractionStorage {
    createTempFile(
        buffer: Buffer,
        filename: string,
        expireHours?: number,
        mimeType?: string
    ): Promise<{ readonly url: string }>
}

export interface PreparedInteractionMedia {
    readonly lines: readonly string[]
    readonly imageParts: readonly InteractionImagePart[]
    readonly descriptions: ReadonlyMap<string, string>
    readonly storageFallbacks: number
    readonly downloadFailedMedia: readonly string[]
}

type HttpLike = Context['http']

export const emptyPreparedMedia = (): PreparedInteractionMedia => ({
    lines: [],
    imageParts: [],
    descriptions: new Map(),
    storageFallbacks: 0,
    downloadFailedMedia: []
})

export function declaresImageInput(model: ChatLunaChatModel): boolean {
    return (
        model.modelInfo?.capabilities?.includes(IMAGE_INPUT_CAPABILITY) === true
    )
}

export function acceptsMime(model: ChatLunaChatModel, mime: string): boolean {
    const file = model.fileHandlingConfig
    return file != null && file.supportedMimeTypes.has(mime)
}

export function supportsDirectImageMime(
    model: ChatLunaChatModel,
    mime: string
): boolean {
    return (
        declaresImageInput(model) &&
        DIRECT_IMAGE_MIME_TYPES.includes(
            mime as (typeof DIRECT_IMAGE_MIME_TYPES)[number]
        ) &&
        acceptsMime(model, mime)
    )
}

const canAttachAnyImage = (model: ChatLunaChatModel): boolean =>
    DIRECT_IMAGE_MIME_TYPES.some((mime) => supportsDirectImageMime(model, mime))

const imageRejectionReason = (model: ChatLunaChatModel): string =>
    declaresImageInput(model)
        ? 'model-mime-not-accepted'
        : 'model-no-image-input-capability'

const mediaMetadata = (media: QzoneMedia, id: string): string => {
    const values = [`media_id=${id}`, `kind=${media.kind}`]
    if (media.name) values.push(`name=${media.name}`)
    if (media.mimeType) values.push(`declared_mime=${media.mimeType}`)
    if (media.size !== undefined) values.push(`size=${media.size}`)
    if ('width' in media && media.width !== undefined) {
        values.push(`width=${media.width}`)
    }
    if ('height' in media && media.height !== undefined) {
        values.push(`height=${media.height}`)
    }
    if ('durationMs' in media && media.durationMs !== undefined) {
        values.push(`durationMs=${media.durationMs}`)
    }
    return values.join(' ')
}

async function downloadInteractionImage(
    http: HttpLike,
    value: string,
    signal?: AbortSignal
): Promise<{
    readonly bytes: Uint8Array
    readonly mime: string
}> {
    let parsed: URL
    try {
        parsed = new URL(value)
    } catch {
        throw new Error('图片地址无法解析')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('图片地址协议不受支持')
    }
    const buffer: ArrayBuffer = await http.get(parsed.toString(), {
        responseType: 'arraybuffer',
        headers: { accept: 'image/*,*/*' },
        timeout: DOWNLOAD_TIMEOUT_MS,
        signal
    })
    if (buffer.byteLength === 0) throw new Error('图片内容为空')
    const bytes = new Uint8Array(buffer)
    const mime = sniffImageMime(bytes)
    if (!mime) throw new Error('图片格式不受支持')
    return { bytes, mime }
}

const imageDataUrl = (bytes: Uint8Array, mime: string): string =>
    `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`

const imageExtension = (mime: string): string =>
    mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] ?? 'bin')

export type DescribeResolver = (
    urls: readonly string[]
) => Promise<readonly (string | null)[]>

export async function prepareInteractionMedia(
    http: HttpLike,
    mediaItems: readonly QzoneMedia[],
    model: ChatLunaChatModel,
    describe: DescribeResolver | null,
    storage: InteractionStorage | null,
    video: VideoFrameOptions | null,
    signal?: AbortSignal
): Promise<PreparedInteractionMedia> {
    const fileConfig = model.fileHandlingConfig
    const maxImageBytes = (mime: string): number =>
        fileConfig?.maxFileSizeBytesOverrides?.[mime] ??
        fileConfig?.maxFileSizeBytes ??
        FALLBACK_MAX_IMAGE_BASE64_BYTES
    const maxTotalBytes =
        fileConfig?.maxTotalSizeBytes ?? FALLBACK_MAX_TOTAL_BASE64_BYTES
    const lines: string[] = []
    const imageParts: InteractionImagePart[] = []
    const deferred: { id: string; url: string; line: number }[] = []
    let imageCount = 0
    let videoCount = 0
    let totalBytes = 0
    let storageFallbacks = 0
    const downloadFailedMedia: string[] = []

    const relayImage = async (
        bytes: Uint8Array,
        mime: string,
        filename: string
    ): Promise<string> => {
        if (storage === null) return imageDataUrl(bytes, mime)
        try {
            const stored = await storage.createTempFile(
                Buffer.from(bytes),
                filename,
                MEDIA_RELAY_EXPIRE_HOURS,
                mime
            )
            return stored.url
        } catch (error) {
            if (signal?.aborted) throw error
            storageFallbacks += 1
            return imageDataUrl(bytes, mime)
        }
    }

    for (const [index, media] of mediaItems.entries()) {
        const id = `M${index + 1}`
        const metadata = mediaMetadata(media, id)
        if (media.kind === 'video') {
            videoCount += 1
            if (videoCount > INTERACTION_VIDEO_LIMIT) {
                lines.push(`${metadata} status=unresolved:video-count-limit`)
                continue
            }
            if (video === null) {
                lines.push(`${metadata} status=metadata-only`)
                continue
            }
            if (!canAttachAnyImage(model)) {
                lines.push(
                    `${metadata} status=unresolved:${imageRejectionReason(model)}`
                )
                continue
            }
            try {
                const extracted = await extractVideoFrames(
                    http,
                    media.url,
                    video,
                    signal
                )
                if (!supportsDirectImageMime(model, extracted.mime)) {
                    lines.push(
                        `${metadata} actual_mime=${extracted.mime} ` +
                            'status=unresolved:mime-not-supported-directly'
                    )
                    continue
                }
                let attached = 0
                for (const [frameIndex, frame] of extracted.frames.entries()) {
                    const encodedBytes = base64EncodedSize(frame.byteLength)
                    if (encodedBytes > maxImageBytes(extracted.mime)) continue
                    if (totalBytes + encodedBytes > maxTotalBytes) break
                    totalBytes += encodedBytes
                    const frameUrl = await relayImage(
                        frame,
                        extracted.mime,
                        `${id}F${frameIndex + 1}.${imageExtension(extracted.mime)}`
                    )
                    imageParts.push({
                        type: 'image_url',
                        image_url: { url: frameUrl }
                    })
                    attached += 1
                }
                lines.push(
                    `${metadata} mode=${video.mode} ` +
                        `sampled=${extracted.sampledSeconds.join(',')} ` +
                        `duration_ms=${extracted.durationMs ?? 'unknown'} ` +
                        `frames=${attached} ` +
                        `status=${attached > 0 ? 'attached' : 'unresolved:frame-budget'}`
                )
            } catch (error) {
                if (signal?.aborted) throw error
                downloadFailedMedia.push(id)
                lines.push(
                    `${metadata} status=unresolved:video-frames-unavailable`
                )
            }
            continue
        }
        if (media.kind !== 'image') {
            lines.push(`${metadata} status=metadata-only`)
            continue
        }
        imageCount += 1
        if (imageCount > INTERACTION_IMAGE_LIMIT) {
            lines.push(`${metadata} status=unresolved:image-count-limit`)
            continue
        }
        if (!canAttachAnyImage(model)) {
            const line = lines.length
            if (describe !== null) deferred.push({ id, url: media.url, line })
            lines.push(
                `${metadata} status=unresolved:${imageRejectionReason(model)}`
            )
            continue
        }
        try {
            const downloaded = await downloadInteractionImage(
                http,
                media.url,
                signal
            )
            if (!supportsDirectImageMime(model, downloaded.mime)) {
                const line = lines.length
                if (describe !== null) deferred.push({ id, url: media.url, line })
                lines.push(
                    `${metadata} actual_mime=${downloaded.mime} ` +
                        'status=unresolved:mime-not-supported-directly'
                )
                continue
            }
            const encodedBytes = base64EncodedSize(downloaded.bytes.byteLength)
            if (encodedBytes > maxImageBytes(downloaded.mime)) {
                const line = lines.length
                if (describe !== null) deferred.push({ id, url: media.url, line })
                lines.push(
                    `${metadata} actual_mime=${downloaded.mime} ` +
                        'status=unresolved:image-size-limit'
                )
                continue
            }
            if (totalBytes + encodedBytes > maxTotalBytes) {
                const line = lines.length
                if (describe !== null) deferred.push({ id, url: media.url, line })
                lines.push(
                    `${metadata} actual_mime=${downloaded.mime} ` +
                        'status=unresolved:total-size-limit'
                )
                continue
            }
            totalBytes += encodedBytes
            const url = await relayImage(
                downloaded.bytes,
                downloaded.mime,
                `${id}.${imageExtension(downloaded.mime)}`
            )
            imageParts.push({
                type: 'image_url',
                image_url: { url }
            })
            lines.push(
                `${metadata} actual_mime=${downloaded.mime} ` +
                    `status=attached bytes=${downloaded.bytes.byteLength}`
            )
        } catch (error) {
            if (signal?.aborted) throw error
            const line = lines.length
            if (describe !== null) deferred.push({ id, url: media.url, line })
            downloadFailedMedia.push(id)
            lines.push(
                `${metadata} status=unresolved:download-or-format`
            )
        }
    }
    const descriptions = await resolveDescriptions(describe, deferred, lines)
    return {
        lines,
        imageParts,
        descriptions,
        storageFallbacks,
        downloadFailedMedia
    }
}

async function resolveDescriptions(
    describe: DescribeResolver | null,
    deferred: readonly { id: string; url: string; line: number }[],
    lines: string[]
): Promise<ReadonlyMap<string, string>> {
    const descriptions = new Map<string, string>()
    if (describe === null || deferred.length === 0) return descriptions
    let texts: readonly (string | null)[] = []
    try {
        texts = await describe(deferred.map((item) => item.url))
    } catch {
        return descriptions
    }
    deferred.forEach((item, index) => {
        const text = (texts[index] ?? '').trim()
        if (text.length === 0) return
        descriptions.set(item.id, text)
        if (lines[item.line] !== undefined) {
            lines[item.line] = lines[item.line].replace(
                'status=unresolved:',
                'status=described:'
            )
        }
    })
    return descriptions
}
