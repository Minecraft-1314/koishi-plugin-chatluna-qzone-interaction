# 媒体处理说明

本文档说明插件如何读取与发布 QQ 空间动态中的图片和视频，包括数量上限、体积限制、视频抽帧规则与降级行为。

---

## 1. 内容形态上限

QQ 空间单条动态最多是以下五种形态之一，图片与视频互斥。

| 形态 | 图片上限 | 视频上限 |
|------|----------|----------|
| 图片 + 文字 | 9 | 0 |
| 视频 + 文字 | 0 | 1 |
| 仅图片 | 9 | 0 |
| 仅视频 | 0 | 1 |
| 仅文字 | 0 | 0 |

插件在读取侧按上表处理，在发布侧只支持图片与文字（原因见 [第 3.2 节](#32-发布侧不支持视频)）。

---

## 2. 图片

### 2.1 读取侧

| 项目 | 值 | 说明 |
|------|-----|------|
| 单条动态图片上限 | 9 张 | 超出部分标记 `unresolved:image-count-limit` |
| 直接附给模型的格式 | `image/jpeg`、`image/png`、`image/webp` | 需模型声明 `image_input` 能力且接受该 MIME |
| 单张体积预算（base64 后） | 20MB | 优先采用模型自带的 `maxFileSizeBytes` |
| 合计体积预算（base64 后） | 60MB | 优先采用模型自带的 `maxTotalSizeBytes` |
| 下载超时 | 30 秒 | 超时标记 `unresolved:download-or-format` |

处理流程：

1. 下载图片并按文件签名（魔数）判定真实格式，不信任声明的 MIME 或扩展名。
2. 若模型能直接接受该格式，且未超出体积预算，则作为图片直接送入模型。
3. 否则在可用时走描述通道（`chatluna.multimodal` 的 messageTransformer）把图片转成文字。
4. 装了 `chatluna-storage-service` 时先把图片上传中转再附 URL，失败自动回退为 data URL。

### 2.2 发布侧

| 规则 | 值 |
|------|-----|
| 单条动态图片上限 | **9 张**，本地图片与远程图片合计计算 |
| 超出处理 | 整条拒绝并提示当前提交了多少张，**不会只发一部分** |
| 单张体积上限 | 32MB |
| 允许的真实格式 | `image/jpeg`、`image/png`、`image/gif`、`image/webp` |
| 格式不符处理 | 直接拒绝并提示「仅支持 JPEG / PNG / GIF / WebP」，不会把不可识别的文件交给接口 |
| 校验方式 | Base64 解码后用魔法数字重新嗅探，伪装成图片的文件会被拒绝 |
| 远程图片协议 | 仅 `http` 与 `https` |

图片有三种来源，可混合使用：

- `qzone.publish` 指令取同条消息的 `img` 元素
- 控制台页面选择本地文件（转 data URL 提交）
- 控制台页面粘贴截图或填写图片链接

任一张图片下载或校验失败，本次发布整体取消。

---

## 3. 视频

### 3.1 读取侧

单条动态最多处理 **1 段视频**，超出部分标记 `unresolved:video-count-limit`。

插件不会把视频文件直接送给模型，而是抽帧成 JPEG 图片，再走与图片完全相同的通道。

#### 帧率约定

视频按 **一秒一帧** 建立可抽取帧序列，长度如下：

```text
总帧数 = floor(时长秒) + 1
帧下标 = 0, 1, 2, ..., floor(时长秒)
```

例如 5.4 秒的视频，可抽取帧为第 0 到第 5 秒，共 6 帧。

#### 首帧模式（`videoFrameMode = first`）

只抽取第 0 秒的 1 帧。

#### 平均帧模式（`videoFrameMode = average`）

把整段帧序列等分成 `videoFrameCount` 份，第 i 个等分点取：

```text
帧下标_i = floor(i × 总帧数 ÷ 份数)，i = 0 .. 份数-1
```

份数超过总帧数时按总帧数封顶，不会重复抽取同一帧。

| 视频时长 | 总帧数 | 份数 | 实际抽取的秒数 |
|----------|--------|------|----------------|
| 5 秒 | 6 | 3 | 0、2、4 |
| 12 秒 | 13 | 4 | 0、3、6、9 |
| 5 秒 | 6 | 10 | 0、1、2、3、4、5（封顶为 6 帧） |
| 2 秒 | 3 | 1 | 0 |
| 无法探测时长 | 1 | 任意 | 0（退化为首帧） |

#### 可执行文件解析顺序

```text
1. 配置项 ffmpegPath（非空时优先）
2. ctx.ffmpeg.executable（安装了 koishi-plugin-ffmpeg-path）
3. PATH 中的 ffmpeg
```

时长优先用同目录下的 `ffprobe` 获取；没有 `ffprobe` 时解析 `ffmpeg -i` 的输出。

#### 降级行为

| 情况 | 结果 |
|------|------|
| 未安装 ffmpeg | 视频标记 `unresolved:video-frames-unavailable`，其余媒体照常处理 |
| 视频体积超过 `videoMaxMegabytes` | 同上，并在日志中记录超限 |
| 抽帧全部失败 | 同上 |
| 抽出的帧因体积预算无法附加 | 标记 `unresolved:frame-budget` |
| ffmpeg 缺失但模型能读图片 | 仍会尝试，失败则降级 |

视频下载超时 60 秒，单个视频默认上限 64MB。

### 3.2 发布侧不支持视频

`qzone-sdk` 0.3.3 的 `PublishPostOptions` 只有 `content` 与 `images`，其类型定义明确标注视频“第一阶段只支持读取，不支持发布”。

因此 `qzone.publish` 与控制台发布面板遇到视频附件时会给出明确提示而不是静默丢弃：

```text
本次不发布：QQ 空间发布接口当前只支持文字与最多 9 张图片，视频发布尚未支持。请去掉视频后重新执行
```

---

## 4. 其它文件格式

QQ 空间只承载文字、图片与视频。`audio`、`file`、`record` 等附件属于越界格式：

- 读取侧：按元数据列出，标记 `status=metadata-only`，不送入模型
- 发布侧：整条拒绝并说明不支持的文件类型

---

## 5. 送入模型的 status 取值速查

这些取值会出现在提示词的 `<media>` 段落中，含义可被 `<promptMedia>` 段落覆盖说明。

| status | 含义 |
|--------|------|
| `attached` | 已作为图片直接送入模型 |
| `described` | 已通过描述通道转成文字 |
| `metadata-only` | 只有元数据，内容未送入模型 |
| `unresolved:image-count-limit` | 超过单条动态 9 张图片上限 |
| `unresolved:video-count-limit` | 超过单条动态 1 段视频上限 |
| `unresolved:model-no-image-input-capability` | 模型未声明图片输入能力 |
| `unresolved:model-mime-not-accepted` | 模型不接受该图片格式 |
| `unresolved:mime-not-supported-directly` | 真实格式不能直接附给模型 |
| `unresolved:image-size-limit` | 单张图片超出体积预算 |
| `unresolved:total-size-limit` | 合计体积超出预算 |
| `unresolved:download-or-format` | 下载失败或格式无法识别 |
| `unresolved:video-frames-unavailable` | 视频抽帧不可用 |
| `unresolved:frame-budget` | 抽出的帧因体积预算被全部放弃 |

---

## 6. 相关配置

| 配置项 | 影响 |
|--------|------|
| `videoFrameMode` | 视频抽首帧还是平均帧 |
| `videoFrameCount` | 平均帧的等分份数 |
| `videoMaxMegabytes` | 单个视频下载体积上限 |
| `ffmpegPath` | ffmpeg 可执行文件路径 |
| `promptMedia` | 向模型解释上述 status 取值 |

图片数量 9 张、单张 32MB 为 QQ 空间的硬上限，不提供配置项。
