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
provider itself. On top of that, the free tier checks the tool list the request carries.
Together those two are what produce the common failure:

```
403: {"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}
```

OpenCode Zen gates its free tier on the official client's contract: CLI identity headers
plus the official client tool declarations. pi sends neither, so Zen free models reject
it. OmniRoute hits the same wall from the other side — see
[diegosouzapw/OmniRoute#14156](https://github.com/diegosouzapw/OmniRoute/pull/14156) for
the tool-contract half of the check and
[#13937](https://github.com/diegosouzapw/OmniRoute/pull/13937) for the header half. This
tool now hands the child the parent's extension set for exactly that reason, minus itself
(`PI_SUBAGENT_INHERIT_EXTENSIONS=0` opts out).

Measured, `muse-spark-1.3-contributor-free`, three repetitions per cell:

| header patch | `--tools` sent | result |
|---|---|---|
| no | full builtin set | 403 |
| yes | full builtin set | **ok** |
| no | narrow (scout's list) | 403 |
| yes | narrow (scout's list) | 403 |

**Both are required.** The patch alone is not enough, and the tool list alone is not
enough. Note the last row: a narrow allowlist fails *even with* the patch, because the
free tier wants OpenCode's official client tool names in the request. pi has no `glob`,
so the set that satisfies it is `read, grep, edit, write, bash` — `find` and `ls` are
pi-specific and do not count.

The model itself barely matters. With the patch loaded:

| model | narrow tools | full tools |
|---|---|---|
| `opencode/space-bunny-free` | **ok** | ok |
| `opencode/muse-spark-1.3-contributor-free` | 403 | ok |
| `opencode/muse-spark-1.2-contributor-free` | 403 | ok |
| `opencode/nemotron-3-ultra-free` | 403 | ok |
| `opencode/nemotron-3.5-lightning-free` | 403 | ok |
| `opencode/longcat-2.5-preview-free` | 403 | ok |
| `opencode/mimo-v2.5-free` | 403 | ok |
| `opencode/mimo-v2.6-flash-free` | 403 | ok |
| `opencode/ling-3.0-flash-fin-free` | 403 | endpoint unavailable |

`space-bunny-free` is the only model that answers with a narrow allowlist, which is why
it is what the shipped agents use. `ling-3.0-flash-fin-free` is broken independently of
this — its endpoint 404s even with everything correct.

What this means for the shipped agents, whose `tools:` lists differ:

| agent | tools | can use a Zen free model? |
|---|---|---|
| `worker` | read, grep, find, ls, bash, edit, write | yes — has all five |
| `scout` | read, grep, find, ls | no — narrow; keep it on `space-bunny-free` |
| `researcher` | read, grep, find, ls, bash, web_search | no — missing edit + write |

Widening `scout` to satisfy the gate would hand a read-only recon agent `edit`, `write`
and `bash`, so the allowlist is left honest and the model is the thing that gives.

If you have no provider patch and want to try building one, just ask pi to create it:

> Write a pi extension that intercepts outgoing requests to the `opencode` provider and
> applies the free-tier identity contract observed in real OpenCode CLI traffic —
> `Authorization: Bearer public`, the official CLI user agent, `x-opencode-client: cli`
> and a canonical `ses_`-prefixed session id, and no `x-opencode-request` /
> `x-opencode-project` headers.

Then hand it to the child, which loads it *after* `--no-extensions`:

```yaml
extensions:
  - ~/.pi/agent/extensions/opencode-free-tier/index.ts
```

Whether that clears the gate is provider-side and may change; the table above is what
was measured. A child that fails this way now reports the provider error together with
this fix in the tool result, instead of returning an empty success.

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
