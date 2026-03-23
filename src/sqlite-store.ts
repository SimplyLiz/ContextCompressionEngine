import type BetterSqlite3 from 'better-sqlite3';
import type { CompressResult, Message, VerbatimMap } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DatabaseConstructor = new (path: string, options?: any) => BetterSqlite3.Database;

async function loadBetterSqlite3(): Promise<DatabaseConstructor> {
  try {
    const mod = await import('better-sqlite3');
    return (mod.default ?? mod) as unknown as DatabaseConstructor;
  } catch {
    throw new Error(
      'SqliteStore requires "better-sqlite3" as a peer dependency. ' +
        'Install it with: npm install better-sqlite3',
    );
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    conversation_id TEXT NOT NULL,
    message_index   INTEGER NOT NULL,
    message_json    TEXT NOT NULL,
    PRIMARY KEY (conversation_id, message_index)
  );

  CREATE TABLE IF NOT EXISTS verbatim (
    conversation_id TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    message_json    TEXT NOT NULL,
    PRIMARY KEY (conversation_id, message_id)
  );
`;

export interface SqliteStoreLoadResult {
  messages: Message[];
  verbatim: VerbatimMap;
}

/**
 * Persistent verbatim store backed by SQLite via better-sqlite3.
 *
 * Provides atomic save/load of CompressResult data (messages + verbatim)
 * and a StoreLookup function for use with uncompress().
 *
 * Requires `better-sqlite3` as an optional peer dependency.
 *
 * ```ts
 * const store = await SqliteStore.open(':memory:');
 * store.save('conv-1', compressResult);
 * const data = store.load('conv-1');
 * const restored = uncompress(data.messages, store.lookup('conv-1'));
 * store.close();
 * ```
 */
export class SqliteStore {
  private db: BetterSqlite3.Database;

  private constructor(db: BetterSqlite3.Database) {
    this.db = db;
    db.exec(SCHEMA);
  }

  /**
   * Open a SQLite store at the given path. Use `:memory:` for an in-memory database.
   */
  static async open(path: string): Promise<SqliteStore> {
    const Database = await loadBetterSqlite3();
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    return new SqliteStore(db);
  }

  /**
   * Atomically save compressed messages and their verbatim originals.
   *
   * Messages are replaced entirely for the conversation. Verbatim entries
   * are upserted — older entries from prior compression rounds are preserved
   * so that recursive uncompress() works across multiple rounds.
   */
  save(conversationId: string, result: CompressResult): void {
    const insertMsg = this.db.prepare(
      'INSERT INTO conversations (conversation_id, message_index, message_json) VALUES (?, ?, ?)',
    );
    const upsertVerbatim = this.db.prepare(
      'INSERT OR REPLACE INTO verbatim (conversation_id, message_id, message_json) VALUES (?, ?, ?)',
    );
    const deleteMessages = this.db.prepare('DELETE FROM conversations WHERE conversation_id = ?');

    this.db.transaction(() => {
      deleteMessages.run(conversationId);

      for (let i = 0; i < result.messages.length; i++) {
        insertMsg.run(conversationId, i, JSON.stringify(result.messages[i]));
      }

      for (const [id, msg] of Object.entries(result.verbatim)) {
        upsertVerbatim.run(conversationId, id, JSON.stringify(msg));
      }
    })();
  }

  /**
   * Load compressed messages and the full verbatim map for a conversation.
   * Returns null if the conversation does not exist.
   */
  load(conversationId: string): SqliteStoreLoadResult | null {
    const rows = this.db
      .prepare(
        'SELECT message_json FROM conversations WHERE conversation_id = ? ORDER BY message_index',
      )
      .all(conversationId) as Array<{ message_json: string }>;

    if (rows.length === 0) return null;

    const messages: Message[] = rows.map((r) => JSON.parse(r.message_json) as Message);

    const verbatimRows = this.db
      .prepare('SELECT message_id, message_json FROM verbatim WHERE conversation_id = ?')
      .all(conversationId) as Array<{ message_id: string; message_json: string }>;

    const verbatim: VerbatimMap = {};
    for (const r of verbatimRows) {
      verbatim[r.message_id] = JSON.parse(r.message_json) as Message;
    }

    return { messages, verbatim };
  }

  /**
   * Return a StoreLookup function for use with uncompress().
   *
   * Each call executes a single-row SELECT — no need to load the
   * entire verbatim map into memory.
   */
  lookup(conversationId: string): (id: string) => Message | undefined {
    const stmt = this.db.prepare(
      'SELECT message_json FROM verbatim WHERE conversation_id = ? AND message_id = ?',
    );
    return (id: string): Message | undefined => {
      const row = stmt.get(conversationId, id) as { message_json: string } | undefined;
      return row ? (JSON.parse(row.message_json) as Message) : undefined;
    };
  }

  /**
   * Delete a conversation and all its verbatim entries.
   */
  delete(conversationId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM conversations WHERE conversation_id = ?').run(conversationId);
      this.db.prepare('DELETE FROM verbatim WHERE conversation_id = ?').run(conversationId);
    })();
  }

  /**
   * List all stored conversation IDs.
   */
  list(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT conversation_id FROM conversations ORDER BY conversation_id')
      .all() as Array<{ conversation_id: string }>;
    return rows.map((r) => r.conversation_id);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
