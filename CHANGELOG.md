# Changelog

## 未发布（0.3 开发中）

- `workbuddy_review(path, focus?, maxFindings?)`：只读审查固化成工具，固定模板 + 自动 UNREAD 核对。
- verify 新增 UNREAD 判定：纯审查轮核对该读的文件到底读没读。
- 审查轮记录 prompt 与 `requested` 文件列表，供 UNREAD 使用。

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
