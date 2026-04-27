# Ingest invariants

Rules the ingest pipeline depends on to keep retrieval coherent as the corpus
grows. Read this before touching `chunker.py`, `embed.py`, `normalize.py`, or
the `--incremental` path in `main.py`.

## Why this matters

Adding new episodes to pgvector + tsvector does not, by itself, degrade
similarity scores for existing chunks — cosine distance and rerank-2 scores
are pairwise and corpus-independent. But retrieval quality *can* drift
through second-order effects if the ingestion pipeline is inconsistent
across runs:

- **Semantic crowding**: recurring topics produce near-duplicate top-K
  results that squeeze out diverse perspectives. Fix in retrieval (MMR or
  per-episode caps before rerank), not ingestion.
- **Chunk-strategy drift**: old chunks sized/bounded differently than new
  ones — retrieval behaves inconsistently for similar queries.
- **Embedding model drift**: vectors from different models live in
  different spaces; mixing them silently breaks ANN search.
- **Normalizer drift**: stale substitutions mean old chunks embed and
  index different text than the raw turns would today.
- **Eval drift**: a fixed eval set from early ingestion becomes less
  representative as the corpus grows.

## What the pipeline already guarantees

- **Per-episode replace-in-place**: `replace_turns` and `replace_chunks`
  (in `upsert.py`) `DELETE` then `INSERT`. Re-ingesting an episode rebuilds
  all of its turns and chunks atomically — no within-episode mixing of old
  and new chunk strategies.
- **Canonical speakers in chunk text**: `SpeakerCache` resolves raw labels
  to canonical names before embedding. "John Smith" in episode A and
  "J. Smith" in episode B both embed as `John Smith: ...`.
- **Preamble context per chunk**: every chunk text starts with
  `[Show:...][Title:...][Date:...][Section:...]` so embeddings carry
  episode context, not just local turn text.
- **mtime-based incremental skip**: `_already_ingested` compares file
  mtime to `episodes.ingested_at` — cheap `--incremental` runs.

## What the pipeline does NOT guarantee

These are the drift vectors. Each one needs either a guard or operator
discipline.

### 1. Chunking parameter drift

`chunker.py` hardcodes `TARGET_TOKENS = 600`, `MAX_TOKENS = 900`. If these
(or any logic in `build_chunks`) change and you run `--incremental`, new
episodes chunk at the new settings while existing chunks stay on the old
settings. The `chunks` table has no version column, so the mix is
undetectable after the fact.

**Rule**: any change to `chunker.py` requires a full re-chunk:
`python -m main --full`. Do not ship chunker changes via `--incremental`.

**Future guard**: add a `chunking_version` column on `chunks` and compare
to a constant in `chunker.py`; fail `--incremental` on mismatch.

### 2. Embedding model drift

`embed.py` hardcodes `MODEL = "voyage-3-large"`. Upgrading the model
without a full re-embed mixes two vector spaces in one ANN index, which
degrades silently (no errors, just worse neighbors). The `chunks` table
has no `embedding_model` column.

**Rule**: any change to `MODEL` requires a full re-embed:
`python -m main --full`. Never run `--incremental` across a model change.

**Future guard**: add an `embedding_model` column on `chunks`; fail
`--incremental` if the column value differs from the current `MODEL`.

### 3. Normalizer / knowledge-base drift

`Normalizer` is built from `knowledge_base.json`. If aliases or
substitutions change, old chunks retain the prior normalized text in
`turns.text`, `chunks.text`, and the embedding — until those episodes are
re-ingested. `_already_ingested` will not detect this.

**Rule**: after any material change to `knowledge_base.json` or
`normalize.py`, run `python -m main --full`.

**Future guard**: hash the KB (or normalize config) and store the hash
per episode; `--incremental` re-ingests episodes whose hash is stale.

### 4. mtime-only staleness check

`_already_ingested` compares file mtime to `episodes.ingested_at`. Code
changes to `chunker.py`, `normalize.py`, or `embed.py` do NOT bump
`mtime`, so `--incremental` silently skips episodes that would produce
different output today.

**Rule**: treat `--incremental` as safe only when the code has not
changed since the last run. If you touched the pipeline, use `--full`.

**Future guard**: combine mtime with the chunking/embedding/normalizer
version hashes described above.

### 5. Eval coverage drift

A fixed eval set constructed early becomes less representative as the
corpus grows. Aggregate questions in particular (topGuests, per-show
counts) shift as new episodes land.

**Rule**: when a batch of episodes lands, add at least one eval case
that could only be answered correctly using the new content.

## Operator quick-reference

| Change you made                    | Required ingest command |
|------------------------------------|-------------------------|
| Added transcripts, nothing else    | `python -m main --incremental` |
| Edited `chunker.py`                | `python -m main --full` |
| Bumped `MODEL` in `embed.py`       | `python -m main --full` |
| Edited `normalize.py` or KB        | `python -m main --full` |
| Fixed one episode's transcript     | `python -m main --episode <id>` |

## Related retrieval-side risks (not ingest invariants)

Recording here so they don't get lost, but these live in `lib/` and the
API routes, not ingest:

- **Semantic crowding / duplicate top-K**: mitigate with MMR or a
  per-episode cap applied before reranking.
- **tsvector IDF shift**: BM25 scores for borderline queries drift as
  corpus grows. Usually small; monitor via eval.
