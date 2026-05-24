---
name: recurso-orchestrator
description: Coordinate work with Recurso live Pi threads using RPC-backed create, fork, message, inspect, and abort tools.
---

# Recurso Orchestrator

Use Recurso when independent work can make progress without constant parent
attention.

## Tools

- `recurso_new_thread`: start a fresh worker without parent conversation context.
- `recurso_fork_thread`: fork the current session, or an existing Recurso thread.
- `recurso_message_thread`: send a follow-up or steering message to a thread.
- `recurso_peek_thread`: inspect a thread when you need context for a decision.
- `recurso_list_threads`: check live thread inventory.
- `recurso_abort_thread`: abort a turn or terminate a thread.

## Operating Rules

- Fork only work with a clear deliverable.
- Keep no more than five active workers unless the user explicitly asks for more.
- Default messages to `deliver_as: "followUp"`.
- Use `deliver_as: "steer"` only for urgent correction, safety, or blocker handling.
- Do not sleep or poll workers by default. Recurso worker messages wake the parent.
- Poll or peek only when there is a concrete reason: diagnosis, progress audit,
  time-sensitive coordination, or a worker question that needs more context.
- After spawning workers, continue useful parent work or stop and wait for their queued messages.
- Let workers report with `recurso_message_thread` using `question`, `progress`, or `done`.
- Use `recurso_peek_thread` when a worker asks a question and you need context.
- Integrate worker reports in the parent thread before deciding next steps.
- When a worker is obsolete or harmful, use `recurso_abort_thread`.

## Worker Prompt Shape

Give each worker:

- A bounded objective.
- Read and write scope.
- Expected deliverable.
- Constraints and coordination risks.
- Instruction to report `question`, `progress`, or `done` to `target: "parent"`.

## Completion Handling

When a worker reports `done`, review the result before treating the work as
complete. If more work is needed, either message the same live thread or fork
from that thread with a continuation task.

## Wake-Up Contract

Workers that send `question` or `done` to `target: "parent"` should stop after
that tool call. The parent can wake an idle worker later by sending
`recurso_message_thread` to its thread id. Use `followUp` by default and
`steer` only when the worker is actively heading in the wrong direction.
