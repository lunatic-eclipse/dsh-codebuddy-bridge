# 发布与维护

给以后的自己看。仓库：<https://github.com/lunatic-eclipse/dsh-codebuddy-bridge>

## 改完代码怎么发

```powershell
cd C:\Users\donghao\Documents\deepseek-harness\default-workspace\plugins\workbuddy-bridge
node test/verify.test.mjs        # 14 例，必须全绿
node --check index.js; node --check client.js
```

改 `index.js` → 插件管理里关开一次即可生效；改 `client.js` → **必须重启 DSH**。

然后记账、提交、推送：

```powershell
# 1. 改 package.json 的 version，并在 CHANGELOG.md 顶部加一条
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

发布前先 `npm pack --dry-run`，确认 18 个文件里包含 `cordis.patch.yml`、`client.js`、`docs/assets/*.png`。

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
| `test/verify.test.mjs` | 回归测试 | 是 |
| `HANDOFF.md` / `NEXT.md` / `MARKET.md` / `VERIFY-PLAN.md` / `DIAGNOSIS.md` | 内部记录 | 否（.gitignore 排除） |
| `push-to-github.cmd` | 本机推送脚本 | 否（.gitignore 排除） |
