# OpenClaw Lark Enhanced

基于 [larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark) 官方飞书插件的增强版本。

## 增强功能

### 1. 流式卡片 Footer 实时信息

在流式输出过程中，卡片底部实时显示：

```
💬 会话   5.2k (2 轮) · ⚡ 42%
📅 今日  12.3k (5 轮) · ⚡ 38%
📆 本月  123k (50 轮) · ⚡ 35%
---
🪙 1.2k · ⚡ 42% · 🧠 5.2k/128k (4%)
⠋ 生成中 · ⏱️ 3.2s · mimo-v2.5-pro
```

完成后自动更新为终态：

```
💬 会话   5.2k (2 轮) · ⚡ 42%
📅 今日  12.3k (5 轮) · ⚡ 38%
📆 本月  123k (50 轮) · ⚡ 35%
---
🪙 3.5k · ⚡ 98% · 🧠 5.2k/128k (4%)
✅ 已完成 · ⏱️ 15.2s · mimo-v2.5-pro
```

**显示内容：**
- 💬 会话累计 Token（轮数 + 缓存命中率）
- 📅 今日 / 📆 本月 Token 统计（带缓存命中率）
- 🪙 当前轮 Token 消耗
- ⚡ 缓存命中率
- 🧠 上下文窗口占用（已用/总量 + 百分比）
- ⏱️ 耗时
- 🤖 模型名称

### 2. 暂停按钮

流式输出过程中显示「⏸️ 暂停」按钮，点击可立即停止 LLM 生成：
- 通过 AbortController 中断 LLM 请求
- 卡片更新为「⏸️ 已停止」状态
- 终态卡片自动移除暂停按钮

### 3. 卡片状态视觉区分

| 状态 | Header 颜色 | 标题 |
|------|------------|------|
| 流式中 | 🩵 青色 | ⏳ 回复中 |
| 完成 | 🟢 绿色 | ✅ 已完成 |
| 出错 | 🔴 红色 | ❌ 出错 |
| 停止 | 🟠 橙色 | ⏸️ 已停止 |

### 4. 加载动画

流式输出过程中，footer 上方显示 `loading_outlined` 标准动画图标 + 旋转 braille 点（⠋⠙⠹⠸...），直观区分流式中和完成状态。

### 5. 移动端适配

Footer 采用单行单信息布局，每行一个数据点，窄屏不会出现折行溢出问题。

### 6. 提问过期时间调整

交互式提问卡片过期时间从 5 分钟调整为 10 分钟，给用户更充裕的回复时间。

### 7. Emoji 语义化

每个数据指标使用语义化 Emoji：
- 🪙 Token 消耗（硬币 = 成本/消耗）
- ⚡ 缓存命中（闪电 = 速度/命中）
- 🧠 上下文占用（大脑 = 记忆容量）
- 💬 会话统计 | 📅 今日 | 📆 本月

## 与官方插件的区别

| 功能 | 官方插件 | 增强版 |
|------|---------|--------|
| 流式 Footer | ❌ 无 | ✅ 实时显示 Token/缓存/上下文 |
| 暂停按钮 | ❌ 无 | ✅ 流式中可停止生成 |
| 卡片状态区分 | ❌ 无 header | ✅ 青/绿/红/橙 header |
| 加载动画 | 基础 | ✅ 动态 braille 点 |
| 会话统计 | ❌ 无 | ✅ 累计 Token + 缓存命中 |
| 日/月统计 | ❌ 无 | ✅ 按日期/月份聚合 |
| 移动端适配 | 基础 | ✅ 单行单信息布局 |
| 提问过期 | 5 分钟 | 10 分钟 |

## 安装

与官方插件安装方式相同，将本仓库的 `dist/` 目录作为 OpenClaw 扩展加载。

```bash
# 克隆仓库
git clone https://github.com/Kkwans/openclaw-lark-enhanced.git
cd openclaw-lark-enhanced

# 安装依赖
pnpm install

# 构建
pnpm build

# 复制到 OpenClaw 扩展目录
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
