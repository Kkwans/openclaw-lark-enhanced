# OpenClaw Lark Enhanced

基于 [larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark) 官方飞书插件的增强版本。

## 增强功能

### 1. 流式卡片 — 多轮思考+输出展示

支持 AI 多轮思考和输出的完整展示，不会丢失中间内容：

**流式输出过程中：**
```
┌─────────────────────────────────────┐
│ ⏳ 回复中                           │
├─────────────────────────────────────┤
│ [工具调用面板]                       │
│                                     │
│ 💭 思考了 2m 18s                    │ ← 折叠组件（思考中展开，完成后折叠）
│ bbaacc（第一次输出）                  │
│                                     │
│ 💭 思考了 1m 32s                    │ ← 第二轮思考
│ aabbcc（第二次输出）                  │
│                                     │
│ ...（生成输出中的动画）               │
│ ⏹️ 停止                             │ ← 停止按钮
│ ───────────────────                 │
│ 💬 会话 2 轮 · 🪙 5.2k · ⚡ 96%    │
│ 📅 今日 5 轮 · 🪙 12.3k · ⚡ 92%   │
│ 📆 本月 50 轮 · 🪙 288k · ⚡ 86%   │
│ ───────────────────                 │
│ 🪙 3.5k · ⚡ 98% · 🧠 82k/1.0m (8%)│
│ ⏳ 生成中 · ⏱️ 47.2s · 🤖 mimo-v2.5│
└─────────────────────────────────────┘
```

**输出完成后：**
```
┌─────────────────────────────────────┐
│ ✅ 已完成                           │
├─────────────────────────────────────┤
│ [工具调用面板]                       │
│                                     │
│ 💭 思考了 2m 18s    ← 自动折叠      │
│ bbaacc（第一次输出）                  │
│                                     │
│ 💭 思考了 1m 32s    ← 自动折叠      │
│ aabbcc（第二次输出）                  │
│                                     │
│ ───────────────────                 │
│ 💬 会话 2 轮 · 🪙 5.2k · ⚡ 96%    │
│ 📅 今日 5 轮 · 🪙 12.3k · ⚡ 92%   │
│ 📆 本月 50 轮 · 🪙 288k · ⚡ 86%   │
│ ───────────────────                 │
│ 🪙 3.5k · ⚡ 98% · 🧠 82k/1.0m (8%)│
│ ✅ 已完成 · ⏱️ 47.2s · 🤖 mimo-v2.5│
└─────────────────────────────────────┘
```

### 2. 暂停按钮

流式输出过程中显示「⏹️ 停止」按钮，点击可立即停止 LLM 生成：
- 通过 AbortController 中断 LLM 请求
- 卡片更新为「⏹️ 已停止」状态（橙色标题）
- 终态卡片自动移除停止按钮

### 3. 卡片状态视觉区分

| 状态 | Header 颜色 | 标题 |
|------|------------|------|
| 流式中 | 🩵 青色 | ⏳ 回复中 |
| 完成 | 🟢 绿色 | ✅ 已完成 |
| 出错 | 🔴 红色 | ❌ 出错 |
| 停止 | 🟠 橙色 | ⏸️ 已停止 |

### 4. Footer 实时信息

流式输出过程中，卡片底部实时显示：
- 💬 会话累计轮数 + 🪙 Token 消耗 + ⚡ 缓存命中率
- 📅 今日 / 📆 本月统计（轮数 + Token + 缓存命中率）
- 🧠 上下文窗口占用（已用/总量 + 百分比）
- ⏱️ 耗时 + 🤖 模型名称

### 5. 提问过期时间调整

交互式提问卡片过期时间从 5 分钟调整为 10 分钟，给用户更充裕的回复时间。

### 6. Emoji 语义化

| Emoji | 含义 |
|-------|------|
| 🪙 | Token 消耗（硬币 = 成本/消耗） |
| ⚡ | 缓存命中（闪电 = 速度/命中） |
| 🧠 | 上下文占用（大脑 = 记忆容量） |
| 💬 | 会话统计 |
| 📅 | 今日统计 |
| 📆 | 本月统计 |
| 💭 | 思考/推理 |

## 与官方插件的区别

| 功能 | 官方插件 | 增强版 |
|------|---------|--------|
| 多轮思考+输出 | ❌ 只显示最后一段 | ✅ 完整展示所有轮次 |
| 流式 Footer | ❌ 无 | ✅ 实时显示 Token/缓存/上下文 |
| 停止按钮 | ❌ 无 | ✅ 流式中可停止生成 |
| 卡片状态区分 | ❌ 无 header | ✅ 青/绿/红/橙 header |
| 会话统计 | ❌ 无 | ✅ 累计 Token + 缓存命中 |
| 日/月统计 | ❌ 无 | ✅ 按日期/月份聚合 |
| 提问过期 | 5 分钟 | 10 分钟 |

## 安装

```bash
git clone https://github.com/Kkwans/openclaw-lark-enhanced.git
cd openclaw-lark-enhanced
pnpm install
pnpm build
cp -r dist package.json <openclaw-extensions-dir>/openclaw-lark-enhanced/
cd <openclaw-extensions-dir>/openclaw-lark-enhanced/
pnpm install --prod
```

## 配置

在 `openclaw.json` 中启用 footer 功能：

```json
{
  "channels": {
    "feishu": {
      "footer": {
        "status": true,
        "elapsed": true,
        "tokens": true,
        "cache": true,
        "context": true,
        "model": true,
        "sessionStats": true,
        "dailyStats": true,
        "monthlyStats": true
      }
    }
  }
}
```

## 许可证

MIT License（继承自官方插件）。

## 致谢

- [larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark) — 官方飞书插件
- [OpenClaw](https://github.com/openclaw/openclaw) — AI 助理框架
