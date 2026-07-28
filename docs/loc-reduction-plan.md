# LOC reduction plan — surface area, not line golf

A staged plan to cut ~3,100 lines (~10% of source) without changing behavior. The goal is fewer places for bugs to hide, not a smaller number for its own sake — so this document is as much about **what must not be touched** as what should be.

Produced by a five-agent review sweep over `app/`, `components/`, `lib/`, `eval/`, `scripts/`, and `ingest/`. Every "dead code" claim was verified by repo-wide grep with a positive control, not by import graph alone.

**Status:** Wave 1 shipped (PR #6). Wave 2 shipped. Wave 3 remains — but see
[Wave 2 outcome](#wave-2--mechanical-dedup-shipped) before trusting its numbers:
the tail of Wave 2 came in at about a tenth of its estimate, for reasons that
apply to Wave 3 too.

---

## Baseline

Measured 2026-07-28, before Wave 1:

| Area | LOC |
|---|---|
| `lib/` | 16,412 |
| `app/` | 8,772 |
| `components/` | 3,202 |
| `ingest/` (Python) | 1,983 |
| `eval/` + `scripts/` | 1,346 |
| **Total source** | **31,715** |
| Test suite (36 files) | 6,266 |

Composition of the ~3,100 identified: **~1,000 lines dead code**, **~2,100 deduplication/compression**. The big files mostly stay big — `retrieval.ts` 956 → ~770, `eval/grade.ts` 1107 → ~1068. Their bulk is prompts, tool descriptions, and non-repeating logic, not redundancy.

---

## Wave 1 — Dead code ✅ shipped

`−1,003` lines of source (31,715 → 30,712). No behavior change, no coverage lost.

- **`lib/orchestrator/types.ts`** (−565 with its test) — the document-flow half (`OrchestratorRun`, `ExtractedStory`, `NarrativeArc`, `DistillResult`, `RefineEntry`, `OrchestratorStage`, `ExtractedSource` + five pure helpers), orphaned when `eda5b3e` replaced the multi-route orchestrator with the scriptwriter subsystem. All 31 tests in `types.test.ts` covered only deleted functions.
- **`lib/retrieval.ts`** (−157) — `countAppearances`, `getEpisode`.
- **`lib/transcript-href.ts`** + test (−70) — production-dead.
- **Dead `inputRef` + focus effect** in news/chat/prep pages (−39).
- **Smaller** (−90) — `refineScript`, `isInternationalSource`, `internationalHostnames`, `chatExists`, `isPrepShowId`, three unused types in `news-types.ts`, `embed_query`, no-op `sys.path.insert` ×2.

Also added `.github/workflows/web-tests.yml`. **Before this, the TypeScript suite had no CI at all** — the only workflow was `ingest-tests.yml`, path-filtered to `ingest/**`. It now runs lint, typecheck, vitest, and build on every push and PR.

Two latent breakages fixed en route: `ingest/pyproject.toml` listed `py-modules = [… "chunk" …]` (the file is `chunker.py`) and omitted four modules, so `pip install -e ingest/` failed; and it depended on `anthropic`, which no ingest module imports.

### Lessons that shaped the remaining waves

- `countAppearances` *read* as live: grep hits a `'countAppearances'` fixture discriminant in `eval/grade.ts` and a distinct `countAppearancesTool` in the chat route. Neither invokes it. **Grep for the identifier, then read every hit.**
- `TopicWithSources.block`/`.transition` look like document-flow leftovers but are read at `lib/orchestrator/script-craft.ts:45-47`. They stayed. **Check field-level liveness, not just the type.**
- Deleting `extractedStoryToTopic` orphaned an explanatory comment in `eval/grade.ts` that named it. **Grep comments too.**

---

## Wave 2 — Mechanical dedup ✅ shipped

Items 1–3 landed first (−607). Items 4–7 were estimated at −535 and delivered
**−68 source / +28 test**. The estimate was wrong; the detail is below, because
the same failure modes are priced into Wave 3.

1. **`lib/upload-parts.ts`** (−81 net) ✅ — `prep/route.ts` and `news/route.ts` were logic-identical; only comment lines differed.
2. **Four `components/ui/` primitives** (−136) ✅ — `TypingDots` (3 byte-identical copies), `ToolChip`, `BusyRow`, `UserBubble`.
3. **Test-suite structural dedup** (−390) ✅ — page-test `attachFiles` helper; `source-gathering.test.ts` fixture factory; `breaking-scan.test.ts` stub hoist.
4. **Table-driven test conversions** — est. −400, **actual −129**. Converted `ChatErrorBanner` (80→58), `citation-parser` (113→83), `style-memory` (176→131), `news-sources` (85→49). The −400 assumed lots of single-assertion `it()` blocks; a count of single-`expect` blocks per file showed most test files already group related assertions under one descriptive `it()`, which is *fewer* lines than the equivalent table. `lib/scriptwriter/sourcing.test.ts` was converted, measured at **+9 lines**, and reverted — its inputs are long enough that each row costs more than the `it()` it replaced.
5. **`warnEvent()` / `logEvent()`** — est. −50, **actual −65 source / +62 test**. Found 57 sites, not 22. Call sites shrank by 110; `lib/log-event.ts` (44) and its test (62) add back. The estimate didn't budget for testing the new helper.
6. **Shared retrieval projection fragments** — est. −14, **actual +10 source / +95 test**. Five copies became two fragment definitions, but with real explanatory comments the definitions cost more than the duplication did. Kept anyway: this was always a correctness item, and `lib/retrieval-sql.test.ts` is the first unit test over any SQL in `retrieval.ts` — see item 10.
7. **Misc** — est. −71, **actual −13**. `DISCOVERY_QUERIES` → `lib/news-sources.ts` ✅; `eval/grade.ts` bucket registry ✅; `router.ts` twin resolvers ✅; `todayISO` ✅ (3 copies, not 2 — the orchestrator page had the original). `streamTextAccumulate` **does not exist in the repo** — the item was fiction. Prompt fragments: the only cross-file duplicates are single lines inside larger prose blocks (see Rejected abstractions).

### What this says about Wave 3's numbers

Three biases showed up, all pushing the same way:

- **Comments and tests aren't free.** Items 5 and 6 both produced a real structural win and a *worse* LOC number, because the extracted thing deserved a comment explaining why it exists and a test pinning it. Any Wave 3 item that ends "…and write a test first" should be assumed LOC-neutral at best.
- **Duplication was over-counted from grep.** Item 4's −400 came from a per-file line count, not from counting the blocks that would actually collapse. Measure the collapsible unit, not the file.
- **One item didn't exist.** Grep for the identifier before pricing the work — the Wave 1 lesson applies to additions, not just deletions.

Wave 3's -1,000 should be read as an upper bound on *deleted* lines, not on net change. Items 8 and 9 (−496 combined) both explicitly require new tests first.

---

## Wave 3 — Structural (~1,000 lines, MEDIUM risk)

8. **`prepareChatRoute()`** (−155) — the single largest structural win. The same 12-step preamble runs in `chat`/`prep`/`news`/`orchestrator-chat`. Never touches `streamText` or the stream writer.

   Normalizes a real divergence: the first three call `req.json()` unwrapped, so a malformed body throws an unhandled 500; `orchestrator/chat:99` wraps it and returns 400. Adopt the 400.

   ⚠️ Error *shapes* must be preserved byte-for-byte — `ChatErrorBanner` parses `[<status> <statusText>] <body>` out of the thrown fetch error via `lib/chat-fetch.ts`.

   ⚠️ **These four routes have zero tests.** Write a preamble test first (~120 lines) against the `app/api/chats/[id]/summary/route.test.ts` mocking pattern — that converts this item from MEDIUM to LOW.

9. **Focused UI hooks** (−341) — six small hooks, deliberately **not** one mega-hook: `useInitialMessages` (−36), `useMessageEditing` (−68), `useEditingFetch` (−25), `useFileAttachments` (−59), `useDriveSave` (−72), plus `CopyButton`/`HandoffButton` (−52) and a `useMemo` replacing a state+effect mirror (−10).

   Start with `useFileAttachments` — the only one with real test coverage on both pages. It also fixes a genuine stale-closure bug: `news/[id]/page.tsx` `onPickFiles` has dep array `[files]` but calls `flashFileAttachSuccess` (currently an eslint warning).

   Write a test for `useMessageEditing` **before** touching it — it owns a global `keydown` listener and nothing guards it today.

10. **Shared corpus scope filter in `retrieval.ts`** (−15) — small LOC, real correctness win: five copies of a five-predicate filter that must stay in lockstep across vector search, keyword search, and three dossier queries.

    ⚠️ Still the highest-risk item, but less so than when this was written. Gate on `BUCKET=lookup`, `BUCKET=dossier`, `BUCKET=aggregate` before *and* after — a regression is silent recall loss, not an exception. The vector query needs a `WHERE TRUE` anchor (its filter currently opens the `WHERE`; the shared fragment is additive).

    Composition is now verified rather than assumed. `toParameterizedQuery` recurses into nested `sql\`…\`` fragments and renumbers `$n` against the outer param array — confirmed by reading the driver source, and `lib/retrieval-sql.test.ts` pins it, including that numbering stays sequential across an interpolated fragment. `sql\`…\`` is also lazy (it only executes on `.then`/`.catch`/`.finally`), so module-level fragments are safe and testable without a database. Never concatenate values into SQL.

    Wave 2 item 6 also established the technique for proving a SQL edit is neutral: expand the fragment references back out and diff every template against `HEAD` with whitespace collapsed. That caught nothing, but it is what makes "no behaviour change" a checked claim instead of an assertion.

11. **`lib/show-lookup.ts`** (−48) — four implementations of one query shape (2 in the chat route, 2 in `eval/grade.ts`). ⚠️ The `note` strings are fed to the model as tool-error text; reproduce byte-for-byte or disambiguation behavior shifts.
12. **Remaining route helpers** (−85) — `csrfGuard`/`clientIp`/`rateGuard`, telemetry `onFinish`, assistant-persist `onFinish`, `cachedSystem()`, chunk/turn serializers, `makeWebSearchTool` factory, `jsonBody()`, prep's stream shell → `toUIMessageStreamResponse`.
13. **Python `ingest/`** (−160) — `SpeakerRow.from_row` + `_SPEAKER_SELECT` (−35); two `bootstrap.py` helpers (−30); `normalize.py` three parallel structures → one (−15); `test_parse.py` fixture helper (−13); verbosity cleanups (−31); shared `_conn_str` (−15).

    ⚠️ Tests are stdlib `unittest`, not pytest, and CI has no `pip install` step — use `unittest.subTest`, **not** `pytest.mark.parametrize`.

---

## Free fixes still outstanding

Found during review; none are LOC wins.

- **`lib/tool-cache.ts:13` `ensureTable()` is not memoized**, while `lib/chats.ts:57` `ensureChatTables` is — with a comment stating exactly why ("Without this each chat POST would round-trip 4 IF-NOT-EXISTS statements to Neon over HTTP"). Same reasoning applies; one file was missed. Costs 2 extra Neon HTTP round-trips per chat/prep/news request.
- **~14 JSX sites use `&&` instead of ternaries**, against the project rule. Two have real falsy-render potential: `EmptyState.tsx:43`, `TokenUsageIndicator.tsx:48`.
- **`chat/[id]/page.tsx:111`** builds `DefaultChatTransport` inline in `useChat` options — a fresh transport every render. The other three pages `useMemo` it with a comment explaining why.
- **`lib/chats.test.ts:100`** — `expect(result.newCount).toEqual({ newCount: 0 }.newCount)` → `toBe(0)`.
- **`vitest.config.ts:9`** sets `environment: 'jsdom'` globally, so ~30 pure-logic test files pay jsdom startup. An `environmentMatchGlobs` for the two `.tsx` files cuts suite runtime. 0 LOC.

---

## DO NOT TOUCH

Each of these looks duplicated or over-complicated and must stay as it is. Each is a fixed bug with a commit behind it.

1. **`discoverCandidates` (allowlist) vs `discoverOpenWeb` (open web)** — same shape, opposite policy. The allowlist is load-bearing for the breaking scan's tier-1 corroboration; its *absence* is load-bearing for the scriptwriter's per-source credibility judgment (`SELECTOR_SYSTEM`: "there is NO outlet allowlist"). `eda5b3e`, `b866d23`.

   → Note: **`orchestrator/source-gathering.ts` and `scriptwriter/sourcing.ts` do not duplicate each other.** `sourcing.ts:11-18` already imports six functions from it. The Tavily/cache/translation/paywall machinery lives in one place today.

2. **`reviewBlock` vs `reflectLoop`** — diverged deliberately. `cd878b6` made `reviewBlock` a single gated pass with soft-note withholding; `77e2dcc` gave `reflectLoop` up to three passes with best-candidate scoring and a `blockSignature` guard. Unifying re-introduces one bug or the other.
3. **The two branches of `sourceBlockFor`** (`reflect.ts:91-102`) — reads like near-duplicate prose; *is* the entire fix from `77e2dcc`. A self-reported source list must not license hard source-fidelity failures.
4. **The three exit paths in `discoverXPosts`'s retry loop** (`source-gathering.ts:413-448`) — the "empty answer → return without retrying" branch is `b3c1d94`. Retrying cost three grounded searches and blew the 300s route ceiling. Do not simplify to "retry while empty".
5. **`filterByCutoff` called twice with different `dropUndated`** (`breaking-scan.ts:355`, `:365`) — fail-closed date handling from `fd80835`. Pre-extraction a candidate may legitimately lack a date; post-extraction a still-undated story is unprovable. One pass cannot express both.
6. **`toDay` vs `toIsoDate`** — for a timestamp with a negative UTC offset these return **different days**. `toDay` feeds the lock-time cutoff. Do not fold together.
7. **`mapSelection`'s slot override** (`sourcing.ts:313-321`) — `32372a3` + `a9bfc3b`. Trusting the model's `blockSlot` lets a `blocks: [B]` run hold an A-slotted story.
8. **`digestSource`'s `oneLine()` sanitization** (`prompts.ts:158-180`) — a newline-laden title can forge a `[N] source — title` pool boundary and desync index mapping.
9. **`getDossier`'s separate `COUNT(*)` query** — folding into `COUNT(*) OVER ()` saves 13 lines and a round-trip but forces the planner to materialize the full filtered rowset. That's the path used for hosts with 10K+ turns.
10. **`expandQueryWithKnownNames` feeds FTS only, never vector search** — the asymmetry is deliberate. `rrf(k=60)` and the `Math.max(finalK*3, 20)` rerank pool are tuned constants.
11. **`newsSystemPrompt()`'s SHA-256 is pinned** by `lib/news-prompt-identity.test.ts` to protect the Anthropic prompt cache. Do not "tidy" the assembler.
12. **`news-prompt.ts` and `prep-prompt.ts` share zero non-trivial lines** — diffed. Unrelated prompts that merely share a shape.
13. **Comment density in `source-gathering.ts` / `breaking-scan.ts` (~40%)** — encodes why `days` beats `start_date`, why extraction failures are dropped. Removing scores well on LOC and is a net loss.
14. **`streamText` provider options** — `block-craft.ts:21` sets `thinking: adaptive` with *no* temperature (Opus 4.8 400s on sampling params). Any shared helper must pass these through verbatim and must not add a default temperature.

---

## Rejected abstractions

Considered and argued down. Recorded so they don't get re-proposed.

- **`useChatPage()` mega-hook** — would return ~25 values and take ~8 options; every future per-surface tweak becomes a boolean flag. Six focused hooks get the same LOC without the coupling.
- **`<ChatShell>`** — the four outer layouts genuinely differ; needs ≥7 slots and runs longer than what it replaces.
- **Per-page `part.type` switches** — look parallel, but a table-driven renderer moves the same lines into config of the same length while destroying the type narrowing that `part.type === 'tool-lookupCorpus'` gives on `part.output`. Net ≈ 0, type safety worse.
- **Moving CSRF into `proxy.ts`** — bigger win (−75) but breaks the one existing route test and makes a security control depend on the proxy matcher.
- **Unifying the three `searchCorpus`-family tools** — differ in filters, `finalK`, and response shape; a factory needs 5 options to save ~40 lines.
- **Sharing `buildFactCheckTools` between eval and the news route** — changes what the model sees inside a *behavioral eval*, moving pass rates for reasons unrelated to the code under test.
- **Merging `NewsSource` with `Source`** — forces `episode_id`/`excerpt`/`show` nullable everywhere and infects `SourcePanel`, `Citation`, `citation-label.ts`.
- **Merging `ModelSelector`/`ShowSelector`/`TemperatureSelector`** — 6 props to save ~45 lines; the item bodies resist a common shape.
- **Extracting `parse.py`'s duplicated `flush()`** — costs ~14 lines to save 10. LOC-negative.
- **Table-driving `review.py`'s argparse subparsers** — idiomatic as-is; a data-driven rewrite is materially less readable.
- **Table-driving `lib/scriptwriter/sourcing.test.ts`** — tried and measured: 273 → 283 lines. `extractUrls` / `slotsForUrlStories` / `topicTextWithoutUrls` take long string inputs, so each row wraps across 5–7 lines where the original `it()` fit in 3. Same applies to any test whose inputs don't fit on one line.
- **Table-driving `citation-label`, `sidebar`, `dossier-budget`, `strip-tool-outputs`, `rss`** — already compact. The first three group several related assertions under one descriptive `it()`; the last two build a distinct fixture per case, and the fixture (XML, message trees) dominates the line count, not the wrapper.
- **Extracting the duplicated prompt lines** — the only cross-file duplicates are single lines *inside* larger prose blocks (`prep-prompt.ts` ×2, `news-prompt.ts` ×2). Hoisting them to consts and interpolating saves ~4 lines, makes the prompts unreadable as prose, and puts the pinned `newsSystemPrompt()` hash at risk for nothing.

---

## Open decisions

1. **`lib/news-sources.ts` editorial arrays (−45)** — `englishSites`, `hebrewSites`, `analysisAndThinkTanks` have no programmatic reader; only `xAccounts` is consumed. The news prompt tells the model to "prioritize the outlets in `lib/news-sources.ts`", but the model never sees the file. Delete, or move to `docs/`? This is an editorial artifact — ask the desk, not the compiler.
2. **News `TypingDots` visual variant** — `news/[id]/page.tsx` has a variant of the shared dots (different flex, color, and stagger). Unify (small visible UX change) or keep the divergence deliberately?

---

## Working notes

- Verify a green baseline before and after every wave: `pnpm typecheck`, `pnpm lint`, `pnpm vitest run`, and `python -m unittest discover -s tests` from `ingest/`. Run `pnpm build` too when a client component is touched — the test suite does not catch a broken import in a page.
- Reconcile test counts explicitly. Wave 1 went 476 → 439, and the 37 removed reconciled exactly as 31 + 4 + 2, every one covering a deleted subject. An unexplained delta means coverage was lost. Wave 2 went 440 → 471; the +31 reconciles as 8 (new SQL-fragment tests) + 11 (new log-event tests) + 12 (table rows split out of cases that had shared one `it()`).
- Measure before committing to a dedup, and revert when the measurement disagrees. Two Wave 2 items looked like clear wins and were not; one was caught only by converting it and running `wc -l`.
- `ingest/` has no `pip install` step in CI and only `parse.py` is under test — import-check any module you touch against the venv directly.
