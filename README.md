# Recurso

Agent-to-agent orchestration for Pi.

Recurso gives a Pi agent the missing move: it can create other live Pi agents,
fork context into them, message them, wake them later, and inspect what they did
afterward. Instead of forcing one model call to pretend it is a whole team,
Recurso lets an agent use agentic AI the way a human operator would: start
focused collaborators, hand them bounded work, and coordinate through messages.

Each Recurso thread is a real `pi --mode rpc` process with its own context
window, session file, tools, and model loop. Threads can stop when they report
`done` or `question`, then wake up when another thread sends them more work.
That means orchestrators do not need to sit there polling. They can let the
runtime carry messages.

## Why Recurso

Most agentic environments still have a single-agent bottleneck:

- one context has to remember every workstream;
- "subagents" often collapse into polling, log scraping, or final-only reports;
- parent agents waste turns checking whether workers finished;
- sibling agents cannot easily coordinate with each other;
- users cannot inspect the actual threads that did the work.

Recurso turns Pi into a live agent network:

- agents can create and fork other agents on demand;
- any Recurso thread can message any known thread id;
- `parent` is only a routing alias for "the thread that spawned me";
- `followUp` queues work patiently, while `steer` handles urgent corrections;
- `question` and `done` messages wake the receiver and can let the sender stop;
- sessions use Pi's normal history by default, so the work is inspectable.

This is intentionally simple. Recurso is not a remote platform, not a database,
and not a heavyweight daemon. It is a Pi package that gives Pi agents a clean
local message bus and a way to run more Pi agents.

## Status

`v1.1.0` is the current public release. The core tool names, message
contract, default session-history behavior, and snapshot schema are intended to
remain compatible across `1.x`.

## Install

From GitHub:

```bash
pi install git:github.com/neuchatech/recurso
```

From a checkout:

```bash
git clone https://github.com/neuchatech/recurso.git
cd recurso
pi install . -l
```

Temporary one-run load:

```bash
pi -e ./recurso
```

Pi discovers the package through the `pi` manifest in `package.json`.

## Quick Start

Ask Pi to use Recurso:

```text
Use /skill:recurso.

Fork one thread to inspect the auth module and another to inspect the billing
module. Have them report back with recurso_message_thread when done. Do not
poll by default; let their messages wake you.
```

The spawned threads can report:

```text
recurso_message_thread({
  target: "parent",
  type: "done",
  message: "Concise result, files changed, checks run, risks."
})
```

Or ask a blocking question:

```text
recurso_message_thread({
  target: "parent",
  type: "question",
  message: "I found two possible APIs. Which one should I align with?"
})
```

Use a concrete thread id instead of `parent` when messaging a known sibling or
descendant thread.

## Session History

Recurso uses Pi's normal session history by default. That is deliberate:
threads should be inspectable in the same place you already inspect Pi work.

If you want isolated Recurso session files instead:

```bash
RECURSO_SESSION_DIR=isolated pi
```

For a custom directory:

```bash
RECURSO_SESSION_DIR=.pi/recurso/sessions pi
```

This setting affects threads that Recurso spawns. The current Pi session's
history location is chosen when Pi starts, before Recurso loads. If you start a
parent RPC process manually and want that parent to appear beside its spawned
threads in normal Pi history, do not pass a custom parent `--session-dir`:

```bash
pi -e ./recurso --mode rpc
```

If you do pass `--session-dir` to the parent process, that parent session stays
in the custom directory even when spawned Recurso threads use normal Pi history.

## Tools

Recurso uses namespaced tool names so it can coexist with other Pi packages.

| Tool | Purpose |
| --- | --- |
| `recurso_new_thread` | Start a fresh live Recurso thread. |
| `recurso_fork_thread` | Fork the current session, or a previous Recurso thread, into a live Recurso thread. |
| `recurso_message_thread` | Send a message to a thread. Defaults to follow-up queueing; can steer. |
| `recurso_peek_thread` | Inspect a live or persisted thread. |
| `recurso_list_threads` | List live threads owned by the current manager process. |
| `recurso_abort_thread` | Abort a running turn or terminate a thread process. |

## Messaging

Recurso sends messages through Pi RPC `prompt` commands with
`streamingBehavior`:

```json
{ "type": "prompt", "message": "...", "streamingBehavior": "followUp" }
```

`followUp` is the default. It waits until the target thread finishes its
current work. Use `steer` only for urgent corrections or blockers:

```json
{ "type": "prompt", "message": "...", "streamingBehavior": "steer" }
```

This works whether the target thread is idle or already streaming.

## Stop And Wake

Recurso threads are meant to be event-driven.

When a spawned thread calls `recurso_message_thread` with `target: "parent"`
and `type: "question"` or `type: "done"`, the tool asks Pi to stop that
thread's current run after the message tool call. The RPC process stays alive
and idle.

Later, when the spawning thread sends it another `recurso_message_thread`
message, Recurso dispatches the message with RPC `prompt`:

- if the target thread is idle, the message wakes it and starts a new turn;
- if the target thread is busy, `followUp` queues it until the thread stops;
- if the target thread needs urgent correction, `steer` queues it before the
  next model call.

Polling and `recurso_peek_thread` remain useful for diagnosis, progress audits,
time-sensitive coordination, or when a message needs more context. They should
not be the default coordination loop.

## How It Works

The Recurso extension acts as the local manager for the current Pi process. It
is the "daemon" while that Pi process is alive. It is not a separate system
service.

When an agent creates or forks a thread, Recurso:

1. Spawns `pi --mode rpc` as a child process.
2. Loads the Recurso extension into that child.
3. Stores thread metadata in memory and snapshots it under `.pi/recurso/runs/`.
4. Sends the thread assignment with RPC `prompt`.
5. Reads the child's RPC event stream.
6. Routes `recurso_message_thread` tool calls to the spawning thread, sibling
   threads, or local descendants.

The process tree is only an ownership and routing detail. Every Recurso thread
has the same Recurso tools and can create, fork, and message threads. Spawned
threads inherit the current provider and model unless a tool call supplies
`provider` or `model` explicitly.

## Skills

The package includes:

- `/skill:recurso`
- `/skill:recurso-orchestrator`
- `/skill:recurso-worker`

The tools do the mechanics. `/skill:recurso` is the general guidance. The
orchestrator and worker skills are optional role-focused prompts, not separate
thread capabilities.

## Examples

See [`examples/`](examples/) for copy-pasteable prompts:

- [`code-review-team.md`](examples/code-review-team.md): split code review
  across focused reviewers, then synthesize the risks.
- [`research-swarm.md`](examples/research-swarm.md): run independent research
  questions and reconcile the findings.
- [`implementation-and-verification.md`](examples/implementation-and-verification.md):
  keep implementation and verification in separate live threads.

See [`docs/tool-schemas.md`](docs/tool-schemas.md) for the v1 tool contract.

## Provider Cache Behavior

Recurso always preserves the logical Pi conversation when it forks a thread.
Provider-side prompt cache reuse is different: each model provider decides what
counts as the same cache line. Recurso 1.1 includes a probe harness and one
opt-in OpenAI cache-lineage experiment so users can make informed choices.

| Provider path | Current result | Recurso wake-up pattern |
| --- | --- | --- |
| Anthropic direct | Strong. Parent and fork both read cache via Pi's Anthropic `cache_control` behavior. | Works when an idle child wakes after the parent has continued. |
| OpenAI direct | Partial. `RECURSO_OPENAI_CACHE_LINEAGE=1` can make parent and fork share `prompt_cache_key`, but hits are ordering-sensitive. | Best-effort only; child may miss if the parent advances first. |
| OpenRouter DS4 pinned to DeepSeek | Mixed. Fork-first can hit, but timing and routing affect results. | Best-effort only. |
| Gemini AI Studio | No implicit cache hits observed for `gemini-2.5-flash` or `gemini-3.5-flash`. | Needs explicit `cachedContent` work before it can be treated as cache-aware. |

The practical guidance is simple: use Recurso for orchestration first, and
treat provider cache reuse as an optimization. Anthropic currently looks best
for sleeping workers that wake later with warm cache. OpenAI and OpenRouter can
still benefit, but should not drive scheduler correctness.

## Configuration

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `RECURSO_PI_BIN` | `pi` | Pi executable used for spawned RPC processes. |
| `RECURSO_SESSION_DIR` | `default` | Spawned thread session storage. `default`, `pi`, `pi-default`, or `history` use Pi's normal session directory. `isolated`, `local`, or `recurso` use `.pi/recurso/sessions`. Any other value is treated as a custom path relative to the workspace cwd unless absolute. |
| `RECURSO_MAX_DEPTH` | `3` | Maximum recursive thread depth. |
| `RECURSO_MAX_PARALLEL_THREADS` | `10` | Maximum live Recurso threads in one Recurso run tree. |
| `RECURSO_BOOTSTRAP_CHILDREN` | auto | Set `1` to force child processes to load this extension by path; set `0` to disable. |
| `RECURSO_OPENAI_CACHE_LINEAGE` | unset | Experimental. Set `1` to give OpenAI parent and forked Recurso sessions the same hashed `prompt_cache_key` lineage for better fork prompt-cache reuse. |
| `RECURSO_DEBUG` | unset | If set, mirrors child stderr to the manager stderr. |

## Data Layout

Recurso always stores local runtime metadata:

```text
.pi/recurso/
  prompts/      # generated thread system prompt files
  runs/         # per-manager thread registry snapshots
```

If `RECURSO_SESSION_DIR=isolated`, spawned thread sessions are also stored at:

```text
.pi/recurso/sessions/
```

## Roadmap

Recurso v1 is local, process-tree based orchestration. Future releases may add
reattachment to existing live processes after a parent restart, richer
visualization for recursive descendants, and more automated scenario tests as
Pi's RPC surface evolves.

## Notes

- Recurso addresses threads by logical IDs like `th-m3k9...`, not PIDs.
- PIDs are recorded only for diagnostics and cleanup.
- A Pi process can directly list and abort only the threads it spawned.
  Recursive descendants have their own local managers.
- If a Pi process exits, Recurso terminates the live threads it spawned.
- RPC stdout is protocol data. Recurso uses strict LF-delimited JSONL parsing
  and does not rely on stderr message side channels.

## Security

Pi packages execute arbitrary code with your user permissions. Recurso starts
additional Pi processes that can use the tools available to those processes.
Review the package, your Pi settings, and any loaded extensions before using it
on sensitive repositories. See [`SECURITY.md`](SECURITY.md).

## Development Checks

From a checkout of this package:

```bash
npm run check
npm run check:pi
npm run check:live
```

`check:live` requires a working Pi model/provider configuration.
