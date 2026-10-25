# DSH Plus · 会话编辑

[English](README.md) | 中文

在原会话里直接修改、重试历史消息，以及一键继续中断的回答。

属于 [DSH Plus](https://github.com/ArakawaHenri/dshplus) 系列插件（`@dshplus/session-edit`）。

## 安装

在 DSH 插件管理器中安装 `@dshplus/session-edit`（或直接安装 [`@dshplus/bundle`](https://github.com/ArakawaHenri/dshplus) 总包）：

```text
@dshplus/session-edit
```

## 用法

- **编辑并重新生成**：鼠标移到历史用户消息上点击**编辑**，改完点**重新生成**，这轮之后的历史会被截掉并从这里重新回答。
- **重试**：点击消息下方的**重试**图标，保留原消息内容和附件直接重新生成。
- **继续**：当对话因为手动停止、网络报错或达到 token 上限而中断时，只要保持输入框为空，右下角的发送键就会变成**继续**按钮——点一下就能让模型接着往下写，不用多发一条“继续”。

所有操作都在当前会话内完成，会话 ID、工作区、附件、自定义标题和当前选中的模型都会保留。

## 许可

MIT
