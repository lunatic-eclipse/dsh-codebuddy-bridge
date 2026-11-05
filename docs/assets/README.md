# 截图清单（商品页用）

三张就够。按下面的文件名存到这个目录，`screenshots.json` 已经指好了。

| 文件 | 拍什么 | 必须看得见 |
| --- | --- | --- |
| `dsh-codebuddy-bridge-panel.png` | 跑完一轮后的**面板展开态** | 标题「CodeBuddy 协作」、时间/工具数、步骤行（读取/修改）、结论摘要、右侧模型下拉、底部/顶部的拖拽短横 |
| `dsh-codebuddy-bridge-pill.png` | 输入框下方的**胶囊**（开着的状态） | 「CodeBuddy 协作 · 开」，最好带一点点输入框，能看出位置 |
| `dsh-codebuddy-bridge-verify.png` | `workbuddy_verify` 的**输出** | `[PASS]` / 证据行（内容已变、备份 hash、mtime）、末行 PASS/FAIL 计数 |

可选第四张（想展示收起/拖高再拍）：`dsh-codebuddy-bridge-collapsed.png`。

## 怎么拍

- `Win + Shift + S` 框选，或 Snipping Tool；存 PNG。
- 宽度建议 **1200–1600px**，高度按内容裁，别留大片黑边。
- 只框界面，不要带桌面、其它窗口、浏览器标签栏。
- **先检查隐私**：会话正文里如果有真实路径、人名、密钥、客户数据，换一轮无关紧要的演示内容再拍
  （现在 `.collab` 里那几轮 demo 就挺合适：worklog.md 的创建/修改/审查）。
- 暗色界面没问题，市场里大部分截图都是暗色。

## 拍完我来做

把文件放进本目录后告诉我，我会：确认尺寸 → 在 README 顶部插入展示图 → 把 `docs/assets` 和 `screenshots.json` 加进 `files` → 重新 `npm pack --dry-run` 核对。
