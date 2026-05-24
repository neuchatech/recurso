---
name: recurso-orchestrator
description: Coordinate work with Recurso live Pi threads using RPC-backed create, fork, message, inspect, and abort tools.
---

# Recurso Orchestrator

Use Recurso when independent work can make progress without constant attention
from the current thread.

This is a coordination role, not a special type of Recurso thread. Every
Recurso thread can create, fork, and message other threads.

## Tools

- `recurso_new_thread`: start a fresh thread without parent conversation context.
- `recurso_fork_thread`: fork the current session, or an existing Recurso thread.
- `recurso_message_thread`: send a follow-up or steering message to a thread.
- `recurso_peek_thread`: inspect a thread for debugging or after a received message needs more context.
- `recurso_list_threads`: check live thread inventory.
- `recurso_abort_thread`: abort a turn or terminate a thread.

## Operating Rules

- Fork only work with a clear deliverable.
- Keep fan-out purposeful. Recurso's default runtime cap is 10 live threads in one run tree.
- Spawned threads inherit the current provider, model, and thinking level unless
  a tool call supplies `provider`, `model`, or `thinking`.
- Keep most workers on low or medium thinking, and explicitly raise thinking
  only for hard architecture, debugging, or synthesis tasks.
- Default messages to `deliver_as: "followUp"`.
- Use `deliver_as: "steer"` only for urgent correction, safety, or blocker handling.
- Do not sleep or poll threads by default. Recurso messages wake the receiving thread.
- After spawning threads, continue useful local work or stop and wait for their
  queued messages. Do not repeatedly peek just to see if workers are done.
- Use `recurso_peek_thread` only for debugging, suspected malfunction, or when a
  received thread message needs more context.
- Let threads report with `recurso_message_thread` using `question`, `progress`, or `done`.
- Use `recurso_peek_thread` only when a thread asks a question and you need context.
- Integrate thread reports before deciding next steps.
- When a thread is obsolete or harmful, use `recurso_abort_thread`.

## Thread Prompt Shape

Give each spawned thread:

- A bounded objective.
- Read and write scope.
- Expected deliverable.
- Constraints and coordination risks.
- Instruction to report `question`, `progress`, or `done` to `target: "parent"` unless another target is more precise.

## Completion Handling

When a thread reports `done`, review the result before treating the work as
complete. If more work is needed, either message the same live thread or fork
from that thread with a continuation task.

## Wake-Up Contract

Threads that send `question` or `done` to `target: "parent"` should stop after
that tool call. The spawning thread can wake an idle thread later by sending
`recurso_message_thread` to its thread id. Use `followUp` by default and
`steer` only when a thread is actively heading in the wrong direction.
