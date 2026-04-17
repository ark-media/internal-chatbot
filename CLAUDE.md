@AGENTS.md

# Ark Internal Chatbot

Internal RAG chatbot over Ark Media podcast transcripts. Full architecture and plan: `~/.claude/plans/calm-inventing-brook.md`.

## Stack (current-as-of April 2026)
- **Framework**: Next.js 16 App Router (middleware is now `proxy.ts` — see `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`)
- **AI SDK**: `ai` v6 — route handlers use `streamText()` + `result.toUIMessageStreamResponse()`. Client uses `useChat({ transport: new DefaultChatTransport({ api }) })` with `sendMessage({text})` and renders `message.parts[]`, NOT `message.content`.
- **Model**: `anthropic('claude-sonnet-4-6')` via `@ai-sdk/anthropic`.
- **DB**: Neon Postgres `soft-leaf-42947114`, pgvector + tsvector. `lib/db.ts` exports `sql` (neon serverless HTTP driver).
- **Embeddings + rerank**: Voyage (`voyage-3-large`, `rerank-2`). `lib/voyage.ts`.
- **Ingestion**: Python at `ingest/` (separate venv; NOT run on Vercel).

## Corpus (read-only reference from upstream)
- Transcripts: `/Users/hannahwaxman/Documents/ark-media/transcripts/data/transcripts/*.txt` (187 files)
- State: `/Users/hannahwaxman/Documents/ark-media/transcripts/data/state.json`
- Knowledge base: `/Users/hannahwaxman/Documents/ark-media/transcripts/knowledge_base.json`
- Pipeline architecture: `/Users/hannahwaxman/Documents/ark-media/transcripts/ARCHITECTURE.md`

## Conventions
- No `middleware.ts` — use `proxy.ts` at project root.
- No `src/` dir. Route handlers live in `app/api/*/route.ts`.
- All retrieval/embedding server-side only; never expose API keys to client.
- System prompt enforces "cite or don't answer" — post-process responses without `[id:N]` citations.
