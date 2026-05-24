---
name: recurso
description: Use Recurso live Pi threads for event-driven parallel agent work with RPC-backed create, fork, message, inspect, and abort tools.
---

# Recurso

Use Recurso when independent work can make progress in another live Pi thread.

## Mental Model

- Every Recurso thread is a normal Pi agent with the same Recurso tools.
- Spawned workers receive an automatic identity block with their thread id,
  parent/orchestrator id, worker type, assignment, and report-back example.
- `parent` is a live-run routing alias for the thread that spawned the current thread.
- Prefer concrete Recurso thread IDs when a prompt gives you one, especially for
  parent, sibling, or descendant messaging.
- The process tree is only an ownership and routing detail; it is not a capability boundary.

## Tools

- `recurso_new_thread`: start a fresh thread without current conversation history.
- `recurso_fork_thread`: fork the current session, or an existing Recurso thread.
- `recurso_message_thread`: send a follow-up or steering message to a thread.
- `recurso_peek_thread`: inspect a thread for debugging or after a received message needs more context.
- `recurso_list_threads`: check live thread inventory for this manager.
- `recurso_abort_thread`: abort a turn or terminate a thread.

## Operating Rules

- Fork only work with a clear deliverable.
- Keep fan-out purposeful. Recurso's default runtime cap is 10 live threads in one run tree.
- Spawned threads inherit the current provider, model, and thinking level unless
  a tool call supplies `provider`, `model`, or `thinking`.
- Use `thinking: "low"` or `thinking: "medium"` for routine worker threads, and
  reserve `thinking: "high"` or `thinking: "xhigh"` for genuinely difficult analysis.
- Default messages to `deliver_as: "followUp"`.
- Use `deliver_as: "steer"` only for urgent correction, safety, or blocker handling.
- After spawning workers, do not watch them with repeated `recurso_peek_thread`
  calls. Either do useful local work or stop and wait for their queued messages.
- `question` and `done` messages wake the receiving thread; this is the normal
  coordination mechanism.
- Use `recurso_peek_thread` only for debugging, suspected malfunction, or when a
  received message requires more context. Do not peek just to see if a worker is done.
- Any thread may create, fork, or message other threads when that helps the assignment.
- After sending `question` or `done` to the spawning thread, stop unless explicitly
  instructed to continue.

## Message Shape

Report back to the spawning thread with:

```text
recurso_message_thread({
  target: "the-parent-thread-id-from-your-prompt",
  type: "done",
  message: "Concise result, files changed, checks run, risks."
})
```

Use `target: "parent"` only when no concrete parent thread id was provided or
when the prompt says the parent is the root parent session.
