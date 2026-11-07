# 这个插件是什么（给新会话的简报）

> 任何新开的 DSH 会话，先让模型调 `workbuddy_context()` 就能拿到这份内容，不用你复述。

## 一句话

本机 CodeBuddy CLI（WorkBuddy 桌面版自带引擎）的桥接插件：**它是外脑，DSH 是手**。
它负责想（只读规划/审计），DSH 负责干（改代码、跑测试）。

## 三条硬约束

1. **只读轮必须 `dontAsk`**——它自动放行读工具、直接拒掉写工具，永不等人；`acceptEdits` 会让要审批的工具
   挂起等人，无人值守时卡死（实测报 `no human is at the terminal to approve tool use`）。
   两个路径各自设，别混：relay/review 走 `/codebuddy`（cliBridge 默认 `dontAsk`，`--edit` 那一轮转 `acceptEdits`）；
   `workbuddy_task` 直连引擎，默认也是 `dontAsk`，要它真改文件就显式传 `permissionMode="acceptEdits"`。
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
用量报表、面板"思考 vs WorkBuddy"时间拆分、打分账本（`tools/score.mjs`）、
**就是你现在正在读的这个工具**（`workbuddy_context`，2026-11-06 加）。

测试：9 套 **75 例**（`npm test`，本机 Node 20 会跳过 2 例 zstd，DSH 的 Node 24 全跑）。

## 当前状态（2026-11-07 10:40）

- 版本 **0.3.2**：默认权限模式修回 `dontAsk`，`workbuddy_task` 加了 `permissionMode` 显式开关；
- 账本 **5 条**：计划层 4 条（总分 17.8 : 21.3，WorkBuddy 4:0 全胜）+ **任务层 1 条**
  （0.3.2 权限修复：pass · 返工 1 · 17 分钟）；
- 最新两条来自"酒馆"任务（20:17 / 20:39），说明账本已经在真实对话里用了。

## 当前待办

1. **补任务层字段**：已有 1 条（0.3.2 权限修复）。还差 1 条：下次真派活前先写一句验收标准，做完用
   `node tools\score.mjs add ... --outcome pass|partial|fail --rework N --minutes N` 记（不打分也行）；
   1 条说明不了"省不省事"，2 条才开始有对比；
2. 市场：0.3.0 已提交等合并；**0.3.2 要再提交一次**（默认权限模式是行为变化，值得写进说明）；
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
