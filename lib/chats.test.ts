import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the sql template tag and sql.transaction. We capture the strings each
// query was built from so tests can assert on what SQL the persistence layer
// generates without needing a real Postgres.
const sqlCalls: Array<{ strings: readonly string[]; values: unknown[] }> = [];
const transactionCalls: Array<unknown[]> = [];
let nextResults: unknown[] = [];

const defaultSqlImpl = (strings: TemplateStringsArray, ...values: unknown[]) => {
  sqlCalls.push({ strings: [...strings], values });
  return Promise.resolve(nextResults);
};
const defaultTransactionImpl = (queries: unknown[]) => {
  transactionCalls.push(queries);
  return Promise.resolve(queries.map(() => [] as unknown[]));
};

const mockSql = vi.fn(defaultSqlImpl) as ReturnType<typeof vi.fn> & {
  transaction: ReturnType<typeof vi.fn>;
};
mockSql.transaction = vi.fn(defaultTransactionImpl);

vi.mock('./db', () => ({
  get sql() {
    return mockSql;
  },
}));

// Import AFTER the mock is registered.
import {
  redactFileParts,
  persistIncomingMessages,
  persistAssistantMessage,
  loadChat,
  listChats,
  deleteChat,
  purgeExpired,
} from './chats';

beforeEach(() => {
  sqlCalls.length = 0;
  transactionCalls.length = 0;
  nextResults = [];
  // Reset both call history AND implementation, then re-install the default
  // so per-test mockImplementation overrides don't leak across tests.
  mockSql.mockReset();
  mockSql.mockImplementation(defaultSqlImpl);
  mockSql.transaction.mockReset();
  mockSql.transaction.mockImplementation(defaultTransactionImpl);
});

type TestPart = { type: string; [key: string]: unknown };

describe('redactFileParts', () => {
  it('drops url and data from file parts but keeps filename + mediaType', () => {
    const out = redactFileParts<TestPart>([
      {
        type: 'file',
        filename: 'doc.pdf',
        mediaType: 'application/pdf',
        url: 'data:application/pdf;base64,JVBERi0xLjQK...',
        data: 'JVBERi0xLjQK',
      },
    ]);
    expect(out).toEqual([
      { type: 'file', filename: 'doc.pdf', mediaType: 'application/pdf' },
    ]);
    expect(out[0]).not.toHaveProperty('url');
    expect(out[0]).not.toHaveProperty('data');
  });

  it('passes through non-file parts unchanged', () => {
    const text: TestPart = { type: 'text', text: 'hello' };
    const tool: TestPart = {
      type: 'tool-lookupCorpus',
      state: 'output-available',
      output: { x: 1 },
    };
    const out = redactFileParts<TestPart>([text, tool]);
    expect(out).toEqual([text, tool]);
  });

  it('handles file parts with missing optional fields', () => {
    const out = redactFileParts<TestPart>([
      { type: 'file', url: 'data:...' },
      { type: 'file', filename: 'just-name' },
    ]);
    expect(out).toEqual([{ type: 'file' }, { type: 'file', filename: 'just-name' }]);
  });
});

describe('persistIncomingMessages', () => {
  it('returns 0 on empty input without touching the DB', async () => {
    const result = await persistIncomingMessages({
      chatId: 'c1',
      surface: 'archive',
      messages: [],
    });
    expect(result.newCount).toBe(0);
    expect(mockSql.transaction).not.toHaveBeenCalled();
  });

  it('runs everything in a single transaction with a per-chat advisory lock', async () => {
    await persistIncomingMessages({
      chatId: 'chat-abc',
      surface: 'archive',
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      ],
    });
    expect(mockSql.transaction).toHaveBeenCalledTimes(1);
    const queries = transactionCalls[0];
    // [advisory_lock, chats_insert, per-message inserts...]
    expect(queries.length).toEqual(3);
    // First query should be the advisory lock — capture its SQL fragment.
    const lockCallIdx = sqlCalls.findIndex((c) =>
      c.strings.join(' ').includes('pg_advisory_xact_lock'),
    );
    expect(lockCallIdx).toBeGreaterThanOrEqual(0);
    // The chats INSERT should reference the surface and chatId.
    const chatsInsert = sqlCalls.find((c) => c.strings.join('').includes('INSERT INTO chats'));
    expect(chatsInsert?.values).toContain('chat-abc');
    expect(chatsInsert?.values).toContain('archive');
    // Title is derived from the user's text part.
    expect(chatsInsert?.values).toContain('hello');
  });

  it('derives title from the FIRST USER text part, not from non-user messages', async () => {
    await persistIncomingMessages({
      chatId: 'c2',
      surface: 'prep',
      messages: [
        // Pretend an assistant message somehow appears first — the title
        // should still come from the first user text.
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'assistant noise' }] },
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'real user prompt' }] },
      ],
    });
    const chatsInsert = sqlCalls.find((c) => c.strings.join('').includes('INSERT INTO chats'));
    expect(chatsInsert?.values).toContain('real user prompt');
    expect(chatsInsert?.values).not.toContain('assistant noise');
  });

  it('redacts file parts when redactFiles=true', async () => {
    await persistIncomingMessages({
      chatId: 'c3',
      surface: 'prep',
      messages: [
        {
          id: 'm1',
          role: 'user',
          parts: [
            { type: 'text', text: 'see attached' },
            {
              type: 'file',
              filename: 'paper.pdf',
              mediaType: 'application/pdf',
              url: 'data:application/pdf;base64,SECRET',
            },
          ],
        },
      ],
      redactFiles: true,
    });
    const insert = sqlCalls.find((c) =>
      c.strings.join(' ').includes('INSERT INTO chat_messages'),
    );
    expect(insert).toBeDefined();
    // The persisted parts JSON should not contain the data URL.
    const partsJson = insert!.values.find(
      (v): v is string => typeof v === 'string' && v.startsWith('['),
    );
    expect(partsJson).toBeDefined();
    expect(partsJson).not.toContain('SECRET');
    expect(partsJson).not.toContain('data:application/pdf');
    expect(partsJson).toContain('paper.pdf');
    expect(partsJson).toContain('application/pdf');
  });

  it('computes ordinal at INSERT time via subquery (no read-then-write race)', async () => {
    await persistIncomingMessages({
      chatId: 'c4',
      surface: 'archive',
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'q' }] },
        { id: 'm2', role: 'user', parts: [{ type: 'text', text: 'q2' }] },
      ],
    });
    const messageInserts = sqlCalls.filter((c) =>
      c.strings.join(' ').includes('INSERT INTO chat_messages'),
    );
    expect(messageInserts.length).toBeGreaterThanOrEqual(2);
    for (const ins of messageInserts) {
      const sqlText = ins.strings.join(' ');
      // The ordinal must be derived in the INSERT itself, not passed as a value.
      expect(sqlText).toContain('SELECT MAX(ordinal)');
      expect(sqlText).toContain('COALESCE');
    }
  });

  it('reports newCount based on rows actually inserted', async () => {
    // Simulate ON CONFLICT skip on the second message.
    mockSql.transaction.mockResolvedValueOnce([
      [], // advisory lock result
      [], // chats insert
      [{ '?column?': 1 }], // m1 inserted
      [], // m2 was a duplicate — skipped
    ]);
    const result = await persistIncomingMessages({
      chatId: 'c5',
      surface: 'archive',
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'a' }] },
        { id: 'm2', role: 'user', parts: [{ type: 'text', text: 'b' }] },
      ],
    });
    expect(result.newCount).toBe(1);
  });
});

describe('persistAssistantMessage', () => {
  it('uses a transaction with advisory lock + ordinal subquery + touch', async () => {
    await persistAssistantMessage({
      chatId: 'c6',
      message: {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'response' }],
      },
    });
    expect(mockSql.transaction).toHaveBeenCalledTimes(1);
    const queries = transactionCalls[0];
    expect(queries.length).toEqual(3); // lock, insert, touch
    const insert = sqlCalls.find((c) =>
      c.strings.join(' ').includes('INSERT INTO chat_messages'),
    );
    const touch = sqlCalls.find((c) => c.strings.join(' ').includes('UPDATE chats'));
    expect(insert).toBeDefined();
    expect(touch).toBeDefined();
    expect(touch?.values).toContain('c6');
  });
});

describe('loadChat', () => {
  it('returns null when chat row is missing or expired', async () => {
    nextResults = []; // first sql call (chats SELECT) returns no rows
    const out = await loadChat('missing-id');
    expect(out).toBeNull();
  });

  it('reconstructs StoredMessage from row data and orders by ordinal', async () => {
    // Sequence: first call returns the chat row; second call returns the messages.
    let callIdx = 0;
    mockSql.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return Promise.resolve([
          { id: 'c7', surface: 'archive', title: 'hi' },
        ]);
      }
      return Promise.resolve([
        { message_id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { message_id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'yo' }] },
      ]);
    });
    const chat = await loadChat('c7');
    expect(chat).not.toBeNull();
    expect(chat!.id).toBe('c7');
    expect(chat!.surface).toBe('archive');
    expect(chat!.messages).toEqual([
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'yo' }] },
    ]);
  });
});

describe('listChats', () => {
  it('filters by surface and only returns non-expired rows', async () => {
    nextResults = [{ id: 'a', title: 'one', updated_at: '2026-04-30T00:00:00Z' }];
    const rows = await listChats('archive');
    const sqlText = sqlCalls[0].strings.join(' ');
    expect(sqlText).toContain('surface = ');
    expect(sqlText).toContain('expires_at > NOW()');
    expect(rows).toEqual([
      { id: 'a', title: 'one', updated_at: '2026-04-30T00:00:00Z' },
    ]);
  });
});

describe('deleteChat', () => {
  it('returns true when a row was deleted', async () => {
    nextResults = [1];
    const ok = await deleteChat('cX');
    expect(ok).toBe(true);
  });

  it('returns false when no row matched', async () => {
    nextResults = [];
    const ok = await deleteChat('not-here');
    expect(ok).toBe(false);
  });
});

describe('purgeExpired', () => {
  it('returns the count of deleted chats', async () => {
    nextResults = [1, 1, 1, 1, 1]; // 5 rows
    const n = await purgeExpired();
    expect(n).toBe(5);
  });

  it('returns 0 when nothing expired', async () => {
    nextResults = [];
    expect(await purgeExpired()).toBe(0);
  });
});
