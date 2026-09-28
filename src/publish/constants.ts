export const PUBLISH_MAX_IMAGES = 9
export const PUBLISH_MAX_IMAGE_BYTES = 32 * 1024 * 1024
export const PUBLISH_MAX_CONTENT_LENGTH = 5000
export const PUBLISH_IMAGE_FETCH_CONCURRENCY = 3
export const PUBLISH_IMAGE_FETCH_TIMEOUT_MS = 30000

export const CONTENT_TRUNCATED_SUFFIX = '……'

export function truncateContent(
    value: string,
    limit: number = PUBLISH_MAX_CONTENT_LENGTH
): { text: string; truncated: boolean } {
    const normalized = value.replace(/\r\n/gu, '\n').trim()
    if (normalized.length <= limit) {
        return { text: normalized, truncated: false }
    }
    return {
        text: normalized.slice(0, limit) + CONTENT_TRUNCATED_SUFFIX,
        truncated: true
    }
}
