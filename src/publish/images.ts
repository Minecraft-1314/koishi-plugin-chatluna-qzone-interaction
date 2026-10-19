import type { Context, h } from 'koishi'
import type { PublishImageInput } from 'qzone-sdk'
import { mapWithConcurrency } from '../auto-interaction/concurrency'
import { sniffImageMime } from '../image-mime'
import {
    PUBLISH_IMAGE_FETCH_CONCURRENCY,
    PUBLISH_IMAGE_FETCH_TIMEOUT_MS,
    PUBLISH_MAX_IMAGE_BYTES,
    PUBLISH_MAX_IMAGES
} from './constants'

const EXTENSION_BY_MIME: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp'
}

const EXTENSION_BY_URL = /\.(jpe?g|png|gif|webp)(?:[?#]|$)/iu

const withTimeout = async <T>(
    task: Promise<T>,
    ms: number
): Promise<T> => {
    let timer: NodeJS.Timeout | undefined
    try {
        return await Promise.race([
            task,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error('图片下载超时')),
                    ms
                )
                timer.unref?.()
            })
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

const guessName = (url: string, mimeType: string): string => {
    const fromMime = EXTENSION_BY_MIME[mimeType.toLowerCase()]
    if (fromMime) return `image.${fromMime}`
    const matched = EXTENSION_BY_URL.exec(url)
    return matched ? `image.${matched[1].toLowerCase()}` : 'image.bin'
}

export const isRemoteImageUrl = (url: string): boolean =>
    /^https?:\/\//iu.test(url)

export const collectImageUrls = (elements: readonly h[]): string[] => {
    const urls: string[] = []
    for (const element of elements) {
        if (element?.type !== 'img') continue
        const src = element.attrs?.['src']
        if (typeof src !== 'string') continue
        const url = src.trim()
        if (url.length === 0 || urls.includes(url)) continue
        urls.push(url)
    }
    return urls
}

const DOMAIN_MEDIA_TYPES = new Set(['text', 'img', 'video'])

const DATA_URL_PATTERN =
    /^data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/iu

const collectElementTypes = (
    elements: readonly h[],
    accept: (type: string) => boolean
): string[] => {
    const kinds: string[] = []
    for (const element of elements) {
        if (element == null) continue
        if (accept(element.type)) continue
        if (kinds.includes(element.type)) continue
        kinds.push(element.type)
    }
    return kinds
}

export const collectUnsupportedFormats = (
    elements: readonly h[]
): string[] =>
    collectElementTypes(elements, (type) => DOMAIN_MEDIA_TYPES.has(type))

export const collectVideoAttachments = (
    elements: readonly h[]
): boolean => elements.some((element) => element?.type === 'video')

export const decodePublishImages = (
    dataUrls: readonly string[],
    maxBytes: number
): { images: PublishImageInput[]; errors: string[] } => {
    const images: PublishImageInput[] = []
    const errors: string[] = []
    const source = Array.isArray(dataUrls) ? dataUrls : []
    for (const [index, raw] of source.entries()) {
        const label = `第 ${index + 1} 张图片`
        const matched = DATA_URL_PATTERN.exec(String(raw).trim())
        if (matched === null) {
            errors.push(`${label}不是有效的图片数据`)
            continue
        }
        const bytes = new Uint8Array(
            Buffer.from(matched[2] ?? '', 'base64')
        )
        if (bytes.byteLength === 0) {
            errors.push(`${label}内容为空`)
            continue
        }
        if (bytes.byteLength > maxBytes) {
            errors.push(
                `${label} ${formatBytes(bytes.byteLength)} 超过 32MB 上限`
            )
            continue
        }
        const mime = sniffImageMime(bytes)
        if (mime === null) {
            errors.push(`${label}真实格式不受支持`)
            continue
        }
        images.push({
            data: bytes,
            name: `image.${EXTENSION_BY_MIME[mime] ?? 'bin'}`,
            mimeType: mime
        })
    }
    return { images, errors }
}

export interface FetchedImage {
    readonly input: PublishImageInput
    readonly url: string
}

export async function fetchPublishImages(
    http: Context['http'],
    urls: readonly string[]
): Promise<{ images: FetchedImage[]; errors: string[] }> {
    const targets = urls.slice(0, PUBLISH_MAX_IMAGES)
    const outcomes = await mapWithConcurrency(
        targets,
        async (url) => {
            try {
                if (!isRemoteImageUrl(url)) {
                    throw new Error('仅支持 http/https 图片地址')
                }
                const buffer = await withTimeout(
                    http.get(url, { responseType: 'arraybuffer' }),
                    PUBLISH_IMAGE_FETCH_TIMEOUT_MS
                )
                const data = new Uint8Array(buffer)
                if (data.byteLength === 0) {
                    throw new Error('图片内容为空')
                }
                const mimeType = sniffImageMime(data)
                if (mimeType === null) {
                    throw new Error(
                        '图片真实格式不受支持（仅支持 JPEG / PNG / GIF / WebP）'
                    )
                }
                if (data.byteLength > PUBLISH_MAX_IMAGE_BYTES) {
                    throw new Error(
                        `单张图片 ${formatBytes(
                            data.byteLength
                        )} 超过 32MB 上限`
                    )
                }
                return {
                    input: {
                        data,
                        name: guessName(url, mimeType),
                        mimeType
                    },
                    url
                } satisfies FetchedImage
            } catch (error) {
                throw new PublishImageError(url, error)
            }
        },
        PUBLISH_IMAGE_FETCH_CONCURRENCY
    )
    const images: FetchedImage[] = []
    const errors: string[] = []
    outcomes.forEach((outcome) => {
        if (outcome.ok) {
            images.push(outcome.value!)
        } else {
            errors.push(errorText(outcome.error))
        }
    })
    return { images, errors }
}

export class PublishImageError extends Error {
    readonly url: string

    constructor(url: string, cause: unknown) {
        super(`图片下载失败（${url}）：${errorText(cause)}`)
        this.url = url
    }
}

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
