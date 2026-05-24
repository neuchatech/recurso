# Changelog

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
