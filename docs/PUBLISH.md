# 发布与维护

给以后的自己看。仓库：<https://github.com/lunatic-eclipse/dsh-codebuddy-bridge>

## 改完代码怎么发

```powershell
cd C:\Users\donghao\Documents\deepseek-harness\default-workspace\plugins\workbuddy-bridge
npm test                         # = 下面三套，35 例，必须全绿
node test/verify.test.mjs        # 15 例，核对判定
node test/throttle.test.mjs      # 9 例，节流（含 1.2 秒真实窗口那条）
node test/plan.test.mjs          # 11 例，计划模式
node --check index.js; node --check client.js
```

改 `index.js` → 插件管理里关开一次即可生效；改 `client.js` → **必须重启 DSH**。

然后记账、提交、推送：

```powershell
# 先把 package.json 的 version 和 CHANGELOG.md 改好，再：
git add -A
git commit -m "feat: 一句话说清改了什么"
```

**双击 `push-to-github.cmd`** 推送（这个文件被 .gitignore 排除，是本机专用脚本，里面写死了 Git Credential Manager 的路径）。

## 版本号怎么定

- 改文案、修错别字 → patch（0.2.1）
- 加功能、改行为 → minor（0.3.0）
- 破坏性改动（改工具名、改配置字段）→ major（1.0.0）

两处文件要同步：`package.json` 的 `version` 和 `CHANGELOG.md`；市场条目提交后会重新跑检查，npm 按需再发。

## 市场上的状态

- 2026-11-05 20:05 首次提交，仓库通道，返回 `✓ Submitted`。
- 流程：dsh.so 服务端重跑检查 → 作为 issue 进后台 → 维护者人工合并 → 条目出现，状态 **Declared**（未独立验证）。
- 合并前别人也能用，直接给一条命令：

```bash
dsh plugin --profile web add github:lunatic-eclipse/dsh-codebuddy-bridge
```

- 已知遗留：格式检查里 `License file found but SPDX identifier could not be determined` 一直是 warning，
  但 GitHub 自己已识别为 MIT，安全扫描是 Pass（0 critical）。等 GitHub 索引完可以再跑一次检查。

## 发 npm（还没做，网络通再做）

本机 `registry.npmjs.org` 只解析到 IPv6、连接失败，所以暂时没走 npm 通道。
网络通了之后：

```bash
npm login                       # 或用带 bypass 2FA 的 granular token
npm publish                     # package.json 里 publishConfig 已指向官方源
```

发布前先 `npm pack --dry-run`，确认输出里包含 `cordis.patch.yml`、`client.js`、`docs/assets/` 下的截图和 `LICENSE`。

## 未完成项 + 触发条件

0.3.0 发布时仍未完成的事，以及"什么时候必须立刻补"。**没有触发条件的不列**——否则清单会变成愿望单。

| 未完成项 | 现状 | 触发条件（出现即必须补） |
| --- | --- | --- |
| npm 通道 | `registry.npmjs.org` 只解析到 IPv6，连不上，从未发过 | 有人要 `npm install dsh-codebuddy-bridge`；或换机器后 npm 可用 |
| 市场条目正式合并 | 仓库通道已提交（`✓ Submitted`），等人工合并，状态 Declared | 你要对外说"去市场装"；在那之前口径一律是 GitHub tag |
| CI | 没有流水线，测试只在本地跑 | 出现"本地绿但发布坏"；或发布人不再是你；或要给别人的分支发版 |
| 安装态冒烟 | 一直是 `link:` 开发态，没从 tag 全新安装验证过 | 0.3.0 之后第一次改 `cordis.patch.yml` / `client.js`；或有人报"装完看不到胶囊" |
| 回滚方案 | 没写。0.3.0 新增 `limits.json` 与 `plans\`，0.2.x 不认它们 | 要退回 0.2.x；或 0.3.0 出致命问题需要降级安装 |
| 节流阈值校准 | 6 轮/小时是本地经验值，没有真实分布 | 频繁误拒（一次完整交叉审查至少吃 2 轮）；或额度仍被刷爆 |
| 计划模式样本量 | 真机只跑过 2 轮（hy4free，1.5 / 3 分钟各一轮） | 用户报结论质量差、超时、或落盘不全（截断已修，见 CHANGELOG） |
| 版本 tag / GitHub Release | 没打 tag，安装走仓库默认分支；`push-to-github.cmd` 只推分支不推 tag | 需要固定版本引用（`add github:owner/repo#v0.3.0`）、要发 npm、或别人要复现某个版本 |
| 格式检查 SPDX warning | GitHub 已识别为 MIT，检查器仍报一条 warning | 市场审核因它拒绝；**不要去改 LICENSE 文本**，改 SPDX 头或补 metadata |

### 发布前检查清单（0.3.0 起）

必须做，缺一不发：

1. 在**要发布的那个提交**上跑三套测试，全绿（verify 15 / throttle 9 / plan 11）；
2. `node --check index.js && node --check client.js`；
3. `package.json` 的 `version` 与 `CHANGELOG.md` 的最新标题一致；
4. 动了节流或计划模式时，顺手在真机验一次：`limits.json` 跨重启保留、`plans\` 里那份 md 末尾完整
   （这两条都出过问题：前者是规格要求，后者是 0.3.0 实测抓到的截断 bug）。

可以延后：见上表的触发条件。

## 踩过的坑（按出现频率）

| 现象 | 原因 / 处理 |
| --- | --- |
| 双击 cmd 报一堆「不是内部或外部命令」 | cmd 按 GBK 读 UTF-8 中文；脚本必须是纯 ASCII |
| `rejected ... (stale info)` | 删库重建后本地还记着旧远端；脚本用 `--force` |
| `Invalid username or token` | 没有凭据助手，退回了密码登录；脚本已写死 GCM 绝对路径 |
| GitHub 打不开 | 本机 hosts 被 Steam++ 写成 `127.0.0.1 github.com`，且加速器没开；开着加速或删那几行 |
| 贡献者里多出个 `donghao` | 早期提交用的临时身份；GitHub 统计缓存，最多 24h 自己消失 |
| 面板/胶囊不出现 | 改过 `client.js` 没重启宿主 |

## 文件说明

| 文件 | 用途 | 会发到仓库/市场吗 |
| --- | --- | --- |
| `index.js` / `client.js` / `cordis.patch.yml` | 实现 | 是 |
| `README.md` / `README.en.md` / `USAGE.md` / `CHANGELOG.md` / `LICENSE` | 文档 | 是 |
| `docs/assets/*.png`、`screenshots.json` | 展示图 | 是 |
| `test/verify.test.mjs` / `throttle.test.mjs` / `plan.test.mjs` | 回归测试（35 例） | 是 |
| `docs/PUBLISH.md` | 发布与维护说明（含未完成项与触发条件） | 是 |
| `HANDOFF.md` / `NEXT.md` / `MARKET.md` / `VERIFY-PLAN.md` / `DIAGNOSIS.md` | 内部记录 | 否（.gitignore 排除） |
| `push-to-github.cmd` | 本机推送脚本 | 否（.gitignore 排除） |
