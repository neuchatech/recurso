# Research Swarm

```text
Use /skill:recurso.

Research <topic> with independent Recurso threads.

Create one thread for primary sources, one for implementation examples, and one
for risks or counterarguments. Each thread should return links, dates, confidence,
and uncertainty. Use `progress` only for discoveries that should redirect another
thread. Otherwise report `done` to `parent`.

Do not sleep or poll by default. Let thread messages wake you. When enough
reports arrive, reconcile contradictions and give a recommendation with sources.
```
