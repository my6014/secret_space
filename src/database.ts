import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import type { AppConfig } from "./config";

export type MessageRow = {
  seq: number;
  id: string;
  author: 1 | 2;
  content_cipher: string;
  content_iv: string;
  created_at: string;
};

export type NewMessage = Omit<MessageRow, "seq">;

export interface MessageStore {
  init(): Promise<void>;
  listRecent(limit: number): Promise<MessageRow[]>;
  listBefore(seq: number, limit: number): Promise<MessageRow[]>;
  listAfter(seq: number, limit: number): Promise<MessageRow[]>;
  create(message: NewMessage): Promise<number>;
  deleteOwn(id: string, author: 1 | 2): Promise<boolean>;
  close(): Promise<void>;
}

class SqliteMessageStore implements MessageStore {
  private database: Database.Database | null = null;

  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    const fullPath = resolve(this.path);
    await mkdir(dirname(fullPath), { recursive: true });
    this.database = new Database(fullPath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        author INTEGER NOT NULL CHECK (author IN (1, 2)),
        content_cipher TEXT NOT NULL,
        content_iv TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    `);
  }

  private db(): Database.Database {
    if (!this.database) throw new Error("SQLite store has not been initialized");
    return this.database;
  }

  async listRecent(limit: number): Promise<MessageRow[]> {
    return this.db().prepare("SELECT * FROM messages ORDER BY seq DESC LIMIT ?").all(limit) as MessageRow[];
  }

  async listBefore(seq: number, limit: number): Promise<MessageRow[]> {
    return this.db().prepare("SELECT * FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?").all(seq, limit) as MessageRow[];
  }

  async listAfter(seq: number, limit: number): Promise<MessageRow[]> {
    return this.db().prepare("SELECT * FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT ?").all(seq, limit) as MessageRow[];
  }

  async create(message: NewMessage): Promise<number> {
    const result = this.db()
      .prepare("INSERT INTO messages (id, author, content_cipher, content_iv, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(message.id, message.author, message.content_cipher, message.content_iv, message.created_at);
    return Number(result.lastInsertRowid);
  }

  async deleteOwn(id: string, author: 1 | 2): Promise<boolean> {
    return this.db().prepare("DELETE FROM messages WHERE id = ? AND author = ?").run(id, author).changes > 0;
  }

  async close(): Promise<void> {
    this.database?.close();
    this.database = null;
  }
}

type MysqlMessageRow = RowDataPacket & MessageRow;

class MysqlMessageStore implements MessageStore {
  private pool: Pool | null = null;

  constructor(private readonly url: string) {}

  async init(): Promise<void> {
    this.pool = mysql.createPool({ uri: this.url, connectionLimit: 5, charset: "utf8mb4" });
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        id VARCHAR(36) NOT NULL UNIQUE,
        author TINYINT UNSIGNED NOT NULL,
        content_cipher TEXT NOT NULL,
        content_iv VARCHAR(64) NOT NULL,
        created_at VARCHAR(32) NOT NULL,
        INDEX idx_messages_created_at (created_at),
        CHECK (author IN (1, 2))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  private db(): Pool {
    if (!this.pool) throw new Error("MySQL store has not been initialized");
    return this.pool;
  }

  private async rows(sql: string, values: Array<string | number>): Promise<MessageRow[]> {
    const [rows] = await this.db().execute<MysqlMessageRow[]>(sql, values);
    return rows.map((row) => ({ ...row, seq: Number(row.seq), author: Number(row.author) as 1 | 2 }));
  }

  listRecent(limit: number): Promise<MessageRow[]> {
    return this.rows("SELECT * FROM messages ORDER BY seq DESC LIMIT ?", [limit]);
  }

  listBefore(seq: number, limit: number): Promise<MessageRow[]> {
    return this.rows("SELECT * FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?", [seq, limit]);
  }

  listAfter(seq: number, limit: number): Promise<MessageRow[]> {
    return this.rows("SELECT * FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT ?", [seq, limit]);
  }

  async create(message: NewMessage): Promise<number> {
    const [result] = await this.db().execute<ResultSetHeader>(
      "INSERT INTO messages (id, author, content_cipher, content_iv, created_at) VALUES (?, ?, ?, ?, ?)",
      [message.id, message.author, message.content_cipher, message.content_iv, message.created_at],
    );
    return result.insertId;
  }

  async deleteOwn(id: string, author: 1 | 2): Promise<boolean> {
    const [result] = await this.db().execute<ResultSetHeader>("DELETE FROM messages WHERE id = ? AND author = ?", [id, author]);
    return result.affectedRows > 0;
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }
}

export function createMessageStore(config: AppConfig): MessageStore {
  return config.databaseDriver === "mysql"
    ? new MysqlMessageStore(config.mysqlUrl as string)
    : new SqliteMessageStore(config.sqlitePath);
}
