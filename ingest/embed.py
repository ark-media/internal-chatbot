"""Batch embed chunks via Voyage voyage-3-large."""

from __future__ import annotations

import os
import time

import voyageai


MODEL = "voyage-3-large"
BATCH_SIZE = 128

_CLIENT: voyageai.Client | None = None


def _client() -> voyageai.Client:
    global _CLIENT
    if _CLIENT is not None:
        return _CLIENT
    key = os.environ.get("VOYAGE_API_KEY")
    if not key:
        raise RuntimeError("VOYAGE_API_KEY is not set")
    _CLIENT = voyageai.Client(api_key=key)
    return _CLIENT


def embed_documents(texts: list[str]) -> list[list[float]]:
    """Embed document texts. Retries on transient errors."""
    client = _client()
    out: list[list[float]] = []
    for start in range(0, len(texts), BATCH_SIZE):
        batch = texts[start : start + BATCH_SIZE]
        for attempt in range(5):
            try:
                resp = client.embed(batch, model=MODEL, input_type="document")
                out.extend(resp.embeddings)
                break
            except Exception as e:
                if attempt == 4:
                    raise
                wait = 2 ** attempt
                print(f"voyage embed batch failed ({e}); retry in {wait}s")
                time.sleep(wait)
    return out
