# Release v2025.6.10-enhanced-3.0.0

**发布日期**：2026-07-05

## 版本说明

这是增强版飞书插件的第三个大版本更新，重点解决了 **Token 统计准确性** 和 **上下文窗口显示** 两大核心问题，同时修复了大量流式卡片相关的 bug。

---

## 🎯 核心改进

### 1. Token 统计全面重构

引入 **transcript 文件累加方案**，直接读取 OpenClaw 的 transcript 文件，精确统计当前轮对话的 Token 消耗。

- 遇到 user 消息时重置计数器，精确界定"当前轮"边界
- 累加当前轮所有 assistant 消息的 `input`、`output`、`cacheRead`、`cacheWrite`
- footer 和统计模块共用同一数据源，彻底消除不一致
- 缓存命中率准确计算（包含 cacheRead）

### 2. 上下文窗口显示修复

上下文窗口数据改从 `lastUsage.total` 或 session store 获取（runtime 实时更新），确保显示准确的上下文占用百分比。

### 3. 卡片内容截断修复

终态卡片优先使用 `accumulatedText`（完整的累积文本），解决飞书卡片偶尔出现的内容截断问题。

---

## 🐛 Bug 修复

### 流式卡片核心

- 修复 V2 卡片不支持 action 元素导致流式卡片失败回退 IM（markdown 不渲染）
- 修复流式卡片冻结 + 终态 Markdown 不渲染
- 修复终态卡片内容截断
- 修复流式卡片 markdown 渲染 — 初始卡片使用 V2 格式
- 修复流式输出首段重复、思考内容重复、思考时间 0.0s
- 修复首段输出丢失 — 后续 deliver 不覆盖 streamingPrefix

### Token 统计

- 从 transcript 文件读取整轮对话的 token 数据，替代 runtime lastUsage 累计值
- 上下文窗口 totalTokens 改用 runtime 数据
- 修复 transcript 路径 inputTokens 双重计算 cacheRead
- 修复 footer 与统计模块 token 不一致 + footer 显示累计值
- 统计模块和 footer token 总数对齐官方（包含 cacheRead）

### 思考内容

- 修复思考内容追加而非覆盖
- 修复思考时间区分显示 — 同时显示思考耗时和工具执行耗时
- 修复 stripReasoningTags 误删答案中字面引用的 think 标签

### 其他

- 修复 CardKit 初始化 flatMap 错误
- 修复流式卡片 ReferenceError: toolUseElapsedMs is not defined
- 修复 session store fallback 中 defaultAgentId 为 undefined
- 恢复 optimizeMarkdownStyle — 官方插件核心功能
- 修复停止按钮状态显示及统计数据问题
- 修复 abort 时即使没有 lastUsage 也记录轮次到统计模块

---

## 📦 文件变更

```
src/card/builder.ts                    |  92 ++--
src/card/pause-registry.ts             |   2 +
src/card/reply-dispatcher-types.ts     |   2 +
src/card/reply-dispatcher.ts           |  12 +-
src/card/reply-mode.ts                 |  21 +-
src/card/round-state.ts                |  53 +++
src/card/session-stats.ts              |  16 +
src/card/streaming-card-controller.ts  | 737 +++++++++++++++++++++++++--------
src/card/streaming-footer.ts           | 181 ++++++--
src/channel/event-handlers.ts          |  28 +-
src/core/config-schema.ts              |   3 +
src/core/footer-config.ts              |   6 +-
src/messaging/converters/post.ts       | 115 ++++-
src/messaging/inbound/dispatch.ts      |   9 +-
src/messaging/outbound/deliver.ts      |  23 +-
src/messaging/outbound/send.ts         |  42 +-
src/tools/oapi/im/message.ts           | 167 +-------
tests/inbound-post-content-v2.test.ts  | 147 +++++++
tests/outbound-native-markdown.test.ts |  45 ++
```

**总计**：20 个文件，+1192 行，-524 行

---

## 🙏 致谢

感谢 [larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark) 提供的优秀基础，以及 [OpenClaw](https://github.com/openclaw/openclaw) 社区的支持。

---

**Full Changelog**: https://github.com/Kkwans/openclaw-lark-enhanced/compare/2025.6.10-enhanced-1.0...v2025.6.10-enhanced-3.0.0
