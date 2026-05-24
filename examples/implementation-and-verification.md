# Implementation And Verification

```text
Use /skill:recurso.

Implement <feature> with one Recurso implementation thread and one verification
thread.

Implementation thread:
- Owns only <files/modules>.
- Must not edit outside scope without asking.
- Reports files changed and commands run.

Verification thread:
- Starts read-only.
- Watches for the implementation report.
- Runs or recommends the smallest meaningful checks.
- Sends direct progress to the implementation thread if it finds a blocker.

The parent thread keeps product decisions and cross-file architecture decisions.
Do not poll by default; let `question` and `done` messages wake the parent.
```
