# Changelog

## 0.3.2 — 2026-11-07

- **默认权限模式改回 `dontAsk`**：`index.js` 与 `cordis.patch.yml` 里一直是 `acceptEdits`，而 `docs/CONTEXT.md`、
  `HANDOFF.md` 和"任务层"文档都写着"只读轮必须 `dontAsk`"——代码和文档互相打架，且踩中的是无人值守卡死那条。
  现在默认 `dontAsk`：读工具放行、写工具直接拒、永不等人。
- **改文件变成显式选择**：`workbuddy_task` 新增 `permissionMode` 参数（`dontAsk` / `default` / `auto` / `plan` /
  `acceptEdits` / `bypassPermissions`），要它真动手就传 `acceptEdits`；换模式会重开会话（权限模式是启动参数）。
  relay 那条路不变，仍是 `--edit` 那一轮转 `acceptEdits`。
- **`workbuddy_status` 不再把两个路径混成一个数**：分两行报——`workbuddy_task` 直连的，和 relay/review 走
  `/codebuddy`（由 `cliBridge.permissionMode` 决定）的。之前只报前者，读起来像是全局生效。
- 新增 `test/permission.test.mjs`（4 例），钉住默认值、配置覆盖、以及非法模式被拒。

## 0.3.1 — 2026-11-06

- **失败/中断的轮次也会留痕**：取消、CLI 中途死掉、或 DSH 在收尾前退出，以前什么都不写——
  "任务死了一半可能改了文件"和"什么都没发生"分不开。现在：
  - 失败轮写一条 `status: "failed"` 记录（时间、任务、原因、模式）进 `runs.jsonl` 与 `last-run.json`；
  - 调用 CLI **之前**先写一个 `pending.json` 标记（按进程 id），启动时若发现标记后面没有任何记录，
    就补一条"上一轮没收尾"的失败记录；已完成却被标记的轮次不会误报；
  - `workbuddy_verify` 遇到失败轮会说"这一轮没跑完 + 原因 + 可能已改动文件"，而不是"没有可核对的轮次"。
- 额度拒绝（`rejected`）不算失败，不写记录——它是主动拒绝，不是坏掉的一轮。

## 0.3.0 — 2026-11-06

- 计划模式的展示修正：卡上超过 900 字会明确标「已截断，完整结论见上面那个文件」（之前是静默断在半句）；
  计划文件的段落标题由 `## 结论` 改成 `## 模型回答`，避免和模型自己写的 `1. 结论` 重复。
- **面板显示时间拆分**：标题下列一行 `思考 20.0m · WorkBuddy 4.4m · 其它 5.6m · 4.5:1`。
  数据来自 DSH 会话日志（逐帧 zstd 解压，Node 22.15+ 的 `node:zlib`）：
  `step/start → assistant/message` 算思考，`tool/call → tool/result` 算工具，`workbuddy_*` 单列。
  每 4 秒随 `/last-run` 一起拉，服务端按 mtime 缓存 10 秒；不含用户打字时间。
- **`workbuddy_usage(days?)`**：只读用量报表——近 N 天轮数、墙钟耗时（按天/按模式）、每轮 token
  （取自 CLI 转录，按轮次切窗，避免复用会话重复计数）。不花额度、不写文件、不换算积分。

- **计划模式**：`workbuddy_relay(prompt, edit?, mode='plan')`。只读（`edit` 被忽略）+ 固定顺序
  （结论 → 约束 → 假设 → 候选路线 → 每条的反例 → 建议，先给结论）+ 不限字数；结论写入
  `<交换目录>\plans\<时间戳>.md` 并在返回里给路径。
  - 计划轮**不跑 UNREAD**（只凭问题给建议是合法的），但仍做只读守卫：写了文件就是 FAIL；
  - 记录带 `mode`，因此 `workbuddy_verify(run=…)` 与 `workbuddy_verify(session=…)` 事后都不会误判；
  - 与 relay/review 共用每小时 6 轮额度，状态行按 `计划 x · 审计 y · 任务 z` 分开显示。
- **轮次节流（M3）**：同一 DSH 会话每小时最多 6 轮，计数存 `<交换目录>\limits.json`，跨重启保留；
  超限返回 `{ rejected: true, retryAfterSec }`，**不调用 CLI、不新增 `runs.jsonl`**。
  窗口在第一次计入的轮次开始、固定 1 小时、不滑动，`retryAfterSec` 因此只会递减。
- relay 自己报额度/限流错误时，`retryAfterSec` 用 relay 给的冷却（解析不到秒数按 300 秒兜底），
  冷却期内本地直接拒绝；冷却只暂停，不退还已经用掉的窗口轮次。
- `workbuddy_review` 与 relay 共用这 6 轮额度；`workbuddy_status` 多一行显示本窗口已用/剩余。
- `workbuddy_review(path, focus?, maxFindings?)`：只读审查固化成工具，固定模板 + 自动 UNREAD 核对。
- `workbuddy_review` 返回「结论 + 核对」两段，一次调用自足；转录竞态最多重试 4 次。
- 探索性读取失败（Read 不存在的文件）降级为 WARN，写失败仍是 FAIL。
- verify 新增 UNREAD 判定：纯审查轮核对该读的文件到底读没读。
- 审查轮记录 prompt 与 `requested` 文件列表，供 UNREAD 使用。
- 修：计划结论曾被 `summary` 的 500 字上限截断——现在直接读转录里的完整 assistant 消息落盘。

## 0.2.0 — 2026-11-05

- **改名**：`@local/dsh-workbuddy-bridge` → `dsh-codebuddy-bridge`（对外的名字和实际干活的引擎对齐）。
- **新增 `workbuddy_verify`**：按轮次核对产出，用 CLI 自带的改前备份做内容 diff，输出 PASS/FAIL/WARN + 证据；
  不调引擎、不花额度，协作模式关着也能审旧账。
- 判定修正：同一 CLI 会话多轮会互相串 → 记录 `roundStartedAt` 切窗；`existedAtTrack` 只在没有备份时用作“新建”依据。
- **面板**：可收起；顶部短横可拖高（48–420px，双击复位），状态存 localStorage。
- **配置**：`cordis.patch.yml` 去掉机器相关路径；交换目录默认改为 `~/.dsh/codebuddy-bridge`，
  不再往当前工作目录写 `.collab`。
- 补 `LICENSE`（MIT）、`README` / `README.en.md`、`test/`（node:test 覆盖 verify 各判定分支）、`package.json` 发布元数据。

## 0.1.0

- 初始版本：relay 派活、面板、会话开关、`/dsh-handoff` 兜底通道。
