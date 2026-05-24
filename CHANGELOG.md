# Changelog

## 1.1.4 - 2026-05-24

Native message delivery reliability release.

- Fixed parent delivery for child `recurso_message_thread` calls by awaiting
  Pi's async `sendUserMessage` API before treating supervisor routing as done.
- Delivery failures are now recorded on the child thread snapshot instead of
  being silently swallowed by an unhandled async rejection.

## 1.1.3 - 2026-05-24

Orchestration guidance release.

- Tightened skill and tool guidance so parent agents stop waiting on workers
  instead of repeatedly peeking at them.
- Reframed `recurso_peek_thread` as a debugging/context tool, not a normal
  waiting loop.

## 1.1.2 - 2026-05-24

Worker lifetime release.

- Recurso no longer terminates spawned workers just because the parent Pi
  session shuts down. Use `recurso-stop-all` for explicit cleanup.
- Added `RECURSO_SHUTDOWN_BEHAVIOR=terminate` for users who prefer the previous
  parent-session-scoped cleanup behavior.

## 1.1.1 - 2026-05-24

VS Code history and thinking-control release.

- Added explicit `thinking` overrides for new and forked Recurso threads.
- Spawned threads now inherit the parent Pi session history directory by default
  so VS Code history can show them beside the creating session.
- Added a session cache report helper for inspecting provider cache usage.

## 1.1.0 - 2026-05-24

Provider cache exploration release.

- Added an experimental OpenAI cache-lineage hook gated by `RECURSO_OPENAI_CACHE_LINEAGE=1`.
- Added provider-cache probe ordering modes for fork-first, parent-first, and idle-fork-parent-first workflows.
- Documented current provider cache behavior for Anthropic, OpenAI, OpenRouter/DeepSeek, and Gemini.
- Added provider cache probe env examples for OpenRouter, DeepSeek, OpenAI, Gemini, Anthropic, Vertex, and Bedrock.
- Confirmed Anthropic is currently the strongest provider path for Recurso's stop/wake worker pattern.

## 1.0.0 - 2026-05-24

First stable public release.

- Added live Pi RPC thread creation, forking, messaging, peeking, listing, and aborting.
- Added event-driven stop/wake behavior for `question` and `done` messages to a spawning thread.
- Added direct sibling messaging through supervising Recurso managers.
- Added recursive thread support with a default depth cap and run-tree parallelism cap.
- Made Pi's normal session history the default for spawned Recurso threads.
- Added isolated and custom session storage through `RECURSO_SESSION_DIR`.
- Added run snapshots under `.pi/recurso/runs/` and descendant-aware thread listing.
- Added `/skill:recurso`, `/skill:recurso-orchestrator`, and `/skill:recurso-worker`.
- Added v1 schema metadata in tool details and registry snapshots.
- Added examples, security guidance, and a smoke-test harness.
