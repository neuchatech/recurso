# Recurso

Recurso is an RPC-backed thread orchestration package for Pi.

It gives Pi agents a small set of tools for creating, forking, messaging,
inspecting, and aborting live Recurso threads. Each thread is a real
`pi --mode rpc` child process with its own session file and context window.

## Status

Early package scaffold. The API is usable for local testing, but expect the
tool names and registry format to evolve before a `1.0.0` release.

## Install

Local development:

```bash
pi install ./recurso -l
```

If this directory is the repository root, use:

```bash
pi install . -l
```

From a git repo:

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

To have Recurso threads appear in Pi's normal session history, opt in
when starting Pi:

```bash
RECURSO_SESSION_DIR=default pi
```

For a persistent personal setup, export it from your shell profile:

```bash
export RECURSO_SESSION_DIR=default
```

This setting affects threads that Recurso spawns. The current Pi session's
history location is chosen when Pi starts, before Recurso loads. If you start a
parent RPC process manually and want that parent to appear beside its spawned
threads in normal Pi history, do not pass a custom parent `--session-dir`:

```bash
RECURSO_SESSION_DIR=default pi -e ./recurso --mode rpc
```

If you do pass `--session-dir` to the parent process, that parent session stays
in the custom directory even when spawned Recurso threads use normal Pi history.

## Tools

Recurso uses namespaced tool names so it can coexist with other experiments.

| Tool | Purpose |
| --- | --- |
| `recurso_new_thread` | Start a fresh live Recurso thread. |
| `recurso_fork_thread` | Fork the current session, or a previous Recurso thread, into a live Recurso thread. |
| `recurso_message_thread` | Send a message to a thread. Defaults to follow-up queueing; can steer. |
| `recurso_peek_thread` | Inspect a live or persisted thread. |
| `recurso_list_threads` | List live threads owned by the current manager process. |
| `recurso_abort_thread` | Abort a running turn or terminate a thread process. |

## Messaging Semantics

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

This form works whether the target thread is idle or already streaming.

## Stop And Wake Behavior

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

This is why agents should not sleep or poll by default after spawning threads.
Spawned threads should report `question`, `progress`, or `done`; those
messages wake the receiver. Polling and `recurso_peek_thread` remain useful for
diagnosis, progress audits, time-sensitive coordination, or when a message
needs more context.

## How It Works

The Recurso extension acts as the local manager for the current Pi process.
It is the "daemon" while that Pi process is alive. It is not a separate
system service.

When an agent creates or forks a thread, Recurso:

1. Spawns `pi --mode rpc` as a child process.
2. Loads the Recurso extension into that child.
3. Stores thread metadata in memory and snapshots it under `.pi/recurso/runs/`.
4. Sends the thread assignment with RPC `prompt`.
5. Reads the child's RPC event stream.
6. Routes `recurso_message_thread` tool calls to the spawning thread, sibling
   threads, or local descendants.

The process tree is only an ownership and routing detail. Every Recurso thread
has the same Recurso tools and can create, fork, and message threads. The
special target `parent` is just an alias for the thread that spawned the current
thread; use concrete thread IDs when messaging known siblings or descendants.

By default, thread sessions are stored under `.pi/recurso/sessions/`. Set
`RECURSO_SESSION_DIR=default` to let spawned threads use Pi's normal session
history instead. Spawned threads inherit the current provider and model unless
a tool call supplies `provider` or `model` explicitly.

## Typical Use

```text
Use recurso_fork_thread to ask one thread to inspect the auth module and
another to inspect the billing module. Have them report back with
recurso_message_thread when done.
```

Spawned threads can call:

```text
recurso_message_thread({ target: "parent", type: "done", message: "..." })
```

or:

```text
recurso_message_thread({ target: "parent", type: "question", message: "..." })
```

`question` and `done` messages ask the spawned thread to stop after sending the
message. `progress` is for sparse milestones only.

## Skills

The package includes:

- `/skill:recurso`
- `/skill:recurso-orchestrator`
- `/skill:recurso-worker`

The tools do the mechanics. `/skill:recurso` is the general guidance. The
orchestrator and worker skills are optional role-focused prompts, not separate
thread capabilities.

## Configuration

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `RECURSO_PI_BIN` | `pi` | Pi executable used for spawned RPC processes. |
| `RECURSO_SESSION_DIR` | `.pi/recurso/sessions` | Spawned thread session storage. Set `default`, `pi`, `pi-default`, or `history` to use Pi's normal session directory; set a path to use a custom directory. Relative paths resolve from the workspace cwd. |
| `RECURSO_MAX_DEPTH` | `3` | Maximum recursive thread depth. |
| `RECURSO_MAX_PARALLEL_THREADS` | `10` | Maximum live Recurso threads in one Recurso run tree. |
| `RECURSO_BOOTSTRAP_CHILDREN` | auto | Set `1` to force child processes to load this extension by path; set `0` to disable. |
| `RECURSO_DEBUG` | unset | If set, mirrors child stderr to the manager stderr. |

## Data Layout

```text
.pi/recurso/
  prompts/      # generated thread system prompt files
  runs/         # per-manager thread registry snapshots
  sessions/     # spawned thread session JSONL files, unless RECURSO_SESSION_DIR=default
```

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
Review the package, your Pi settings, and any loaded extensions before using
it on sensitive repositories.

## Development Checks

From the workspace used during development:

```bash
npx --yes esbuild recurso/extensions/recurso/index.ts \
  --bundle --platform=node --format=esm --target=node20 \
  --external:@earendil-works/pi-ai \
  --external:@earendil-works/pi-coding-agent \
  --external:typebox \
  --outfile=/tmp/recurso-index.mjs

printf '{"id":"state","type":"get_state"}\n{"id":"commands","type":"get_commands"}\n' \
  | PI_CODING_AGENT_DIR="$PWD/.pi/agent" RECURSO_SESSION_DIR=default \
      pi -e "$PWD/recurso" --no-extensions --offline --mode rpc

npm pack ./recurso --pack-destination /tmp
```
