# Recurso v1 Tool Contract

Recurso v1 exposes six namespaced Pi tools. Tool details include:

```json
{
  "recursoApiVersion": "1.1.5",
  "schemaVersion": 1
}
```

The v1 compatibility promise covers tool names, required parameters, message
types, delivery modes, and the default Pi-history session storage behavior.

## `recurso_new_thread`

Start a fresh live Recurso thread.

Parameters:

- `task` string, required: assignment and expected deliverable.
- `context` string, optional: extra context appended to thread instructions.
- `name` string, optional: session display name.
- `model` string, optional: Pi model pattern.
- `provider` string, optional: Pi provider.
- `thinking` enum, optional: `off`, `minimal`, `low`, `medium`, `high`, or
  `xhigh`.
- `tools` string array, optional: tool allowlist. Recurso tools are added automatically.

## `recurso_fork_thread`

Fork the current Pi session, or an existing Recurso thread, into a live
Recurso thread.

The spawned worker receives an explicit visible identity and assignment packet:
worker thread id, parent/orchestrator thread id, whether it is a fresh or forked
worker, report-back instructions, and stop-after-`done` / stop-after-`question`
rules.

Parameters:

- `task` string, required.
- `fork_from` string, optional: Recurso thread id to fork from.
- `context`, `name`, `model`, `provider`, `thinking`, `tools`: same as
  `recurso_new_thread`.

## `recurso_message_thread`

Send a message to another Recurso thread, `parent`, or `root`.

Parameters:

- `target` string, required: Recurso thread id, `parent`, or `root`.
- `type` enum, required: `question`, `done`, or `progress`.
- `message` string, required: self-contained message.
- `deliver_as` enum, optional: `followUp` or `steer`; defaults to `followUp`.

`question` and `done` messages to the spawning thread ask the sender to stop
after the tool call. The process remains alive and can be woken later.

Supervisor managers route Recurso message tool calls from child RPC events.
Routing is attempted from both tool-start arguments and tool-end result details
so a worker report is not lost if one event shape is incomplete.

## `recurso_peek_thread`

Inspect a known Recurso thread without sending a message.

Parameters:

- `thread_id` string, required.
- `mode` enum, optional: `compact`, `messages`, `tools`, or `raw`; defaults to `compact`.
- `max_entries` number, optional: 1 to 100; defaults to 20.

## `recurso_list_threads`

List Recurso threads in the current run.

Parameters:

- `include_descendants` boolean, optional: include descendant threads discovered
  from run snapshots. Defaults to true.

Direct threads are owned by the current manager and can be messaged, peeked, or
aborted directly. Descendant threads are visible for inspection and coordination
context, but their immediate manager owns process control.

## `recurso_abort_thread`

Abort a direct Recurso thread's current turn or terminate the process.

Parameters:

- `thread_id` string, required.
- `action` enum, optional: `abort_turn` or `terminate`; defaults to `abort_turn`.

## Environment

- `RECURSO_PI_BIN`: Pi executable. Default `pi`.
- `RECURSO_SESSION_DIR`: default behavior inherits the parent Pi session history
  directory so spawned threads appear beside the session that created them.
  `cwd` or `pi-cwd` use Pi's cwd-derived history directory. `isolated`, `local`,
  or `recurso` use `.pi/recurso/sessions`. Any other value is a custom path.
- `RECURSO_MAX_DEPTH`: recursive depth cap. Default `3`.
- `RECURSO_MAX_PARALLEL_THREADS`: live threads per run tree. Default `10`.
- `RECURSO_BOOTSTRAP_CHILDREN`: force or disable extension bootstrapping.
- `RECURSO_SHUTDOWN_BEHAVIOR`: `keep` or `terminate`. Default `keep`.
- `RECURSO_OPENAI_CACHE_LINEAGE`: experimental OpenAI fork-cache lineage
  key. Set `1` to rewrite OpenAI `prompt_cache_key` for parent/fork reuse.
- `RECURSO_DEBUG`: mirror child stderr to manager stderr.
