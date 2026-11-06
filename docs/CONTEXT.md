# 这个插件是什么（给新会话的简报）

> 任何新开的 DSH 会话，先让模型调 `workbuddy_context()` 就能拿到这份内容，不用你复述。

## 一句话

本机 CodeBuddy CLI（WorkBuddy 桌面版自带引擎）的桥接插件：**它是外脑，DSH 是手**。
它负责想（只读规划/审计），DSH 负责干（改代码、跑测试）。

## 三条硬约束

1. **`permissionMode` 必须是 `dontAsk`**——只有它自动放行 Read/Grep；`acceptEdits` 会让读工具进审批队列，
   无人值守时卡住（实测报 `no human is at the terminal to approve tool use`）。
2. **一轮很贵且不可预测**：实测 7–27 积分、均值约 16.5。思考 token 计费但转录里看不到，
   **不要用 token 数估算成本**，只能事后对余额。
3. **额度**：每 DSH 会话每小时 6 轮（relay + review 共用），超限直接拒、不花额度。
   新会话 = 新的 6 轮窗口。

## 四种模式（都是 1 轮）

| 要什么 | 用哪个 | 特点 |
| --- | --- | --- |
| 想清楚、要路线 | `workbuddy_relay(mode="plan")` | 只读、固定六段、先给结论、结论存 `plans/` |
| 查错 | `workbuddy_review(path)` | 只读、最多 N 条、200 字内、自动核对读没读 |
| 让它干活 | `workbuddy_relay(edit=true)` | 允许改文件，跑完用 `workbuddy_verify` 核对 |
| 量花了多少 | `workbuddy_usage(days?)` | 轮数/耗时/token，本地、不花额度 |

## 已经做完的（别再提"加一个"）

审计模式、计划模式、每小时 6 轮节流、失败轮留痕（`pending.json` + `status:"failed"`）、
用量报表、面板"思考 vs WorkBuddy"时间拆分、打分账本（`tools/score.mjs`）。

## 当前待办

1. **真实任务基线**：挑 2 个真实任务，各写一句验收标准，做完用
   `node tools\score.mjs add ... --outcome pass|partial|fail --rework N --minutes N` 记；
2. 市场：0.3.0 已提交等合并；0.3.1 之后要**再提交一次**；
3. **没验过的**：relay 真报额度错误时的冷却秒数（要真被限流才碰得到）。

## 提问比模型更重要（实测结论）

- **放开读**之后计划质量明显更好（能引用具体行号，可复核），成本几乎不变（读进来的 token 多命中缓存）；
- 同一道题，**直接问 vs 带材料+新要求**，打分 16.5 : 21；
- 同一会话里别连续问超过 2–3 轮（上下文膨胀、自我重复）；要新框架就开新会话，
  但**把旧计划当"别人写的方案"喂进去**，而不是接着写。

## 文档索引

| 文件 | 内容 |
| --- | --- |
| `HANDOFF.md` | 交接书（现状、坑、发布状态）——本文件是它的精简版 |
| `docs\SCORING.md` | 打分协议：五维 + 任务层三字段 + 防自欺规则 |
| `docs\PUBLISH.md` | 发布与未完成项（每项都有触发条件） |
| `USAGE.md` | 用户手册（工具、面板、成本） |
