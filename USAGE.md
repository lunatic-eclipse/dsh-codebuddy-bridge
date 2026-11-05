# CodeBuddy 协作桥 · 使用说明

> 给 DSH 的任意会话看：读完这份就能让本机 CodeBuddy CLI（WorkBuddy 桌面版里那套引擎）替你干活，你再审。
> 插件 `dsh-codebuddy-bridge`（入口 id `codebuddy-bridge`），源码在 `plugins\workbuddy-bridge\`。
> 交换目录 `collabDir` 默认 `~\.dsh\codebuddy-bridge`（下文写作 `<collabDir>`），可在配置里改；老版本写在 `.collab\`。

## 0. 现在的形态（2026-11-05 实测）

| 能力 | 状态 | 怎么用 |
| --- | --- | --- |
| 让 WorkBuddy 跑一轮任务 | ✅ 通 | `workbuddy_relay`（结果回注到对话）或 `codebuddy_ask`（静默工具） |
| 看它每轮读了什么、改了什么 | ✅ 通 | 输入框上方的「CodeBuddy 协作」面板 |
| 按会话开关这个能力 | ✅ 通 | 输入框下方的「CodeBuddy 协作」胶囊 |
| 读桌面版 App 里你自己跑过的会话 | ✅ 通 | `workbuddy_read` |
| 核对它到底改没改（要证据） | ✅ 通 | `workbuddy_verify`，静态核对、不花额度 |
| 老的文件交接通道（`/dsh-handoff`） | ✅ 保留 | `workbuddy_dispatch` + 看门狗，作兜底 |
| 直连引擎（带审批卡片那套） | ❌ 不可用 | 缺凭据，别用 `workbuddy_task` |

**关键变化**：派活不再需要你在 WorkBuddy 里敲 `/dsh-handoff`。那条命令现在只是兜底通道。

---

## 1. 快速开始

```text
0) 先调 workbuddy_status()：
   - 「协作模式：关」→ 工具根本不在你的列表里，别硬试；请用户点输入框下方的「CodeBuddy 协作」
   - 「协作模式：开」→ 继续
1) 我调 workbuddy_relay("任务：… 验收：… 边界：…")   // 要它改文件就加 edit: true
   → CodeBuddy 在会话工作区跑一轮，结论作为消息回注到对话
2) 我读回注的那条消息（它才是我的依据；面板只给人看）
3) 调 workbuddy_verify() 核对它到底改了什么（PASS/FAIL + 证据）；要原始明细再读 <collabDir>\last-run.json
4) 我根据结论继续审、改、派下一轮
5) 不用了就请用户再点一下胶囊关掉（工具会一起收走）
```

任务书建议写清：**目标 / 验收标准 / 边界（别碰什么）/ 要拍板的留给人**。
`codebuddy_ask` 看不到本会话的对话，所以任务必须自包含。

**额度**：每会话每小时 6 次、全场每小时 20 次。超了会被具名拒绝——**停下来告诉用户，不要重复调用、
也不要换 `workbuddy_dispatch` 绕过**，等冷却再试。

---

## 1.5 交叉审查玩法（推荐用法）

这个插件最值钱的用法不是“把活外包”，是**让另一个模型看你的活**。两个模型没见过对方的思路，
交叉看一眼比同一个人反复检查更容易发现盲点。前提是：审查方必须**真读了文件**，不能靠想象。

### 三步循环

```text
1) DSH 写完/改完一段 → 派一轮「只读审查」（edit 不传，默认 false）
2) 读回注结论 → 调 workbuddy_verify() 确认它确实读了、没瞎编
3) 按它指出的问题改 → 需要时再来一轮
```

### 提示词模板（直接复制）

**A. 让它只读审查（最常用）**

```text
任务：只读审查，不要改任何文件。
文件：<相对路径>
背景：<这段是做什么的，一句话>
请只指出「你能指出具体位置」的问题，最多 3 条，按严重程度排序。
每条形如：第 N 行 — 问题 — 建议怎么改。
不要泛泛而谈（"可以更健壮""建议加注释"这类不要），不要联网。
```

**B. 让它动手改（要显式给权限）**

```text
任务：在 <相对路径> 做一处修改：<具体改成什么>。
只改这一处，别的文件一个字都别动。
完成标准：<可验证的判据，例如「仍是 1 个标题 + 5 条列表」>。
做完用一句话说清你改了哪一行。
```

> **审查轮一律不给写权限**（不传 `edit`）。给了它就会"顺手帮你改了"，审查就不再是审查。

### 验的时候看什么

| verify 结果 | 说明 |
| --- | --- |
| `[PASS] 内容已变` | 它真改了，且拿 CLI 改前备份做了 diff |
| `[FAIL] 空转` | 它说改了，内容跟改前一模一样 |
| `无可核对项` + 动作里有 `Read <你给的文件>` | 纯审查轮的正常结果：没写东西，但确实读了 |
| 动作里**没有** Read 你指定的文件 | 它在凭想象审——这次结论不要采信 |

### 三个常见误用

1. **让它改完再自己审**：同一个模型审自己的产出，等于没审。要么 DSH 写它审，要么它写 DSH 审。
2. **一次塞太多**：一次审一个文件、一类问题，比"把这个仓库都看一遍"有用得多。
3. **不看 verify 就采信结论**：模型很容易说"我检查过了"。核对一次几秒钟，不花额度。

---

## 2. 工具参考

### `workbuddy_relay(prompt, edit?)` —— 主力，看得见

代用户敲一次 `/codebuddy`（`dsh-connect-workbuddy` 的 CLI 路线）。结论会以一条带
`[dsh-connect-workbuddy · 由 /codebuddy 自动回注，不是用户输入]` 前缀的消息进对话。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `prompt` | string | 必填 | 交给 CodeBuddy 的完整任务 |
| `edit` | boolean | **false** | **默认只读**：要它写/改文件，必须显式传 `edit: true`，否则这一轮白跑还照样花额度 |

代价：CodeBuddy 额度 + 一次 DSH 回合。**同一轮任务不要重复调用**，每次都是真花钱。

### `codebuddy_ask(message, …)` —— 另一个插件提供的静默工具

同样跑 CLI agent，但结果只作为工具卡返回，不进对话流。适合"我只想要结论、不想污染上下文"。
参数更全：`working_dir`、`model`、`permission_mode`、`max_turns`、`timeout_secs`、`session_id`。

### `workbuddy_read(turns?, session?)`

读 **WorkBuddy 桌面版 App** 自己的会话记录（不是 CLI 的），也可能读到当前 DSH 会话的旧记录。
用来审你或别人在 App 里干的活——**不要用它审刚跑完的 relay**（relay 的记录在 `<collabDir>\last-run.json`）。
`turns` 默认 8；`session` 可传会话 id 前缀。

### `workbuddy_status()`

引擎路径、认证、当前会话、交换目录、轮次状态、**协作模式**、**当前模型**、看门狗。开工前和排错都先看它。

### `workbuddy_verify(run?, session?)`

核对一轮活到底改没改：**证据优先，它的总结其次**。纯本地读，不调引擎、不花额度，协作模式关着也能审旧账。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `run` | integer | 1 | 审倒数第几轮 |
| `session` | string | — | 直接指定 CLI 会话 id（或前几位），忽略 `runs.jsonl` |

它给每条判定配证据，四种结果：

- **PASS**：动作 + 内容确实变了（拿 CLI 自己留的改前备份做 hash 对比），或确证是新建；
- **FAIL**：摘要说改了但它根本没碰（自述无据）、调用了写操作但内容与改前一致（空转）、写失败；
- **WARN**：改是改了但没法证实（没有备份可比、mtime 不在窗内）、或窗内有它没提的改动；
- 末行是 `PASS/FAIL/WARN` 计数，FAIL > 0 就按那几条追。

> 它只认「动作 + 文件事实」。摘要里的话只有能对上动作才算数——这正是审计要的。

### `workbuddy_probe()`

调试用：打印当前 Agent 上和唤醒相关的方法签名（`followup`/`inject`/`send`），
以及最近一条 user 消息的真实结构。调唤醒参数前先跑它。

### `workbuddy_task(prompt, cwd?, reset?)` —— 不可用

直连引擎那一套（多轮 + 审批卡片）。无凭据，只会返回 `Authentication required`，**别用**。

### `workbuddy_dispatch(task, force?)` + `/dsh-handoff` —— 兜底通道

把任务书写进 `<collabDir>\inbox.md`，让用户在 WorkBuddy 里敲 `/dsh-handoff`，它把四节交接单写回
`<collabDir>\outbox.md`；看门狗发现写回后会用 `agent.followup` 叫醒派活的会话。
CLI 路线不可用时才用这条。

- 参数：`task`（string，必填，任务书正文）、`force`（boolean，默认 false；上一轮还是 `pending` 时会被拒绝，
  确认放弃才传 true）。
- 交接单四节模板：**做了什么**（文件 + 关键改动）/ **产出**（结论、数据）/ **需要拍板**（一条一条列）/
  **还没做 / 卡住**。审的时候重点看后两节。
- **派完就停**：它只在用户敲了 `/dsh-handoff` 之后才动。不要轮询、不要重复 dispatch、
  不要假装"它应该快好了"。用户说"跑完了"再 `workbuddy_read`。
- 被叫醒时，你会收到一条以「WorkBuddy 已写回第 N 轮交接单」开头的提醒，那就是该读 outbox 的信号。

---

## 3. 界面：胶囊 + 面板

| 位置 | 是什么 |
| --- | --- |
| 输入框下方（胶囊同排） | 「CodeBuddy 协作」开关；灰=关，品牌色+「· 开」=开 |
| 输入框上方（全宽，约 760px 居中） | 协作面板：最近一轮的步骤 + 摘要，更早的轮次缩成一行 |

**面板怎么收**（2026-11-05 加）：

- 点标题「CodeBuddy 协作」→ 收起，只剩一行（标题 + 时间/工具数 + 模型下拉）；再点展开。
- 卡片**顶部正中**那条短横是拖拽手柄（像抽屉把手）：上下拖调正文高度（往上拖变高、往下拖变矮，48–420px），**双击**复位到默认 168px。
- 收起状态和高度存在浏览器 `localStorage`（`workbuddy.panel.open` / `workbuddy.panel.height`），刷新后保持。
- 标题行右侧仍有**模型下拉框**（改的是 `cliBridge.model`，下一次调用生效）。

**模型选择**：下拉框写的是 `dsh-connect-workbuddy` 的 `cliBridge.model`（通过 configEditor，不手改 YAML）。
该字段是 volatile，**下一次调用立即生效，不用重启**，对 `workbuddy_relay` 和 `codebuddy_ask` 同时有效。

- **「默认模型」= 空值**：不下发 `--model`，由 CLI 自己决定。实测当前解析为 **`hy4-free`**（免费档）。
  想固定就选具体的；`hy4free` / `hy3` 这类倍率为 0 的，下拉里标了「（免费）」。
- **重名项带 id 区分**：`Hy4 · hy4free（免费）` vs `Hy4 · hy4std`，`Hy3 · hy3（免费）` vs `Hy3 · hy3-x`。

**在 WorkBuddy 应用里看记录**：应用里敲 `/dsh-runs`（读 `<collabDir>\runs.jsonl` 渲染），
或直接打开 `<collabDir>\report.md`（每轮自动重写的可读报告）。注意：relay 跑的是 headless 进程，
**不会出现在 WorkBuddy 的聊天列表里**。

- 开关是**按会话独立**的，存在 `<collabDir>\modes.json`，重启不丢。
- **关着的时候，宿主会把 `codebuddy_ask` / `workbuddy_relay` / `workbuddy_task` /
  `workbuddy_dispatch` 从该会话的 agent 作用域里摘掉**——模型看不见、也调不到。
- 面板和胶囊共用同一个宿主轮询数据源（`/plugins/codebuddy-bridge/last-run`，4 秒一次），
  所以不会出现"按钮开着、面板没了"。

### 模型的依据是哪一份

**面板只给人看，模型看不到它**。模型能用的只有：

1. 回注到对话的那条消息（结论全文，带 `[dsh-connect-workbuddy …]` 前缀）——**首选**；
2. `<collabDir>\last-run.json`（或 `runs.jsonl` 的最后一行），结构：

```json
{
  "at": 1793857920428,
  "sessionId": "01a1aa43-…",
  "steps": [{ "tag": "读取", "text": "Read  <collabDir>\\inbox.md" }],
  "stepCount": 1,
  "summary": "文件的第一行是「# 来自 DSH 的任务书」…",
  "startedAt": 1793857911996,
  "endedAt": 1793857920105
}
```

`tag` 取值：读取 / 修改 / 执行 / 搜索 / 联网 / 工具名。
要"每轮改了什么"就看 `steps`；要"结论"看 `summary`；`startedAt`–`endedAt` 是耗时。

---

## 4. 数据从哪来

- 面板的步骤：CodeBuddy CLI 自己的会话记录
  `~\.codebuddy\projects\<目录 slug>\<sessionId>.jsonl` 里的 `function_call`（工具名 + 参数摘要）。
- 每轮记录追加到 `<collabDir>\runs.jsonl`，最新一份另存 `<collabDir>\last-run.json`。
- 只读、解析在宿主侧完成，客户端只拿整理好的 `{tag, text}`。

---

## 5. 配置

`plugins\workbuddy-bridge\cordis.patch.yml` 的 `config`：

| 字段 | 当前 | 说明 |
| --- | --- | --- |
| `collabDir` | `…\default-workspace\.collab` | 交换目录 / 模式 / 运行记录都在这 |
| `watchMs` | 3000 | 兜底通道看门狗的轮询间隔 |
| `env.WORKBUDDY_CONFIG_DIR` | `C:\Users\donghao\.workbuddy` | 直连引擎用（当前用不到） |
| `permissionMode` | `acceptEdits` | 直连引擎用 |
| `cliPath` / `productConfig` | 自动探测 | 直连引擎入口 |
| `authToken` / `apiKey` | 空 | 有凭据才填 |

**改宿主代码（`index.js`）**：`plugin_manager` 的 `set_plugin`，`target: "include:workbuddy-bridge"`，
先 `enabled: false` 再 `true`。

**改客户端代码（`client.js`）**：必须**重启 DSH**（客户端模块只在宿主启动时扫描）。
工作区根目录有 `restart-dsh.cmd`，双击即可。

---

## 6. 排错

| 现象 | 处理 |
| --- | --- |
| 工具列表里根本没有 `workbuddy_relay` / `codebuddy_ask` | **协作模式关着**（第 0 条）。不要找替代路径，请用户点胶囊 |
| 胶囊点了闪一下又弹回 | 轮询把旧状态盖回来了 / 宿主防抖吞了点击。已修（版本号 + 150ms 防抖）；复现就重启拿最新客户端 |
| 面板不出现 | 确认胶囊是「· 开」；面板在输入框**上方**；再不行重启 |
| 面板是"还没有协作记录" | 还没跑过 relay/codebuddy；跑一轮就有 |
| 面板宽度不对 | 改 `client.js` 里 `panelStyle.maxWidth`（现在 760），重启生效 |
| `workbuddy_relay` 报"协作模式没开" | 胶囊是关的，先点开 |
| relay 说"命令没解析成功" | `dsh-connect-workbuddy` 的 `cliBridge` 没开，或 `/codebuddy` 没注册 |
| `workbuddy_task` 报 `Authentication required` | 预期，见第 0 节 |
| 中文在 PowerShell 里乱码 | 只是控制台编码；文件是 UTF-8 |

---

## 7. 边界

- **额度**：每次 relay / codebuddy_ask 都真花 CodeBuddy 额度；本会话每小时 6 次、全场 20 次。
- **重复调用**：回注消息里已经说了结论，不要为了"再确认"重复派活。
- **运行中不可见**：面板只有"跑完"的明细，没有实时进度；实时胶囊由 connect 插件提供。
- **右侧边栏 tab（文件/终端那种）第三方插件开不了**，所以面板放在输入框上方。
- **直连引擎的审批链路**（`ctx.approval.request`）代码在，但从未在真实回合触发过。
- **账号级限制**：CLI 路线用的还是同一批账号，11140 那种限制一样适用，不是免封金牌。

---

## 8. 给其它会话的开场白（直接复制）

> 读 `C:\Users\donghao\Documents\deepseek-harness\default-workspace\plugins\workbuddy-bridge\USAGE.md`，
> 按里面的方式和本机 WorkBuddy 协作。我要办的事是：……
