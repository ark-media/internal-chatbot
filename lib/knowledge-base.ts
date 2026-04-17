import { readFileSync } from 'node:fs';

import bundledKB from '../data/knowledge_base.json';

type KnowledgeBase = {
  corrections?: Record<string, string>;
  people?: Record<string, string[] | string>;
  shows?: Record<
    string,
    {
      host?: string;
      co_hosts?: string[];
      vocabulary?: string[];
      guests?: Record<string, string[]>;
    }
  >;
};

let cached: KnowledgeBase | null = null;

export function loadKB(): KnowledgeBase {
  if (cached) return cached;
  const path = process.env.KB_JSON_PATH;
  if (path) {
    try {
      cached = JSON.parse(readFileSync(path, 'utf8')) as KnowledgeBase;
      return cached;
    } catch {
      // fall through to bundled copy
    }
  }
  cached = bundledKB as unknown as KnowledgeBase;
  return cached;
}

export function expandQueryWithKnownNames(query: string): string[] {
  const kb = loadKB();
  const extras = new Set<string>();
  const lower = query.toLowerCase();
  for (const [canonical, variants] of Object.entries(kb.people ?? {})) {
    if (canonical.startsWith('_')) continue;
    if (!Array.isArray(variants)) continue;
    if (lower.includes(canonical.toLowerCase())) continue;
    for (const v of variants) {
      if (v && lower.includes(v.toLowerCase())) {
        extras.add(canonical);
        break;
      }
    }
  }
  return Array.from(extras);
}

export function shows(): string[] {
  const kb = loadKB();
  return Object.keys(kb.shows ?? {}).filter((k) => !k.startsWith('_'));
}
