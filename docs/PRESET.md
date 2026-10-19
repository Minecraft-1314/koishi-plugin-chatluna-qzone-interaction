# koishi-plugin-chatluna-qzone-interaction XML 注入

本文档说明如何把 `<qzone_publish />` 标签说明写入 ChatLuna 主插件与伪装插件的预设。

---

## 1. 需要注入的内容

插件共有三处 XML 契约，**只有这一处需要写入预设**。

| 契约 | 用途 | 是否写入预设 |
|------|------|--------------|
| `<qzone_decision>` | 自动评论与回复 | 否，插件自行调用模型，提示词由插件配置项控制 |
| `<qzone_digest>` | 每日记忆动态 | 否，同上 |
| `<qzone_publish />` | 模型主动发布到空间 | **是** |

需注入的内容取自插件配置项 `promptPublishTool` 的值，默认值如下：

```text
当你确实需要把某段内容发布到自己的 QQ 空间时，在回复正文里额外输出一个自闭合标签：
<qzone_publish content="要发布的正文" />
需要附带图片时按顺序追加 image1、image2 等属性，值为图片的 http/https 地址：
<qzone_publish content="要发布的正文" image1="https://..." />
一条动态最多附带 9 张图片，超出时整条不会发布；视频与其它文件无法发布。
同一轮最多输出一个该标签；不需要发布时不要输出这个标签。
```

> 如果你之前已经按旧版注入过，建议重新复制一次配置项 `promptPublishTool` 的当前值覆盖预设，这样才能让模型知道 9 张图片上限与视频不可发布。

### 1.1 关于数量与格式限制

| 限制 | 含义 |
|------|------|
| 最多 9 张图片 | 本地图片与远程图片合计；超出时整条动态不会发布，不会只发一部分 |
| 不能发布视频 | `qzone-sdk` 当前只支持读取视频，发布接口不接受视频 |
| 不能发布其它文件 | `audio`、`file`、`record` 等越界格式会被拒绝 |

模型输出超过 9 个 `imageN` 属性时，插件会拒绝整条发布并在反馈中说明原因，可用 `qzone.feeds` 核对后重新要求模型发布。

---

## 2. 注入到 ChatLuna 主插件

### 2.1 预设位置

```text
data/chathub/presets/<角色名>.yml
```

### 2.2 落点

追加到 `prompts` 数组中 `role: system` 的段落。

```yaml
prompts:
  - role: system
    type: description
    content: |
      ……原有内容……

      当你确实需要把某段内容发布到自己的 QQ 空间时，在回复正文里额外输出一个自闭合标签：
      <qzone_publish content="要发布的正文" />
      需要附带图片时按顺序追加 image1、image2 等属性，值为图片的 http/https 地址：
      <qzone_publish content="要发布的正文" image1="https://..." />
      一条动态最多附带 9 张图片，超出时整条不会发布；视频与其它文件无法发布。
      同一轮最多输出一个该标签；不需要发布时不要输出这个标签。
```

### 2.3 步骤

```text
1. 复制插件配置项 promptPublishTool 的全部内容
2. 打开 data/chathub/presets/<角色名>.yml
3. 追加到 prompts 数组中 role 为 system 的段落
4. 保存并重载插件
```

---

## 3. 注入到伪装插件

### 3.1 预设位置

```text
data/chathub/character/presets/<角色名>.yml
```

该目录下的角色名即插件配置项 `personaPresetId` 的取值。

### 3.2 落点

追加到 `system` 字段。

```yaml
name: 该隐

system: |
  ……原有内容……

  当你确实需要把某段内容发布到自己的 QQ 空间时，在回复正文里额外输出一个自闭合标签：
  <qzone_publish content="要发布的正文" />
  需要附带图片时按顺序追加 image1、image2 等属性，值为图片的 http/https 地址：
  <qzone_publish content="要发布的正文" image1="https://..." />
  一条动态最多附带 9 张图片，超出时整条不会发布；视频与其它文件无法发布。
  同一轮最多输出一个该标签；不需要发布时不要输出这个标签。
```

### 3.3 步骤

```text
1. 复制插件配置项 promptPublishTool 的全部内容
2. 打开 data/chathub/character/presets/<角色名>.yml
3. 追加到 system 字段
4. 保存并重载插件
```

---

## 4. 关于自动注入

插件在 ChatLuna 提供 `contextManager.pipeline` 时会自动完成注入，无需手动操作。

当前 ChatLuna 版本不提供该能力，因此需按上述步骤手动执行一次。
日志中关于不支持自动注入的提示在手动完成后不再出现。

---

## 5. 验证

```text
1. 在对话中要求模型发布一条内容
2. 发送 qzone.feeds 确认是否发布成功
```

未注入时模型不会输出该标签，功能不会生效，其余功能不受影响。

也可以在控制台页面 `/qzone` 的「模型主动发布」卡片中查看捕获标签数与成功／失败计数，详见 [CONSOLE.md](CONSOLE.md)。

---

## 6. 不需要该能力时

将插件配置项 `enablePublishTool` 设为 `false` 即可关闭。
`qzone.publish` 指令与控制台发布面板不受影响，仍可使用。
