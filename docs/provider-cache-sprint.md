# Recurso V2 Provider Cache Sprint

## Goal

Determine whether Recurso can preserve provider-side prompt/cache warmth across Pi forks, and identify what Pi/provider changes would be required for cache-friendly branching.

Recurso V1 guarantees logical context preservation. V2 should explore whether some providers can also preserve cached compute, or whether Recurso should offer provider-specific continuation, branch, or cache-seeding strategies.

## Working Hypothesis

Provider cache survival after a fork is not a generic capability. It depends on each provider's cache key:

- Content-prefix caches may survive if the fork sends an identical cached prefix.
- Session-affinity or conversation-scoped caches may not survive because Pi forks create a new session id.
- Explicit cache resources may survive if the fork references the same resource.
- Provider conversation-state APIs may support fork-like branching, but Pi may need provider-specific changes to use them.

## Provider Matrix

| Provider path | Feature to test | Expected fork behavior | Status |
| --- | --- | --- | --- |
| OpenRouter + DS4 Pro pinned to DeepSeek | OpenRouter/DeepSeek cache via `openrouter-deepseek` provider | Mixed local results. Same-session continuation hits cache; fork missed in an early manual trial but hit in the unique-label probe. Needs repeated trials and request metadata capture. | In progress |
| DeepSeek direct | Direct DeepSeek context caching | Promising. Official cache is prefix/content based, so Pi forks may hit without Pi changes if the prefix unit has settled. Needs live probe. | Researched |
| OpenAI direct | Prompt caching, `prompt_cache_key`, Responses `previous_response_id` | Likely cache-hostile today because Pi uses the fork's new session id as `prompt_cache_key`. V2 could preserve a cache-lineage key across forks. Needs live probe. | Researched |
| Gemini direct | Implicit caching, explicit cached content, thought signatures | Implicit prefix caching may work today. Explicit cached content needs Pi provider changes. Thought signatures are reasoning continuity, not cache economics. Needs live probe. | Researched |
| Anthropic direct | Explicit `cache_control` breakpoints | Out of initial scope unless keys are available. Likely prefix/breakpoint dependent, not fork-aware. | Backlog |

## Definition Of Done

1. A repeatable probe script can seed a parent Pi session, continue it, fork it, and report `usage.cacheRead` / `usage.cacheWrite`.
2. Provider-specific notes explain the documented cache key or conversation mechanism.
3. The sprint report classifies each provider as:
   - `preserves-cache`
   - `can-preserve-with-pi-changes`
   - `logical-only`
   - `unknown`
4. Proposed Pi/Recurso V2 changes are listed with risks and required upstream/provider work.

## Test Protocol

For each provider/model:

1. Use an isolated `--session-dir`.
2. Use a stable `--system-prompt`.
3. Disable tools with `--no-tools` unless the provider path requires them.
4. Seed a parent session with a long stable corpus.
5. Run a same-session continuation and record usage.
6. Fork the original parent session and record usage.
7. Repeat with fork-first ordering to avoid confusing parent continuation with cache mutation.
8. Save raw JSONL output outside the repo by default; commit only summarized results.

## Current Local Results

OpenRouter DS4 Pro pinned to DeepSeek produced two different shapes in local trials.

Manual fork-first trial:

```text
parent seed:
  input: 9938
  cacheRead: 0

fork as first continuation:
  input: 9961
  cacheRead: 0

same parent session continuation:
  input: 105
  cacheRead: 9856
```

Reusable probe with a unique run label:

```text
parent seed:
  cacheRead: 0

fork as first continuation:
  input: 33
  cacheRead: 11520

same parent session continuation:
  input: 33
  cacheRead: 11520
```

Updated conclusion: OpenRouter DS4 fork-cache behavior is not settled by a single run. V2 should run repeated trials and capture request-shaping details, including cache key/session id, provider routing payload, system prompt shape, ordering, timing, and raw usage fields.

## Workstreams

- OpenRouter: verify pinned DS4 behavior, document exact Pi/OpenRouter request characteristics, and identify whether `provider.only`, session id, or OpenRouter conversation identity is the likely cache key.
- DeepSeek direct: test direct provider with `DEEPSEEK_API_KEY`, compare same-session and fork behavior, document DeepSeek cache docs.
- OpenAI direct: test Chat Completions/Responses as available, inspect whether `prompt_cache_key` or `previous_response_id` can be used to support branch cache.
- Gemini direct: test implicit cache and investigate explicit cached content; determine whether Pi provider can attach reusable cached content to forked threads.

## Possible V2 Directions

- Document provider cache behavior and expose `recurso_cache_profile` diagnostics.
- Add a `continue_thread` preference for cache-sensitive work, nudging agents away from unnecessary forks.
- Split logical Pi session identity from provider cache lineage identity. For OpenAI, this likely means preserving a `prompt_cache_key` lineage across forks instead of using each fork's new Pi session id.
- Add provider-specific session/cache-key reuse for forks where safe.
- Add explicit static-context cache resources for providers that support them.
- Fork or patch Pi provider implementations where branching requires provider-specific API support.

## Provider Research Notes

### OpenRouter

OpenRouter documents automatic provider prompt caching for DeepSeek and reports hits through OpenAI-compatible usage fields such as `prompt_tokens_details.cached_tokens`. It also documents sticky routing by account, model, and conversation, where conversation identity is based on early request content. Manual provider routing can interact with sticky routing, so the DS4 pin extension should be treated as part of the test surface.

Local results are mixed. The first manual fork-first trial missed cache on the fork while the parent continuation hit. The reusable unique-label probe later showed both fork and parent continuation hitting. The next sprint step is repeated OpenRouter trials with raw request metadata capture.

### DeepSeek Direct

Direct DeepSeek is the most promising no-Pi-patch path. Its official cache is enabled by default and is based on overlapping request prefixes, not a documented conversation id. Cache construction is best-effort and can take seconds, so probes should support repeated trials and an optional settle delay.

Recommended probe:

```bash
DEEPSEEK_API_KEY=... node scripts/provider-cache-probe.mjs \
  --provider deepseek \
  --model deepseek-v4-pro \
  --thinking high \
  --corpus-lines 800 \
  --keep
```

### OpenAI Direct

OpenAI prompt caching is prefix based and reports hits as cached tokens, but Pi's OpenAI Responses provider uses `options.sessionId` as `prompt_cache_key`. Since Pi forks create a new session id, current forks are likely cache-hostile even though they preserve the logical transcript. A V2 Pi patch should test a separate `cacheLineageId` that forks can inherit.

`previous_response_id` is worth a separate experiment as a branch-like conversation-state primitive, but it is not documented as cache cloning and may require different storage/privacy assumptions.

### Gemini Direct

Gemini has implicit prefix caching and explicit named cached content. Pi already maps Gemini `cachedContentTokenCount` to `usage.cacheRead`, so implicit fork hits are measurable with the probe. Pi does not currently create or pass explicit cached content resources, so explicit cache-friendly forks would require provider changes. Pi does preserve Gemini thought signatures for same provider/model replay, but that is reasoning continuity rather than token-cache preservation.
