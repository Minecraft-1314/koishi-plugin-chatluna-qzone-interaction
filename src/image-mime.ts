const GIF_SIGNATURES = ['GIF87a', 'GIF89a']

const asciiOf = (bytes: Uint8Array, start: number, end: number): string =>
    String.fromCharCode(...bytes.subarray(start, end))

export const sniffImageMime = (bytes: Uint8Array): string | null => {
    if (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
    ) {
        return 'image/jpeg'
    }
    if (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
    ) {
        return 'image/png'
    }
    if (bytes.length >= 6 && GIF_SIGNATURES.includes(asciiOf(bytes, 0, 6))) {
        return 'image/gif'
    }
    if (
        bytes.length >= 12 &&
        asciiOf(bytes, 0, 4) === 'RIFF' &&
        asciiOf(bytes, 8, 12) === 'WEBP'
    ) {
        return 'image/webp'
    }
    return null
}
