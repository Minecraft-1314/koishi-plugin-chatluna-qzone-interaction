import { send } from '@koishijs/client'

export interface QzoneBotStatus {
  platform: string
  selfId: string
  online: boolean
}

export interface QzoneRebindStats {
  inFlight: boolean
  disabled: boolean
  consecutiveFailures: number
  lastAttemptAtSeconds: number | null
  lastSuccessAtSeconds: number | null
  nextAllowedAtSeconds: number | null
}

export interface QzoneClientStatus {
  initialized: boolean
  accountId: string | null
  authenticated: boolean
  sessionUpdatedAt: string | null
  rebind: QzoneRebindStats
}

export interface QzoneRuntimeStatus {
  bot: QzoneBotStatus | null
  client: QzoneClientStatus
}

export interface QzoneRoundStats {
  discovered: number
  writeAttempts: number
  verified: number
  accepted: number
  unknown: number
  incompleteSnapshots: number
  feedPageLimitHits: number
  likeAttempts: number
  likesApplied: number
  likeAlreadyApplied: number
  retried: number
  exhausted: number
  errors: number
}

export interface QzoneRetryView {
  key: string
  kind: string
  postId: string
  authorId: string
  attempts: number
  lastFailure: string | null
  detectedAt: number
}

export interface QzoneInteractionReport {
  phase: string
  detail: string
  baselineCompletedAt: string | null
  roundStartedAt: string | null
  lastRoundAt: string | null
  monitoredPosts: number
  monitorLimit: number
  pendingTriggers: number
  maxWritesPerRound: number
  retryLimit: number
  pendingRetries: number
  retries: QzoneRetryView[]
  round: QzoneRoundStats | null
  lastError: string | null
}

export interface QzoneDigestReport {
  phase: string
  detail: string
  lastRunAt: string | null
  nextRunAt: string | null
  lastOutcome: string | null
  memoryCount: number
}

export interface QzonePublishCapability {
  enabled: boolean
  mounted: boolean
  reason: string
  detail: string
  observed: number
  published: number
  failed: number
}

export interface QzoneOverview {
  status: QzoneRuntimeStatus
  interaction: QzoneInteractionReport | null
  digest: QzoneDigestReport | null
  publish: QzonePublishCapability
  retries: QzoneRetryView[]
}

export interface QzoneFeedItem {
  id: string
  authorId: string
  authorName: string
  content: string
  createdAt: string | null
  likeCount: number
  commentCount: number
  mediaKinds: string[]
}

export interface QzoneFeedView {
  scope: string
  target: string | null
  items: QzoneFeedItem[]
}

export interface QzonePostMedia {
  kind: string
  url: string
  name: string | null
  previewUrl: string | null
  durationMs: number | null
  width: number | null
  height: number | null
}

export interface QzonePostComment {
  id: string
  authorName: string
  authorId: string
  content: string
  createdAt: string | null
  kind: string
  replyToName: string | null
}

export interface QzonePostDetail {
  id: string
  authorId: string
  authorName: string
  authorAvatar: string | null
  content: string
  createdAt: string | null
  likeCount: number
  commentCount: number
  liked: boolean
  commentsComplete: boolean
  media: QzonePostMedia[]
  comments: QzonePostComment[]
}

export interface QzoneSettings {
  allowUserIds: string[]
  platform: string
  selfId: string
  enablePublishTool: boolean
  enableDailyDigest: boolean
  digestTime: string
  digestMemoryLimit: number
  feedsDefaultLimit: number
  personaPresetId: string
  mainModel: string
  subModel: string
  friendPostCommentMode: string
  friendPostLikeMode: string
  enableInteractionWhitelist: boolean
  interactionAllowUserIds: string[]
  interactionMonitorPostLimit: number
  interactionPollIntervalMinutes: number
  interactionMaxWritesPerRound: number
  interactionWriteRetryLimit: number
  friendFeedBaselineGraceMinutes: number
  videoFrameMode: string
  videoFrameCount: number
  videoMaxMegabytes: number
  ffmpegPath: string
  debug: boolean
  publishImageLimit: number
  publishImageMegabytes: number
}

export interface QzoneActionResult {
  ok: boolean
  message: string
}

const PHASE_LABELS: Record<string, string> = {
  disabled: '已关闭',
  'waiting-config': '缺少配置',
  'waiting-bot': '等待登录',
  baselining: '建立基线',
  ready: '就绪',
  running: '运行中',
  failed: '失败',
  idle: '待触发',
}

const TRIGGER_LABELS: Record<string, string> = {
  'friend-post': '好友新动态',
  'self-comment': '自己动态下的评论',
  'friend-thread-reply': '自己评论下的回复',
}

export function phaseLabel(phase?: string | null): string {
  if (!phase) return '未知'
  return PHASE_LABELS[phase] || phase
}

export function triggerLabel(kind?: string | null): string {
  if (!kind) return '未知'
  return TRIGGER_LABELS[kind] || kind
}

export async function rpc<T>(type: string, ...args: any[]): Promise<T> {
  const request = send(type as any, ...args)
  if (!request) throw new Error('与控制台的连接还没有建立，请稍后重试。')
  return request as Promise<T>
}

export function errorText(error: unknown): string {
  const raw = typeof error === 'string' ? error : String((error as any)?.message || error || '')
  const first = raw.split('\n')[0].trim()
  return first.replace(/^Error:\s*/, '') || '操作没有成功，请稍后再试。'
}

export function formatTime(value?: string | number | null): string {
  if (!value) return '未知'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '未知'
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatEpoch(seconds?: number | null): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '未知'
  return formatTime(seconds * 1000)
}

export function relativeTime(value?: string | number | null): string {
  if (!value) return '未知'
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return '未知'
  const diff = Date.now() - time
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return formatTime(value)
}

export function preview(source: string, length = 88): string {
  const text = String(source || '').replace(/\s+/g, ' ').trim()
  if (!text) return '（无文字）'
  return text.length > length ? `${text.slice(0, length)}…` : text
}

export function mediaLabel(kinds: readonly string[]): string {
  if (!kinds || kinds.length === 0) return '无媒体'
  const counts: Record<string, number> = {}
  for (const kind of kinds) counts[kind] = (counts[kind] || 0) + 1
  const LABELS: Record<string, string> = { image: '图', video: '视频', audio: '音频', file: '文件' }
  return Object.entries(counts)
    .map(([kind, count]) => `${LABELS[kind] || kind}${count}`)
    .join(' · ')
}

export function isRemoteImage(url: string): boolean {
  return /^https?:\/\//i.test(String(url || '').trim())
}

export const SUPPORTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
]

export function isSupportedImage(file: File): boolean {
  return SUPPORTED_IMAGE_TYPES.includes(file.type)
}

export function isWithinSize(file: File, maxMB: number): boolean {
  return file.size <= Math.max(1, maxMB) * 1024 * 1024
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

export function isDataImageUrl(value: string): boolean {
  return /^data:image\//i.test(String(value || '').trim())
}
