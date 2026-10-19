<template>
  <el-config-provider :locale="zhCn">
    <k-layout main="page-qzone">
      <k-content>
        <div class="qz-page">
          <header class="qz-hero">
            <div class="qz-hero-text">
              <h1>QQ 空间互动</h1>
              <p>
                查看登录态、自动互动进度与失败重试队列，也可以直接读取空间动态或发布新动态。
                评论、回复与点赞由机器人按配置自动完成，发布接口只支持文字与最多 9 张图片。
              </p>
            </div>
            <div class="qz-hero-actions">
              <label class="qz-switch">
                <span>自动刷新</span>
                <el-switch v-model="autoRefresh" />
              </label>
              <el-button :loading="loading" @click="reload">
                <k-icon name="redo" />
                <span class="qz-btn-text">刷新</span>
              </el-button>
              <el-button type="primary" @click="openCompose">
                <k-icon name="paper-plane" />
                <span class="qz-btn-text">发布动态</span>
              </el-button>
            </div>
          </header>

          <section class="qz-stats">
            <button
              v-for="card in statCards"
              :key="card.key"
              type="button"
              class="qz-stat"
              :class="'is-' + card.tone"
            >
              <span class="qz-stat-head">
                <span class="qz-stat-label">{{ card.label }}</span>
                <span class="qz-stat-dot" />
              </span>
              <span class="qz-stat-value">{{ card.value }}</span>
              <span class="qz-stat-track">
                <span class="qz-stat-fill" :style="{ transform: 'scaleX(' + card.ratio + ')' }" />
              </span>
            </button>
          </section>

          <section class="qz-grid">
            <article class="qz-card">
              <h2>登录态</h2>
              <dl class="qz-meta">
                <div><dt>协议</dt><dd>{{ botText }}</dd></div>
                <div><dt>账号</dt><dd>{{ accountText }}</dd></div>
                <div><dt>在线</dt><dd>{{ yesNo(bot && bot.online) }}</dd></div>
                <div><dt>客户端</dt><dd>{{ yesNo(client && client.initialized) }}</dd></div>
                <div><dt>登录态有效</dt><dd>{{ yesNo(client && client.authenticated) }}</dd></div>
                <div><dt>Session 更新</dt><dd>{{ formatTime(client && client.sessionUpdatedAt) }}</dd></div>
                <div><dt>自动续绑</dt><dd>{{ rebindText }}</dd></div>
              </dl>
            </article>

            <article class="qz-card">
              <h2>自动互动</h2>
              <dl class="qz-meta">
                <div><dt>阶段</dt><dd>{{ interaction ? phaseLabel(interaction.phase) : '未挂载' }}</dd></div>
                <div><dt>说明</dt><dd>{{ interaction ? interaction.detail : '未挂载' }}</dd></div>
                <div><dt>监控动态</dt><dd>{{ interaction ? interaction.monitoredPosts + ' / ' + interaction.monitorLimit : '0' }}</dd></div>
                <div><dt>待处理触发</dt><dd>{{ interaction ? interaction.pendingTriggers : 0 }}</dd></div>
                <div><dt>失败重试</dt><dd>{{ retrySummary }}</dd></div>
                <div><dt>单轮写上限</dt><dd>{{ interaction ? interaction.maxWritesPerRound : 0 }}</dd></div>
                <div><dt>基线时间</dt><dd>{{ formatTime(interaction && interaction.baselineCompletedAt) }}</dd></div>
                <div><dt>最近一轮</dt><dd>{{ relativeTime(interaction && interaction.lastRoundAt) }}</dd></div>
              </dl>
              <p v-if="roundText" class="qz-note">{{ roundText }}</p>
            </article>

            <article class="qz-card">
              <h2>每日记忆动态</h2>
              <dl class="qz-meta">
                <div><dt>阶段</dt><dd>{{ digest ? phaseLabel(digest.phase) : '未挂载' }}</dd></div>
                <div><dt>说明</dt><dd>{{ digest ? digest.detail : '未挂载' }}</dd></div>
                <div><dt>记忆条数</dt><dd>{{ digest ? digest.memoryCount : 0 }}</dd></div>
                <div><dt>最近执行</dt><dd>{{ relativeTime(digest && digest.lastRunAt) }}</dd></div>
                <div><dt>下次执行</dt><dd>{{ formatTime(digest && digest.nextRunAt) }}</dd></div>
                <div><dt>发布结果</dt><dd>{{ (digest && digest.lastOutcome) || '无' }}</dd></div>
              </dl>
              <div class="qz-card-foot">
                <el-button size="small" :loading="digesting" @click="runDigest">立即执行一次</el-button>
              </div>
            </article>

            <article class="qz-card">
              <h2>模型主动发布</h2>
              <dl class="qz-meta">
                <div><dt>配置</dt><dd>{{ yesNo(publish && publish.enabled) }}</dd></div>
                <div><dt>挂载</dt><dd>{{ yesNo(publish && publish.mounted) }}</dd></div>
                <div><dt>状态</dt><dd>{{ publish ? publish.reason : '未知' }}</dd></div>
                <div><dt>说明</dt><dd>{{ publish ? publish.detail : '' }}</dd></div>
                <div><dt>捕获标签</dt><dd>{{ publish ? publish.observed : 0 }}</dd></div>
                <div><dt>发布成功</dt><dd>{{ publish ? publish.published : 0 }}</dd></div>
                <div><dt>发布失败</dt><dd>{{ publish ? publish.failed : 0 }}</dd></div>
              </dl>
            </article>
            <article class="qz-card">
              <h2>当前配置</h2>
              <dl class="qz-meta">
                <div><dt>取登录态协议</dt><dd>{{ settings ? settings.platform : '未知' }}</dd></div>
                <div><dt>指令白名单</dt><dd>{{ settings ? settings.allowUserIds.length + ' 个账号' : '未知' }}</dd></div>
                <div><dt>好友动态评论</dt><dd>{{ modeLabel(settings && settings.friendPostCommentMode) }}</dd></div>
                <div><dt>好友动态点赞</dt><dd>{{ modeLabel(settings && settings.friendPostLikeMode) }}</dd></div>
                <div><dt>互动白名单</dt><dd>{{ settings && settings.enableInteractionWhitelist ? settings.interactionAllowUserIds.length + ' 个账号' : '已关闭' }}</dd></div>
                <div><dt>轮询间隔</dt><dd>{{ settings ? settings.interactionPollIntervalMinutes + ' 分钟' : '未知' }}</dd></div>
                <div><dt>启动回溯</dt><dd>{{ settings ? settings.friendFeedBaselineGraceMinutes + ' 分钟' : '未知' }}</dd></div>
                <div><dt>视频抽帧</dt><dd>{{ videoText }}</dd></div>
                <div><dt>每日动态</dt><dd>{{ settings ? settings.digestTime : '未知' }}</dd></div>
              </dl>
            </article>
          </section>

          <section class="qz-toolbar">
            <el-select v-model="feedScope" class="qz-select" @change="loadFeeds">
              <el-option value="self" label="我的动态" />
              <el-option value="friends" label="好友动态" />
              <el-option value="profile" label="指定用户" />
            </el-select>
            <el-select v-model="feedCount" class="qz-select" @change="loadFeeds">
              <el-option :value="5" label="读取 5 条" />
              <el-option :value="10" label="读取 10 条" />
              <el-option :value="15" label="读取 15 条" />
              <el-option :value="20" label="读取 20 条" />
            </el-select>
            <el-input
              v-if="feedScope === 'profile'"
              v-model="feedTarget"
              class="qz-search"
              placeholder="填写要读取的 QQ 号"
              clearable
              @keyup.enter="loadFeeds"
              @clear="loadFeeds"
            >
              <template #prefix>
                <k-icon name="search" />
              </template>
            </el-input>
            <el-button class="qz-reset" :loading="feedsLoading" @click="loadFeeds">读取动态</el-button>
          </section>

          <section class="qz-panel">
            <header class="qz-panel-head">
              <h2>空间动态</h2>
              <span class="qz-panel-sub">{{ feedSubtitle }}</span>
            </header>
            <el-table v-loading="feedsLoading" :data="feeds" row-key="id" class="qz-table">
              <el-table-column label="作者" width="168">
                <template #default="{ row }">
                  <p class="qz-cell-title">{{ row.authorName }}</p>
                  <p class="qz-cell-meta">{{ row.authorId }}</p>
                </template>
              </el-table-column>

              <el-table-column label="内容" min-width="260">
                <template #default="{ row }">
                  <p class="qz-cell-title" :title="row.content">{{ preview(row.content) }}</p>
                  <p class="qz-cell-meta">
                    <span>点赞 {{ row.likeCount }}</span>
                    <span>评论 {{ row.commentCount }}</span>
                    <span>{{ mediaLabel(row.mediaKinds) }}</span>
                  </p>
                </template>
              </el-table-column>

              <el-table-column label="发布时间" width="168">
                <template #default="{ row }">
                  <span :title="formatTime(row.createdAt)">{{ relativeTime(row.createdAt) }}</span>
                </template>
              </el-table-column>

              <el-table-column label="操作" width="96">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openPost(row)">详情</el-button>
                </template>
              </el-table-column>

              <template #empty>
                <div class="qz-empty">
                  <k-icon name="paper-plane" />
                  <p class="qz-empty-title">还没有读取到动态</p>
                  <p class="qz-empty-desc">点上方的「读取动态」试试，或确认机器人登录态是否正常</p>
                </div>
              </template>
            </el-table>
          </section>

          <el-drawer
            v-model="detailOpen"
            :title="detail ? '动态详情 · ' + detail.authorName : '动态详情'"
            size="620px"
            class="qz-drawer"
          >
            <div v-loading="detailLoading" class="qz-detail">
              <template v-if="detail">
                <dl class="qz-detail-grid">
                  <div><dt>作者</dt><dd>{{ detail.authorName }}（{{ detail.authorId }}）</dd></div>
                  <div><dt>发布时间</dt><dd :title="formatTime(detail.createdAt)">{{ formatTime(detail.createdAt) }}</dd></div>
                  <div><dt>点赞</dt><dd>{{ detail.likeCount }}</dd></div>
                  <div><dt>评论</dt><dd>{{ detail.commentCount }}<span v-if="!detail.commentsComplete">（快照不完整）</span></dd></div>
                  <div><dt>媒体</dt><dd>{{ detail.media.length }} 项</dd></div>
                </dl>

                <article class="qz-detail-body">
                  <p>{{ detail.content || '（无正文）' }}</p>
                </article>

                <section v-if="detail.comments.length > 0" class="qz-detail-block">
                  <h3>评论 {{ detail.comments.length }} 条</h3>
                  <ul class="qz-detail-comments">
                    <li v-for="item in detail.comments" :key="item.id">
                      <p class="qz-comment-head">
                        <strong>{{ item.authorName }}</strong>
                        <span v-if="item.replyToName">回复 {{ item.replyToName }}</span>
                        <span class="qz-comment-time">{{ relativeTime(item.createdAt) }}</span>
                      </p>
                      <p class="qz-comment-body">{{ item.content }}</p>
                    </li>
                  </ul>
                </section>
              </template>
              <div v-else-if="!detailLoading" class="qz-empty">
                <p class="qz-empty-title">未读取到详情</p>
                <p class="qz-empty-desc">{{ detailError || '请稍后重试' }}</p>
              </div>
            </div>
          </el-drawer>

          <section class="qz-panel">
            <header class="qz-panel-head">
              <h2>失败重试队列</h2>
              <span class="qz-panel-sub">
                失败会被记录并在下一轮轮询重试，重试上限 {{ interaction ? interaction.retryLimit : 0 }} 次
              </span>
            </header>
            <el-table :data="retries" row-key="key" class="qz-table">
              <el-table-column label="触发类型" width="176">
                <template #default="{ row }">
                  <span class="qz-tag is-warning">{{ triggerLabel(row.kind) }}</span>
                </template>
              </el-table-column>

              <el-table-column label="动态" width="140">
                <template #default="{ row }">
                  <span class="qz-id">{{ row.postId }}</span>
                </template>
              </el-table-column>

              <el-table-column label="作者" width="140">
                <template #default="{ row }">{{ row.authorId }}</template>
              </el-table-column>

              <el-table-column label="重试次数" width="104">
                <template #default="{ row }">{{ row.attempts }}</template>
              </el-table-column>

              <el-table-column label="最近失败原因" min-width="220">
                <template #default="{ row }">
                  <p class="qz-cell-title" :title="row.lastFailure || ''">{{ row.lastFailure || '未记录' }}</p>
                  <p class="qz-cell-meta">发现于 {{ relativeTime(row.detectedAt) }}</p>
                </template>
              </el-table-column>

              <el-table-column label="操作" width="120" align="right">
                <template #default="{ row }">
                  <el-button size="small" text @click="dropRetry(row.key)">放弃重试</el-button>
                </template>
              </el-table-column>

              <template #empty>
                <div class="qz-empty">
                  <k-icon name="check" />
                  <p class="qz-empty-title">没有等待重试的互动</p>
                  <p class="qz-empty-desc">互动失败时会出现在这里，并在下一轮自动重试</p>
                </div>
              </template>
            </el-table>
          </section>
        </div>
      </k-content>

      <el-dialog v-model="compose" title="发布空间动态" :width="composeWidth" class="qz-dialog" :close-on-click-modal="false">
        <div class="qz-form">
          <div class="qz-field">
            <span>正文</span>
            <el-input
              v-model="form.content"
              type="textarea"
              :rows="6"
              resize="none"
              maxlength="5000"
              show-word-limit
              placeholder="写下要发布到 QQ 空间的内容"
              @paste="onContentPaste"
            />
          </div>

          <div class="qz-field">
            <span>图片（最多 {{ maxImages }} 张，留空即纯文字动态）</span>
            <div class="qz-attach">
              <div class="qz-upload-row">
                <el-upload
                  :show-file-list="false"
                  :auto-upload="false"
                  :on-change="handleLocalFile"
                  accept="image/*"
                >
                  <el-button :disabled="uploading || form.attachments.length >= maxImages">
                    <k-icon name="add" />
                    <span class="qz-btn-text">{{ uploading ? '读取中' : '选择图片' }}</span>
                  </el-button>
                </el-upload>
                <el-input
                  v-model="imageUrlInput"
                  placeholder="或粘贴图片链接，按回车添加"
                  clearable
                  :disabled="form.attachments.length >= maxImages"
                  @keyup.enter="addImageUrl"
                >
                  <template #prefix>
                    <k-icon name="link" />
                  </template>
                </el-input>
                <el-button :disabled="form.attachments.length >= maxImages" @click="addImageUrl">添加</el-button>
              </div>

              <div v-if="form.attachments.length" class="qz-images">
                <div v-for="(src, index) in form.attachments" :key="index" class="qz-image-wrap">
                  <el-image
                    :src="src"
                    :preview-src-list="form.attachments"
                    :initial-index="index"
                    preview-teleported
                    fit="cover"
                    class="qz-image"
                  />
                  <button type="button" class="qz-image-remove" title="移除图片" @click="removeAttachment(index)">
                    <k-icon name="close" />
                  </button>
                </div>
              </div>

              <p class="qz-upload-hint">
                QQ 空间只支持文字与图片，单张不超过 {{ maxImageMegabytes }}MB，最多 {{ maxImages }} 张；截图可直接粘贴到正文框
              </p>
            </div>
          </div>

          <p v-if="publishHint" class="qz-note">{{ publishHint }}</p>
        </div>

        <template #footer>
          <el-button @click="compose = false">取消</el-button>
          <el-button type="primary" :loading="publishing" @click="submitPublish">发布</el-button>
        </template>
      </el-dialog>
    </k-layout>
  </el-config-provider>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { message, useStorage } from '@koishijs/client'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import {
  errorText,
  formatEpoch,
  formatTime,
  mediaLabel,
  phaseLabel,
  preview,
  relativeTime,
  rpc,
  triggerLabel,
  isRemoteImage,
  isDataImageUrl,
  isSupportedImage,
  isWithinSize,
  readFileAsDataUrl,
  type QzoneActionResult,
  type QzoneDigestReport,
  type QzoneFeedItem,
  type QzoneFeedView,
  type QzoneInteractionReport,
  type QzonePostDetail,
  type QzoneOverview,
  type QzonePublishCapability,
  type QzoneRetryView,
  type QzoneRuntimeStatus,
  type QzoneSettings,
} from './utils'

const REFRESH_INTERVAL = 30 * 1000
const MAX_IMAGES = 9

const prefs = useStorage<{ autoRefresh?: boolean; feedCount?: number }>('qzone-prefs', 1, () => ({}))
const autoRefresh = computed({
  get: () => Boolean(prefs.value.autoRefresh),
  set: (value: boolean) => {
    prefs.value.autoRefresh = value
  },
})

const loading = ref(false)
const digesting = ref(false)
const publishing = ref(false)

const status = ref<QzoneRuntimeStatus | null>(null)
const interaction = ref<QzoneInteractionReport | null>(null)
const digest = ref<QzoneDigestReport | null>(null)
const publish = ref<QzonePublishCapability | null>(null)
const retries = ref<QzoneRetryView[]>([])
const settings = ref<QzoneSettings | null>(null)

const feeds = ref<QzoneFeedItem[]>([])
const feedsLoading = ref(false)
const feedTarget = ref('')
const feedCount = computed({
  get: () => Number(prefs.value.feedCount) || 10,
  set: (value: number) => {
    prefs.value.feedCount = value
  },
})
const feedScope = ref<'self' | 'profile' | 'friends'>('self')

watch(feedScope, (value) => {
  if (value !== 'profile') feedTarget.value = ''
})

const detailOpen = ref(false)
const detailLoading = ref(false)
const detailError = ref('')
const detail = ref<QzonePostDetail | null>(null)

const compose = ref(false)
const form = ref<{ content: string; attachments: string[] }>({ content: '', attachments: [] })
const publishHint = ref('')
const imageUrlInput = ref('')
const uploading = ref(false)

let timer: ReturnType<typeof setInterval> | null = null

const maxImages = MAX_IMAGES
const maxImageMegabytes = computed(() =>
  settings.value ? settings.value.publishImageMegabytes : 32,
)
const composeWidth = computed(() => (window.innerWidth < 720 ? '94%' : '620px'))

const bot = computed(() => status.value?.bot ?? null)
const client = computed(() => status.value?.client ?? null)
const botText = computed(() => (bot.value ? bot.value.platform + ' / ' + bot.value.selfId : '未绑定'))
const accountText = computed(() => (client.value && client.value.accountId) || '无')

const rebindText = computed(() => {
  const stats = client.value && client.value.rebind
  if (!stats) return '未知'
  if (stats.disabled) return '已停用（连续失败 ' + stats.consecutiveFailures + ' 次）'
  if (stats.inFlight) return '正在续绑'
  if (stats.consecutiveFailures > 0) {
    return '退避中（' + stats.consecutiveFailures + ' 次，下次 ' + formatEpoch(stats.nextAllowedAtSeconds) + '）'
  }
  return '正常（上次成功 ' + formatEpoch(stats.lastSuccessAtSeconds) + '）'
})

const retrySummary = computed(() => {
  if (!interaction.value) return '0'
  const limit = interaction.value.retryLimit
  const pending = interaction.value.pendingRetries
  return pending + ' 条（上限 ' + limit + ' 次）'
})

const roundText = computed(() => {
  const round = interaction.value && interaction.value.round
  if (!round) return ''
  return (
    '上轮：发现 ' + round.discovered +
    '，写入 ' + round.writeAttempts +
    '（确认 ' + round.verified +
    ' / 已接受 ' + round.accepted +
    ' / 不确定 ' + round.unknown +
    '），重试 ' + round.retried +
    '，放弃 ' + round.exhausted +
    '，错误 ' + round.errors
  )
})

const videoText = computed(() => {
  const config = settings.value
  if (!config) return '未知'
  if (config.videoFrameMode === 'first') return '首帧'
  return '平均 ' + config.videoFrameCount + ' 帧'
})

const modeLabel = (mode?: string | null): string => {
  if (mode === 'forced') return '强制执行'
  if (mode === 'decide') return '交由模型判断'
  if (mode === 'off') return '关闭'
  return '未知'
}

const feedSubtitle = computed(() => {
  const scope =
    feedScope.value === 'profile'
      ? '目标 QQ'
      : feedScope.value === 'friends'
        ? '好友动态'
        : '自己'
  return scope + ' · 共 ' + feeds.value.length + ' 条'
})

const statCards = computed(() => {
  const pending = interaction.value ? interaction.value.pendingTriggers : 0
  const pendingRetries = interaction.value ? interaction.value.pendingRetries : 0
  const monitored = interaction.value ? interaction.value.monitoredPosts : 0
  const monitorLimit = interaction.value ? interaction.value.monitorLimit : 0
  const errors = interaction.value && interaction.value.round ? interaction.value.round.errors : 0
  const published = publish.value ? publish.value.published : 0
  const limit = Math.max(1, monitorLimit || 1)
  return [
    { key: 'phase', label: '互动阶段', value: phaseLabel(interaction.value && interaction.value.phase), ratio: 1, tone: 'info' },
    { key: 'pending', label: '待处理触发', value: String(pending), ratio: Math.min(1, pending / 10), tone: 'info' },
    { key: 'retry', label: '待重试', value: String(pendingRetries), ratio: Math.min(1, pendingRetries / 10), tone: pendingRetries > 0 ? 'warning' : 'success' },
    { key: 'monitor', label: '监控动态', value: String(monitored), ratio: Math.min(1, monitored / limit), tone: 'success' },
    { key: 'published', label: '模型发布成功', value: String(published), ratio: Math.min(1, published / 10), tone: 'success' },
    { key: 'errors', label: '上轮错误', value: String(errors), ratio: Math.min(1, errors / 10), tone: errors > 0 ? 'danger' : 'success' },
  ]
})

function yesNo(value: unknown): string {
  return value ? '是' : '否'
}

async function load(options: { silent?: boolean } = {}) {
  if (!options.silent) loading.value = true
  try {
    const result = await rpc<QzoneOverview>('qzone/overview')
    status.value = result.status
    interaction.value = result.interaction
    digest.value = result.digest
    publish.value = result.publish
    retries.value = result.retries || []
  } catch (error) {
    if (!options.silent) message.error(errorText(error))
  } finally {
    loading.value = false
  }
}

async function reload() {
  await load()
  await loadFeeds()
}

async function loadSettings() {
  try {
    settings.value = await rpc<QzoneSettings>('qzone/settings')
  } catch {
    settings.value = null
  }
}

async function loadFeeds() {
  feedsLoading.value = true
  try {
    const result = await rpc<QzoneFeedView>('qzone/feeds', {
      count: feedCount.value,
      scope: feedScope.value,
      target: feedScope.value === 'profile' ? feedTarget.value.trim() : '',
    })
    feeds.value = result.items || []
    feedScope.value = (result.scope as typeof feedScope.value) || 'self'
  } catch (error) {
    message.error(errorText(error))
  } finally {
    feedsLoading.value = false
  }
}

async function openPost(row: QzoneFeedItem) {
  detailOpen.value = true
  detailLoading.value = true
  detailError.value = ''
  detail.value = null
  try {
    detail.value = await rpc<QzonePostDetail>('qzone/post', {
      id: row.id,
      authorId: row.authorId,
    })
  } catch (error) {
    detailError.value = errorText(error)
    message.error(errorText(error))
  } finally {
    detailLoading.value = false
  }
}

async function runDigest() {
  digesting.value = true
  try {
    const result = await rpc<QzoneActionResult>('qzone/digest-run')
    if (result.ok) message.success(result.message)
    else message.warning(result.message)
    await load({ silent: true })
  } catch (error) {
    message.error(errorText(error))
  } finally {
    digesting.value = false
  }
}

async function dropRetry(key: string) {
  try {
    const result = await rpc<QzoneActionResult>('qzone/retry-drop', { key })
    if (result.ok) message.success(result.message)
    else message.warning(result.message)
    await load({ silent: true })
  } catch (error) {
    message.error(errorText(error))
  }
}

function openCompose() {
  form.value = { content: '', attachments: [] }
  imageUrlInput.value = ''
  publishHint.value = ''
  compose.value = true
}

function pushAttachment(value: string) {
  const url = value.trim()
  if (!url) return
  if (form.value.attachments.length >= maxImages) {
    publishHint.value = '最多只能添加 ' + maxImages + ' 张图片'
    return
  }
  if (form.value.attachments.includes(url)) return
  form.value.attachments.push(url)
}

async function handleLocalFile(event: any) {
  const file: File | undefined = event?.raw ?? event?.target?.files?.[0]
  if (!file) return
  if (!isSupportedImage(file)) {
    publishHint.value = '只支持 PNG、JPEG、GIF、WebP 图片'
    return
  }
  if (!isWithinSize(file, maxImageMegabytes.value)) {
    publishHint.value = '单张图片不能超过 ' + maxImageMegabytes.value + 'MB'
    return
  }
  uploading.value = true
  publishHint.value = ''
  try {
    pushAttachment(await readFileAsDataUrl(file))
  } catch (error) {
    publishHint.value = errorText(error)
  } finally {
    uploading.value = false
  }
}

function addImageUrl() {
  const url = imageUrlInput.value.trim()
  if (!url) return
  if (!isRemoteImage(url)) {
    publishHint.value = '图片链接必须以 http:// 或 https:// 开头'
    return
  }
  pushAttachment(url)
  imageUrlInput.value = ''
}

function removeAttachment(index: number) {
  form.value.attachments.splice(index, 1)
}

async function onContentPaste(event: any) {
  const items = Array.from(event?.clipboardData?.items ?? []) as any[]
  for (const item of items) {
    if (item.type?.startsWith('image/') !== true) continue
    const file = item.getAsFile?.()
    if (!file) continue
    await handleLocalFile({ raw: file })
  }
}

async function submitPublish() {
  const content = form.value.content.trim()
  const attachments = form.value.attachments.filter((item) => item.trim().length > 0)
  if (!content && attachments.length === 0) {
    publishHint.value = '正文和图片都为空，无法发布'
    return
  }
  const images = attachments.filter((item) => isDataImageUrl(item))
  const imageUrls = attachments.filter((item) => !isDataImageUrl(item))
  const invalid = imageUrls.filter((item) => !isRemoteImage(item))
  if (invalid.length > 0) {
    publishHint.value = '图片链接必须以 http:// 或 https:// 开头'
    return
  }
  publishing.value = true
  publishHint.value = ''
  try {
    const result = await rpc<QzoneActionResult>('qzone/publish', { content, imageUrls, images })
    if (result.ok) {
      message.success(result.message)
      compose.value = false
      await load({ silent: true })
    } else {
      publishHint.value = result.message
      message.warning(result.message)
    }
  } catch (error) {
    publishHint.value = errorText(error)
    message.error(publishHint.value)
  } finally {
    publishing.value = false
  }
}

function startTimer() {
  stopTimer()
  timer = setInterval(() => {
    if (autoRefresh.value) void load({ silent: true })
  }, REFRESH_INTERVAL)
}

function stopTimer() {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

watch(autoRefresh, () => {
  if (autoRefresh.value) startTimer()
  else stopTimer()
})

onMounted(async () => {
  await load()
  await loadSettings()
  await loadFeeds()
  if (autoRefresh.value) startTimer()
})

onUnmounted(() => {
  stopTimer()
})
</script>

<style scoped>
.qz-detail {
  min-height: 200px;
}
.qz-detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 20px;
  margin: 0 0 18px;
}
.qz-detail-grid div {
  display: flex;
  gap: 8px;
  font-size: 13px;
}
.qz-detail-grid dt {
  color: var(--k-text-3);
  flex: none;
}
.qz-detail-grid dd {
  margin: 0;
  color: var(--k-text-1);
  overflow-wrap: anywhere;
}
.qz-detail-body {
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--k-fill-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 14px;
  line-height: 1.7;
}
.qz-detail-block {
  margin-top: 20px;
}
.qz-detail-block h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--k-text-2);
  margin: 0 0 10px;
}
.qz-detail-comments {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.qz-detail-comments li {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--k-fill-2);
}
.qz-comment-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 4px;
  font-size: 13px;
}
.qz-comment-head span {
  color: var(--k-text-3);
  font-size: 12px;
}
.qz-comment-time {
  margin-left: auto;
}
.qz-comment-body {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .qz-detail-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
.qz-page {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.qz-hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.qz-hero-text h1 {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--k-text-dark);
}

.qz-hero-text p {
  margin: 0.4rem 0 0;
  max-width: 46rem;
  color: var(--k-text-normal);
  font-size: 0.875rem;
  line-height: 1.6;
}

.qz-hero-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-shrink: 0;
}

.qz-switch {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  color: var(--k-text-normal);
  font-size: 0.8125rem;
  cursor: pointer;
}

.qz-btn-text {
  margin-left: 0.25rem;
}

.qz-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(136px, 1fr));
  gap: 0.75rem;
}

.qz-stat {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.85rem 0.95rem 0.75rem;
  border: 1px solid var(--k-color-border);
  border-radius: 8px;
  background: var(--k-card-bg);
  text-align: left;
  cursor: default;
  transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
}

.qz-stat:hover {
  transform: translateY(-2px);
  box-shadow: var(--k-card-shadow);
}

.qz-stat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.qz-stat-label {
  color: var(--k-text-normal);
  font-size: 0.8125rem;
}

.qz-stat-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--k-text-light);
}

.qz-stat.is-info .qz-stat-dot { background: var(--k-color-info); }
.qz-stat.is-success .qz-stat-dot { background: var(--k-color-success); }
.qz-stat.is-warning .qz-stat-dot { background: var(--k-color-warning); }
.qz-stat.is-danger .qz-stat-dot { background: var(--k-color-danger); }

.qz-stat-value {
  font-size: 1.5rem;
  font-weight: 600;
  line-height: 1.1;
  color: var(--k-text-dark);
}

.qz-stat-track {
  display: block;
  height: 3px;
  border-radius: 999px;
  background: var(--k-activity-bg);
  overflow: hidden;
}

.qz-stat-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  transform-origin: left center;
  transition: transform 0.45s cubic-bezier(0.22, 1, 0.36, 1);
  background: var(--k-color-info);
}

.qz-stat.is-success .qz-stat-fill { background: var(--k-color-success); }
.qz-stat.is-warning .qz-stat-fill { background: var(--k-color-warning); }
.qz-stat.is-danger .qz-stat-fill { background: var(--k-color-danger); }

.qz-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 0.75rem;
}

.qz-card {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  border: 1px solid var(--k-color-border);
  border-radius: 8px;
  background: var(--k-card-bg);
}

.qz-card h2 {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--k-text-dark);
}

.qz-card-foot {
  margin-top: auto;
  display: flex;
  justify-content: flex-end;
}

.qz-meta {
  display: grid;
  gap: 0.4rem;
  margin: 0;
}

.qz-meta > div {
  display: flex;
  gap: 0.6rem;
  font-size: 0.8125rem;
  line-height: 1.5;
}

.qz-meta dt {
  flex: 0 0 5.5rem;
  color: var(--k-text-normal);
}

.qz-meta dd {
  margin: 0;
  color: var(--k-text-dark);
  word-break: break-word;
}

.qz-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}

.qz-search {
  flex: 1 1 20rem;
  min-width: 12rem;
}

.qz-select {
  width: 10rem;
}

.qz-panel {
  border: 1px solid var(--k-color-border);
  border-radius: 8px;
  background: var(--k-card-bg);
  overflow: hidden;
}

.qz-panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.85rem 0.9rem;
  border-bottom: 1px solid var(--k-color-divider);
}

.qz-panel-head h2 {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--k-text-dark);
}

.qz-panel-sub {
  color: var(--k-text-normal);
  font-size: 0.75rem;
}

.qz-table {
  width: 100%;
  --el-table-bg-color: transparent;
  --el-table-tr-bg-color: transparent;
  --el-table-header-bg-color: var(--k-activity-bg);
  --el-table-header-text-color: var(--k-text-normal);
  --el-table-text-color: var(--k-text-dark);
  --el-table-border-color: var(--k-color-divider);
  --el-table-row-hover-bg-color: var(--k-hover-bg);
}

:deep(.qz-table th.el-table__cell) {
  font-weight: 500;
}

.qz-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-weight: 600;
  color: var(--k-text-dark);
}

.qz-tag {
  display: inline-flex;
  align-items: center;
  padding: 0.1rem 0.5rem;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 0.75rem;
  line-height: 1.5;
  white-space: nowrap;
  background: var(--k-activity-bg);
  color: var(--k-text-normal);
}

.qz-tag.is-warning {
  background: var(--k-color-warning-fade);
  border-color: var(--k-color-warning);
}

.qz-cell-title {
  margin: 0;
  color: var(--k-text-dark);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qz-cell-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0.2rem 0 0;
  color: var(--k-text-normal);
  font-size: 0.75rem;
}

.qz-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.35rem;
  padding: 2.25rem 1rem;
  color: var(--k-text-normal);
}

.qz-empty :deep(svg) {
  width: 34px;
  height: 34px;
  opacity: 0.55;
}

.qz-empty-title {
  margin: 0.35rem 0 0;
  color: var(--k-text-normal);
}

.qz-empty-desc {
  margin: 0;
  font-size: 0.8125rem;
}

.qz-note {
  margin: 0;
  color: var(--k-text-normal);
  font-size: 0.8125rem;
  line-height: 1.6;
}

.qz-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.qz-field {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  font-size: 0.8125rem;
  color: var(--k-text-normal);
}

.qz-upload-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
}

.qz-upload-row :deep(.el-input) {
  flex: 1 1 12rem;
  min-width: 10rem;
}

.qz-upload-hint {
  color: var(--k-text-normal);
  font-size: 0.8125rem;
}

.qz-attach {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  width: 100%;
}

.qz-images {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.qz-image {
  width: 96px;
  height: 96px;
  border-radius: 8px;
  border: 1px solid var(--k-color-divider);
  overflow: hidden;
  transition: transform 0.18s ease;
}

.qz-image:hover {
  transform: scale(1.02);
}

.qz-image-wrap {
  position: relative;
}

.qz-image-remove {
  position: absolute;
  top: 0.25rem;
  right: 0.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.qz-image-remove :deep(svg) {
  width: 11px;
  height: 11px;
}

.qz-image-wrap:hover .qz-image-remove,
.qz-image-remove:focus-visible {
  opacity: 1;
}

.qz-image-remove:focus-visible {
  outline: 2px solid var(--k-color-primary);
  outline-offset: 1px;
}

@media (max-width: 900px) {
  .qz-hero {
    flex-direction: column;
  }

  .qz-hero-actions {
    width: 100%;
    flex-wrap: wrap;
  }
}

@media (max-width: 640px) {
  .qz-select {
    width: calc(50% - 0.4rem);
  }

  .qz-search {
    flex-basis: 100%;
  }

  .qz-reset {
    flex: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .qz-stat,
  .qz-stat-fill,
  .qz-image,
  .qz-image-remove {
    transition: none;
  }

  .qz-stat:hover,
  .qz-image:hover {
    transform: none;
  }
}
</style>
