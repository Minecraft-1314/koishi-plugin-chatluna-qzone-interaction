import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from 'koishi'
import { type VideoFrameMode, safeTrimmed } from '../config'

const DEFAULT_FFMPEG_EXECUTABLE = 'ffmpeg'

const DOWNLOAD_TIMEOUT_MS = 60000
const PROBE_TIMEOUT_MS = 20000
const FRAME_TIMEOUT_MS = 20000
const MAX_PROCESS_OUTPUT = 8 * 1024 * 1024
const FRAME_MIME_TYPE = 'image/jpeg'
const SECONDS_PER_FRAME = 1
const DURATION_PATTERN = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/u

export interface VideoFrameOptions {
    readonly executable: string
    readonly mode: VideoFrameMode
    readonly count: number
    readonly maxBytes: number
}

export interface VideoFrameSet {
    readonly frames: readonly Uint8Array[]
    readonly mime: string
    readonly durationMs: number | null
    readonly sampledSeconds: readonly number[]
}

export class VideoFrameError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'VideoFrameError'
    }
}

const textOf = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
    return ''
}

const runBinary = (
    executable: string,
    args: readonly string[],
    timeoutMs: number
): Promise<{ stdout: Buffer; stderr: string }> =>
    new Promise((resolve, reject) => {
        execFile(
            executable,
            [...args],
            {
                timeout: timeoutMs,
                maxBuffer: MAX_PROCESS_OUTPUT,
                windowsHide: true,
                encoding: 'buffer'
            },
            (error, stdout, stderr) => {
                const stderrText = textOf(stderr)
                if (error) {
                    reject(
                        new VideoFrameError(
                            stderrText.trim() || error.message
                        )
                    )
                    return
                }
                resolve({ stdout: Buffer.from(stdout), stderr: stderrText })
            }
        )
    })

const probeExecutableOf = (executable: string): string => {
    const base = executable.replace(/[^\\/]*$/u, '')
    const lower = executable.toLowerCase()
    const suffix = lower.endsWith('.exe') ? '.exe' : ''
    return base + 'ffprobe' + suffix
}

const durationFromFfprobe = (output: string): number | null => {
    const seconds = Number.parseFloat(output.trim())
    if (!Number.isFinite(seconds) || seconds <= 0) return null
    return Math.round(seconds * 1000)
}

const durationFromFfmpegBanner = (text: string): number | null => {
    const matched = DURATION_PATTERN.exec(text)
    if (matched === null) return null
    const hours = Number(matched[1])
    const minutes = Number(matched[2])
    const seconds = Number(matched[3])
    const total = (hours * 3600 + minutes * 60 + seconds) * 1000
    return Number.isFinite(total) && total > 0 ? Math.round(total) : null
}

const probeDurationMs = async (
    executable: string,
    file: string
): Promise<number | null> => {
    try {
        const probed = await runBinary(
            probeExecutableOf(executable),
            [
                '-v',
                'error',
                '-show_entries',
                'format=duration',
                '-of',
                'default=nw=1:nk=1',
                file
            ],
            PROBE_TIMEOUT_MS
        )
        const fromProbe = durationFromFfprobe(
            probed.stdout.toString('utf8')
        )
        if (fromProbe !== null) return fromProbe
    } catch {
        void 0
    }
    try {
        await runBinary(
            executable,
            ['-nostdin', '-hide_banner', '-i', file],
            PROBE_TIMEOUT_MS
        )
        return null
    } catch (error) {
        return durationFromFfmpegBanner(
            error instanceof VideoFrameError ? error.message : ''
        )
    }
}

export const sampleFrameSeconds = (
    durationMs: number | null,
    mode: VideoFrameMode,
    count: number
): readonly number[] => {
    if (mode === 'first') return [0]
    const totalFrames =
        durationMs === null
            ? 1
            : Math.max(
                  1,
                  Math.floor(durationMs / (SECONDS_PER_FRAME * 1000)) + 1
              )
    const wanted = Math.max(1, Math.min(Math.floor(count), totalFrames))
    if (wanted <= 1) return [0]
    const seconds: number[] = []
    for (let index = 0; index < wanted; index += 1) {
        seconds.push(
            Math.floor((index * totalFrames) / wanted) * SECONDS_PER_FRAME
        )
    }
    return seconds
}

export const resolveFfmpegExecutable = (
    ctx: Context,
    configured: unknown
): string => {
    const trimmed = safeTrimmed(configured)
    if (trimmed.length > 0) return trimmed
    const service = ctx.get('ffmpeg' as never) as
        | { executable?: unknown }
        | undefined
    const fromService = safeTrimmed(service?.executable)
    if (fromService.length > 0) return fromService
    return DEFAULT_FFMPEG_EXECUTABLE
}

const readSource = async (
    http: Context['http'],
    url: string,
    maxBytes: number,
    signal?: AbortSignal
): Promise<Buffer> => {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        throw new VideoFrameError('视频地址无法解析')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new VideoFrameError('视频地址协议不受支持')
    }
    const buffer: ArrayBuffer = await http.get(parsed.toString(), {
        responseType: 'arraybuffer',
        headers: { accept: 'video/*,*/*' },
        timeout: DOWNLOAD_TIMEOUT_MS,
        signal
    })
    const bytes = Buffer.from(new Uint8Array(buffer))
    if (bytes.byteLength === 0) throw new VideoFrameError('视频内容为空')
    if (bytes.byteLength > maxBytes) {
        throw new VideoFrameError(
            `视频 ${bytes.byteLength} 字节超过上限 ${maxBytes} 字节`
        )
    }
    return bytes
}

export async function extractVideoFrames(
    http: Context['http'],
    url: string,
    options: VideoFrameOptions,
    signal?: AbortSignal
): Promise<VideoFrameSet> {
    const source = await readSource(http, url, options.maxBytes, signal)
    const workspace = await mkdtemp(join(tmpdir(), 'qzone-video-'))
    try {
        const input = join(workspace, 'source.bin')
        await writeFile(input, source)
        signal?.throwIfAborted()
        const durationMs = await probeDurationMs(options.executable, input)
        const seconds = sampleFrameSeconds(
            durationMs,
            options.mode,
            options.count
        )
        const frames: Uint8Array[] = []
        const sampled: number[] = []
        for (const [index, second] of seconds.entries()) {
            signal?.throwIfAborted()
            const output = join(workspace, `frame-${index}.jpg`)
            await runBinary(
                options.executable,
                [
                    '-nostdin',
                    '-y',
                    '-loglevel',
                    'error',
                    '-ss',
                    String(second),
                    '-i',
                    input,
                    '-frames:v',
                    '1',
                    '-f',
                    'image2',
                    '-vcodec',
                    'mjpeg',
                    '-q:v',
                    '3',
                    output
                ],
                FRAME_TIMEOUT_MS
            )
            const frame = await readFile(output)
            if (frame.byteLength === 0) continue
            frames.push(new Uint8Array(frame))
            sampled.push(second)
        }
        if (frames.length === 0) {
            throw new VideoFrameError('未能从视频中抽取到任何画面')
        }
        return {
            frames,
            mime: FRAME_MIME_TYPE,
            durationMs,
            sampledSeconds: sampled
        }
    } finally {
        await rm(workspace, { recursive: true, force: true }).catch(
            () => undefined
        )
    }
}
