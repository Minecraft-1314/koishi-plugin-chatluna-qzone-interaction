# koishi-plugin-chatluna-qzone-interaction

## 文档目录

| 文档 | 说明 |
|------|------|
| [PRESET.md](docs/PRESET.md) | 将 `<qzone_publish />` 标签说明注入到主插件与伪装插件预设的方法 |

## 项目介绍

这是一个让 ChatLuna 角色活跃在自己 QQ 空间上的插件。它会自动评论好友的新动态、回复自己动态下的新评论、给好友的新动态点赞，并可按定时把当天记忆写成一条日记体动态发布。此外提供 `qzone.*` 指令，可随时手动读取动态、发布图文、查看运行状态。

本项目基于 [koishi-plugin-chatluna-livingdiary](https://github.com/Procyon-Nan/koishi-plugin-chatluna-livingdiary) 分支（fork）开发，加入了可配置的评论／点赞模式。因包名不同以避免与上游冲突。

插件的全部决策均通过纯文本契约完成，**不要求模型具备工具调用能力**。

## 项目仓库

- GitHub：https://github.com/Minecraft-1314/koishi-plugin-chatluna-qzone-interaction
- Issues：https://github.com/Minecraft-1314/koishi-plugin-chatluna-qzone-interaction/issues

## 核心指令

| 指令 | 说明 | 示例 |
|------|------|------|
| `qzone` | 查看子指令列表 | `qzone` |
| `qzone.status` | 查看登录态与各功能运行状态 | `qzone.status` |
| `qzone.feeds [count] [-t <qq>]` | 读取 QQ 空间动态 | `qzone.feeds 5` |
| `qzone.publish <content>` | 发布动态，同条消息附图即为图文动态 | `qzone.publish 今天天气不错` |
| `qzone.digest` | 手动执行一次今日记忆动态 | `qzone.digest` |

发布动态时的图片规则：最多 9 张、单张不超过 32MB，正文过长自动截断，
被回复的内容不会进入正文。**任一图片下载失败时本次不发布**，不会出现只发一半的情况。

| 发布结果 | 含义 | 后续处理 |
|----------|------|----------|
| 发布成功 | 已读取确认 | 无需处理 |
| 服务端已接受、尚未读回 | 已发送但未确认 | 稍后用 `qzone.feeds` 核对 |
| 结果不确定 | **无法确认是否成功** | 先用 `qzone.feeds` 核对，未发布时手动重发 |

> 结果不确定时插件不会自动重发，以避免重复发布。

## 配置项说明

### 基础设置

| 配置项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `allowUserIds` | array | `[]` | 允许使用指令的 QQ 号列表，**留空表示所有指令对所有人关闭** |
| `selfId` | string | 空 | 绑定的机器人账号，留空时在选定协议内自动选第一个在线的 |
| `platform` | string | `auto` | 取登录态的协议：`auto` 自动（优先 OneBot，没有则回退 Milky）/ `onebot` 仅 OneBot / `milky` 仅 Milky |
| `rebindMinIntervalSeconds` | number | `60` | 两次自动续绑之间的最小间隔（秒） |
| `rebindBackoffSeconds` | number | `60` | 续绑失败退避基数（秒），随失败次数增长，封顶 300 |
| `rebindMaxConsecutiveFailures` | number | `3` | 连续失败达到该次数后停止自动续绑 |
| `debug` | boolean | `false` | 开启调试日志，**日志含动态正文与人设，仅建议临时开启** |

### 模型设置

| 配置项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `personaPresetId` | string | 空 | 评论互动与每日记忆动态共用的人设预设 |
| `subModel` | string | 无 | 生成评论与回复内容的模型 |
| `mainModel` | string | 无 | 生成每日记忆动态的模型 |

### 空间动态设置

| 配置项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `feedsDefaultLimit` | number | `5` | `qzone.feeds` 默认读取的动态条数，1 到 10 |
| `enablePublishTool` | boolean | `true` | 启用让模型主动发布到空间的能力 |

### 每日记忆动态设置

| 配置项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enableDailyDigest` | boolean | `false` | 启用定时发布，需要 ChatLuna 与任一记忆插件 |
| `digestTime` | string | `23:00` | 触发时刻（HH:mm，服务器本地时区），错过不补发 |
| `digestMemoryLimit` | number | `100` | 送入模型的当日记忆条数上限，10 到 200，超出保留最新条目 |

### 评论互动设置

| 配置项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enableInteractionWhitelist` | boolean | `true` | 是否只与白名单中的 QQ 号互动，关闭后与所有用户互动 |
| `interactionAllowUserIds` | array | `[]` | 允许自动评论或回复的用户 QQ 号，与指令白名单相互独立 |
| `friendPostCommentMode` | string | `off` | 对好友新动态的评论方式：`off` 关闭 / `forced` 强制评论（模型无权否决）/ `decide` 交由模型判断 |
| `friendPostLikeMode` | string | `off` | 对好友新动态的点赞方式：`off` 关闭 / `forced` 强制点赞 / `decide` 交由模型判断 |
| `interactionMonitorPostLimit` | number | `10` | 持续监控的最新活动动态数，0 关闭评论区自动回复 |
| `interactionPollIntervalMinutes` | number | `60` | 轮询间隔（分钟），1 到 720，**下限 1 分钟** |
| `interactionMaxWritesPerRound` | number | `5` | 单轮写请求上限（评论、回复、点赞共用），1 到 20 |

> `friendPostCommentMode` 与 `friendPostLikeMode` 相互独立，可自由组合。评论区回复始终为强制回复，不受这两个配置影响。

### 提示词设置

| 配置项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `promptSystemInteraction` | string | 完整提示词 | 自动互动评论与回复的完整系统提示词 |
| `promptSystemDigest` | string | 完整提示词 | 每日记忆动态的完整系统提示词 |
| `promptTask` | string | 见预设 | 任务说明段落 |
| `promptMedia` | string | 见预设 | 媒体规则段落，说明各 `status` 含义 |
| `promptWriting` | string | 见预设 | 写作规则段落，约束语气与篇幅 |
| `promptDigestTask` | string | 见预设 | 每日记忆动态的任务段落 |
| `promptDigestVoice` | string | 见预设 | 每日记忆动态的语气段落 |
| `promptPublishTool` | string | 见预设 | 注入模型的发布标签说明 |

> 所有提示词配置留空时均回退到内置默认值。注入方式详见 [PRESET.md](docs/PRESET.md)。

## 支持的模式

评论与点赞各自独立选择处理方式，可自由组合。

| 评论模式 | 点赞模式 | 效果 |
|----------|----------|------|
| `off` | `off` | 两者均不执行 |
| `forced` | `forced` | 每条新动态必定评论并点赞 |
| `forced` | `decide` | 必定评论，是否点赞由模型判断 |
| `decide` | `forced` | 评论由模型判断，必定点赞 |
| `decide` | `decide` | 两者均由模型判断 |
| `off` | `forced` | 仅点赞，不发表评论 |

## 依赖说明

| 依赖 | 必需性 | 用途 |
|------|--------|------|
| `koishi-plugin-chatluna` | 必需 | 创建模型、渲染人设预设 |
| OneBot 或 Milky 机器人 | 必需 | 提供 QQ 空间登录态 |
| `koishi-plugin-chatluna-character` | 可选 | 让模型主动发布到空间 |
| `koishi-plugin-chatluna-memory` | 可选 | 每日记忆动态的记忆来源 |
| `koishi-plugin-chatluna-livingmemory` | 可选 | 每日记忆动态的记忆来源，与上者二选一 |
| `koishi-plugin-chatluna-multimodal-service` | 可选 | 让角色看懂动态中的图片 |
| `koishi-plugin-chatluna-storage-service` | 可选 | 图片中转，减小请求体积 |

> 记忆插件两者都安装时优先使用 `chatluna-memory`。

## 项目贡献者

| 贡献者 | 贡献内容 |
|------|------|
| Procyon-Nan | 上游项目 [koishi-plugin-chatluna-livingdiary](https://github.com/Procyon-Nan/koishi-plugin-chatluna-livingdiary) 作者 |
| Minecraft-1314 | 本仓库开发：补全上游功能、纯文本决策契约、图片描述通道、评论与点赞模式、Milky 协议、互动白名单、可编辑提示词 |

> 欢迎通过 Issues 或 PR 加入贡献者列表。

## 许可协议

本项目采用 MIT 许可证。

## 支持我们

如果这个项目对您有帮助，欢迎点亮右上角的 Star 支持我们！
