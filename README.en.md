# CodeBuddy Bridge (DSH plugin)

Bridges the local **CodeBuddy CLI** (the engine bundled with the WorkBuddy desktop app) into
DeepSeek Harness: hand work over, get the result back in the conversation, then **verify per round
what actually changed**.

> Model-facing instructions live in [USAGE.md](USAGE.md). This file is for humans and marketplace review.

## Why

Pair an agent that does the work with an agent that checks it. Most "collaboration" stops at
"it said it changed the file". This plugin adds the missing step: it diffs the current file against
the pre-image the CLI itself kept, and returns PASS / FAIL with evidence.

## Requirements

- Windows (the engine path is discovered from the WorkBuddy install; other platforms untested)
- WorkBuddy desktop installed (it ships the CodeBuddy CLI), or `@tencent-ai/codebuddy-code` on your own
- Optional: the `dsh-connect-workbuddy` plugin, which provides the `/codebuddy` relay route

The plugin never reads, stores, or forwards credentials — authentication belongs to the CLI.

## Install

```bash
dsh plugin --profile web add dsh-codebuddy-bridge
```

## Use

1. Turn on the “CodeBuddy 协作” pill under the composer (per session).
2. Ask your agent to delegate: it calls `workbuddy_relay(prompt, edit: true)`.
3. The result is injected into the conversation; the panel above the composer lists each step.
4. Ask it to verify: `workbuddy_verify()` returns PASS / FAIL / WARN with evidence, no API cost.

Two modes, both fixed-template so runs are comparable:

| Mode | Tool | Output |
| --- | --- | --- |
| **Audit** — find what is wrong | `workbuddy_review(path, focus?, maxFindings?)` | location — problem — fix, at most N findings, 200 chars |
| **Plan** — decide what to do | `workbuddy_relay(prompt, mode: "plan")` | conclusion first, then constraints / assumptions / routes / a counter-example per route / recommendation; read-only, saved to `plans\<timestamp>.md` |

`relay` and `review` share a budget of **6 rounds per session per hour**; over it the tool returns
`{ rejected: true, retryAfterSec }` without ever calling the CLI. `verify` / `read` / `status` are local
and free.

## Privacy

Reads `~/.codebuddy/projects/**` (CLI transcripts) and, for `workbuddy_read`, `~/.workbuddy/projects`.
Writes only inside `collabDir` (default `~/.dsh/codebuddy-bridge`) plus whatever the engine edits under
its permission mode. No network calls of its own.

## License

MIT
