# Release v2025.6.10-enhanced-3.0.0

**发布日期**：2026-07-05

## 版本说明

这是增强版飞书插件的第三个大版本更新，重点解决了 **Token 统计准确性** 和 **上下文窗口显示** 两大核心问题，同时修复了大量流式卡片相关的 bug。

---

## 🎯 核心改进

### 1. Token 统计全面重构 — 数据真正准确了

**问题背景**：之前的版本中，footer 和统计模块显示的 Token 数据存在两个根本性问题：
- **显示的是会话累计值**，而非当前轮独立消耗
- **footer 和统计模块数据不一致**（同一个对话两个数字）

**解决方案**：引入 **transcript 文件累加方案**
- 直接读取 OpenClaw 的 transcript 文件，遍历当前轮所有 assistant 消息
- 遇到 user 消息时重置计数器，精确界定"当前轮"的边界
- 累加当前轮的 `input`、`output`、`cacheRead`、`cacheWrite`
- footer 和统计模块共用同一数据源，彻底消除不一致

**效果对比**：

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| 第二轮只回复👍 | 🪙 25.34w（累计值） | 🪙 12（实际消耗） |
| footer vs 统计模块 | 数据不一致 | 完全一致 |
| 缓存命中率 | 偏低（不含 cacheRead） | 准确（input + cacheRead） |

### 2. 上下文窗口显示修复 — 不再出现 233% 的离谱数字

**问题背景**：上下文占用百分比偶尔显示 233% 等不可能的数值。

**根因**：transcript 累加方案会把整个对话历史的 token 都加起来，但 OpenClaw 的上下文压缩（compaction）会缩小实际窗口，transcript 不反映压缩。

**解决方案**：上下文窗口数据改从 `lastUsage.total` 或 session store 获取（runtime 实时更新，反映压缩后的实际大小），不再用 transcript 累加值。

### 3. 卡片内容截断修复

**问题背景**：飞书卡片偶尔出现内容截断（如 `ens\`\*\*`、`etrics\*\*` 这种尾部片段）。

**根因**：V2 卡片的 markdown 元素内容过长时，飞书渲染层会截断，但 API 层不报错。

**解决方案**：终态卡片优先使用 `accumulatedText`（完整的累积文本），而非流式过程中的中间状态。

---

## 🐛 Bug 修复（共 30+ 个 commit）

### 流式卡片核心

| Commit | 修复内容 |
|--------|---------|
| `976d63e` | V2 卡片不支持 action 元素导致流式卡片失败回退 IM（markdown 不渲染） |
| `ad1d3c1` | 流式卡片冻结 + 终态 Markdown 不渲染 |
| `99fd3f3` | 终态卡片内容截断 — 优先使用 accumulatedText |
| `f95aa85` | 流式卡片 markdown 渲染 — 初始卡片使用 V2 格式 |
| `b44799d` | 流式输出首段重复、思考内容重复、思考时间 0.0s |
| `39b24b3` | 两个输出重复问题 |
| `99c1a38` | 首段输出丢失 — 后续 deliver 不覆盖 streamingPrefix |

### Token 统计

| Commit | 修复内容 |
|--------|---------|
| `5b99cc9` | **核心**：从 transcript 文件读取整轮对话的 token 数据 |
| `6ea3bf5` | **核心**：上下文窗口 totalTokens 改用 runtime 数据 |
| `344b0af` | 修复 transcript 路径 inputTokens 双重计算 cacheRead |
| `54e2cf5` | 修复 footer 与统计模块 token 不一致 + footer 显示累计值 |
| `d15741b` | footer 输入 token 差值计算 |
| `a6ff247` | 统计模块和 footer token 总数对齐官方（包含 cacheRead） |
| `acc3462` | 统计用 sessionId 做主键 + footer 缓存命中率跟随 token 修复 |
| `22d167f` | 统计模块会话重置检测 + footer 只显示本轮对话 token 数据 |

### 思考内容

| Commit | 修复内容 |
|--------|---------|
| `acd316b` | 思考内容追加而非覆盖 |
| `78c117d` | 思考时间区分显示 — 同时显示思考耗时和工具执行耗时 |
| `9b1cc13` | stripReasoningTags 误删答案中字面引用的 think 标签 |

### 上下文与模型信息

| Commit | 修复内容 |
|--------|---------|
| `e65caea` | 上下文信息兜底 — setDefaultModel 拼接 provider 前缀 |
| `c15435b` | 上下文信息 fallback 到本地模型容量 |
| `c52d5f8` | 流式输出上下文信息显示为 🧠 - 的问题 |

### 停止按钮

| Commit | 修复内容 |
|--------|---------|
| `500da9d` | 修复停止按钮状态显示及流式 footer token 显示问题 |
| `dc920f5` | 停止按钮 toast 提示 + 终态 footer 数据补充 |
| `855739e` | abort 时即使没有 lastUsage 也记录轮次到统计模块 |

### 其他

| Commit | 修复内容 |
|--------|---------|
| `995730d` | CardKit 初始化 flatMap 错误 |
| `c03959c` | 流式卡片 ReferenceError: toolUseElapsedMs is not defined |
| `1a6c9f6` | session store fallback 中 defaultAgentId 为 undefined |
| `a371e32` | footer fallback 从 session store 读取完整 token 数据 |
| `84de267` | 恢复 optimizeMarkdownStyle — 官方插件核心功能 |

---

## 📊 数据变更

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| Token 显示 | 会话累计值 | 当前轮独立值 |
| Footer vs 统计 | 不一致 | 完全一致 |
| 缓存命中率 | 偏低 | 准确（含 cacheRead） |
| 上下文窗口 | 可能超 100% | runtime 实时数据 |
| 终态内容 | 可能截断 | 完整 accumulatedText |

---

## 🔧 技术细节

### transcript 累加方案

```
transcript 文件
  ↓
accumulateTranscriptCacheUsage()
  ↓ 遇到 user 消息时重置计数器
  ↓ 累加当前轮所有 assistant 消息
  ↓
transcriptCacheUsage { input, output, cacheRead, cacheWrite }
  ↓
getFooterSessionMetrics() + recordSessionStats()
  ↓ 共用同一数据源
  ↓
footer 显示 + SQLite 统计
```

### 上下文窗口数据流

```
OpenClaw runtime
  ↓ 每次 LLM 调用后更新 lastUsage.total
  ↓ 上下文压缩后更新 compactionTokensAfter
  ↓
session store → totalTokens
  ↓
footer 显示 🧠 used/total (percent)
```

---

## 📦 文件变更

```
src/card/builder.ts                    |  92 ++--
src/card/pause-registry.ts             |   2 +
src/card/reply-dispatcher-types.ts     |   2 +
src/card/reply-dispatcher.ts           |  12 +-
src/card/reply-mode.ts                 |  21 +-
src/card/round-state.ts                |  53 +++  (新增，后成为死代码)
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

## ⚠️ 已知问题

- `round-state.ts` 已成为死代码（transcript 方案不再需要），后续版本清理
- 停止按钮在部分场景下可能无响应（框架层面限制，非插件问题）
- `accumulateTranscriptCacheUsage` 遇到 tool result 消息（role=user）时可能提前重置计数器

---

## 🙏 致谢

感谢 [larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark) 提供的优秀基础，以及 [OpenClaw](https://github.com/openclaw/openclaw) 社区的支持。

---

**Full Changelog**: https://github.com/Kkwans/openclaw-lark-enhanced/compare/2025.6.10-enhanced-1.0...v2025.6.10-enhanced-3.0.0
