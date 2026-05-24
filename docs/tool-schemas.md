# Recurso v1 Tool Contract

Recurso v1 exposes six namespaced Pi tools. Tool details include:

```json
{
  "recursoApiVersion": "1.1.0",
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
- `tools` string array, optional: tool allowlist. Recurso tools are added automatically.

## `recurso_fork_thread`

Fork the current Pi session, or an existing Recurso thread, into a live
Recurso thread.

Parameters:

- `task` string, required.
- `fork_from` string, optional: Recurso thread id to fork from.
- `context`, `name`, `model`, `provider`, `tools`: same as `recurso_new_thread`.

## `recurso_message_thread`

Send a message to another Recurso thread, `parent`, or `root`.

Parameters:

- `target` string, required: Recurso thread id, `parent`, or `root`.
- `type` enum, required: `question`, `done`, or `progress`.
- `message` string, required: self-contained message.
- `deliver_as` enum, optional: `followUp` or `steer`; defaults to `followUp`.

`question` and `done` messages to the spawning thread ask the sender to stop
after the tool call. The process remains alive and can be woken later.

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
- `RECURSO_SESSION_DIR`: `default` behavior uses Pi history. `isolated`,
  `local`, or `recurso` use `.pi/recurso/sessions`. Any other value is a custom path.
- `RECURSO_MAX_DEPTH`: recursive depth cap. Default `3`.
- `RECURSO_MAX_PARALLEL_THREADS`: live threads per run tree. Default `10`.
- `RECURSO_BOOTSTRAP_CHILDREN`: force or disable extension bootstrapping.
- `RECURSO_OPENAI_CACHE_LINEAGE`: experimental OpenAI fork-cache lineage
  key. Set `1` to rewrite OpenAI `prompt_cache_key` for parent/fork reuse.
- `RECURSO_DEBUG`: mirror child stderr to manager stderr.
