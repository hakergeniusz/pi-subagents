# pi-subagent-tool

A Pi extension that adds one tool, `subagent`, for delegating work to isolated child
`pi` processes — sequentially or in parallel — with per-agent model, tool allowlist, and
system prompt.

## Why

Long single-threaded agent runs accumulate context, and every question gets answered by
the same model with the same blind spots. A subagent gets a **fresh context**, its own
tool allowlist, and returns only a final report — so parallel independent questions
("where is auth handled?", "what breaks if I change this signature?") run concurrently
instead of serially in one bloated transcript.

## Install

```bash
pi install /home/hakergeniusz/pi-subagents     # local path source
```

Verify with `pi list` and `/subagents`.

## Usage

From the model:

```
subagent(task: "why is compaction firing twice?", agent: "scout")
subagent(batch: [
  { agent: "scout",   task: "map every caller of buildSessionContext()" },
  { agent: "researcher", task: "what does the compaction doc say about thresholds?" }
])
```

From you:

```
/subagents                                  # list agents, models, tool allowlists
/subagents scout map the provider registry  # prefill a subagent call
```

## Agent definitions

One Markdown file per agent in `agents/`, with YAML frontmatter:

```markdown
---
name: scout
description: Fast read-only reconnaissance.
model: opencode/space-bunny-free     # optional — defaults to the parent model
thinking: low                        # optional
tools: read, grep, find, ls, bash    # optional allowlist; omit for all builtins
extensions:                          # optional extra extensions for the child only
  - ./helpers/my-ext.ts
---
You are a read-only reconnaissance agent. ...
```

The body is the subagent's system prompt, appended to pi's default coding prompt.

## How the child is launched

```
pi -p --mode json --no-session
   --no-extensions --no-prompt-templates --no-themes
   [--extension <agent extensions>] [--append-system-prompt <body>]
   [--tools <allowlist>] [--thinking <level>] [--provider p --model m]
   <task>
```

* `--no-extensions` is always passed, so a subagent never inherits the parent's
  extension set (and can never re-enter this tool by accident).
* Child `usage` is summed into the tool result, so `/tokens` and session totals stay
  correct.
* `ctx.signal` abort → `SIGTERM`, escalating to `SIGKILL` after 3s.
* Output is truncated to 20 000 chars per agent, head+tail, with an explicit marker.

### Provider patches and the isolation trade-off

Because children get `--no-extensions`, they also lose any extension that patches the
provider itself. The common case is opencode's free tier: every `opencode/*` free model
except `space-bunny-free` is rejected outside the OpenCode client with

```
403: {"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}
```

`opencode/space-bunny-free` answers without the patch, which is why the shipped agents
work out of the box. If you switch an agent to another opencode free model, either give
the child the patch:

```yaml
extensions:
  - ~/.pi/agent/extensions/opencode-free-tier/index.ts
```

or pick a model that works without one (`opencode/space-bunny-free`,
`openrouter/poolside/laguna-xs-2.1:free`, or anything you hold a key for). A child that
fails this way now says so in the tool result instead of returning a bare 403.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PI_SUBAGENT_DEPTH` | `0` | Generation counter, set by the parent. |
| `PI_SUBAGENT_MAX_DEPTH` | `1` | Deepest generation that gets the tool. |
| `PI_SUBAGENT_MAX_PARALLEL` | `3` | Max tasks per `batch` (hard cap 8). |
| `PI_SUBAGENT_DEFAULT` | `worker` | Agent used when `agent` is omitted. |
| `PI_SUBAGENT_OUTPUT_LIMIT` | `20000` | Per-agent output char limit. |
| `PI_SUBAGENT_TIMEOUT_MS` | `900000` | Per-agent wall-clock timeout (15 min). |
| `PI_SUBAGENT_ALLOWED` | — | Comma list restricting a child's registry. |

## Notes / limits

* Each subagent pays full process startup (~0.3–2s) plus a cold model call. Below
  ~2s of expected work, do it inline.
* Parallel children compete for the same provider rate limit and for local RAM
  (llama.cpp: each child holds its own KV cache). Keep `MAX_PARALLEL` modest.
* A subagent cannot ask the user anything; make it self-contained.
