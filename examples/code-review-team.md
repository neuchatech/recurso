# Code Review Team

```text
Use /skill:recurso.

Review the current changes with a small Recurso team.

Create three focused threads:

1. Correctness Reviewer
   - Inspect logic bugs, edge cases, and behavioral regressions.
   - Report only concrete findings with file paths and why they matter.

2. Test Reviewer
   - Inspect test coverage and verification gaps.
   - Suggest the smallest useful checks.

3. Integration Reviewer
   - Inspect API boundaries, compatibility, docs, and release risk.

Do not poll by default. Ask each thread to report `done` to `parent`. If a
reviewer finds an issue that changes another reviewer's direction, have it send
a `progress` message directly to that reviewer by thread id.

When the reports arrive, synthesize one code review with findings first,
ordered by severity, then open questions and residual risks.
```
