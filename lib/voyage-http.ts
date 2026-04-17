const VOYAGE_BASE = 'https://api.voyageai.com/v1';

function key(): string {
  const k = process.env.VOYAGE_API_KEY;
  if (!k) throw new Error('VOYAGE_API_KEY is not set');
  return k;
}

export async function embedQuery(text: string): Promise<number[]> {
  const res = await fetch(`${VOYAGE_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'voyage-3-large',
      input: [text],
      input_type: 'query',
    }),
  });
  if (!res.ok) {
    throw new Error(`voyage embed ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return json.data[0].embedding;
}

export type RerankResult = { index: number; relevance_score: number };

export async function rerank(
  query: string,
  documents: string[],
  topK: number,
): Promise<RerankResult[]> {
  if (documents.length === 0) return [];
  const res = await fetch(`${VOYAGE_BASE}/rerank`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'rerank-2',
      query,
      documents,
      top_k: Math.min(topK, documents.length),
    }),
  });
  if (!res.ok) {
    throw new Error(`voyage rerank ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return json.data as RerankResult[];
}
