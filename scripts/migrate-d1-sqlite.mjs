import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import "dotenv/config";

const sourcePath = process.argv[2] ? resolve(process.argv[2]) : "";
const targetPath = resolve(process.argv[3] || process.env.SQLITE_PATH || "./data/secret-space.db");

if (!sourcePath) {
  console.error("用法: npm run migrate:d1 -- <D1 sqlite 文件> [目标 sqlite 文件]");
  process.exit(1);
}
if (!existsSync(sourcePath)) {
  console.error(`D1 文件不存在: ${sourcePath}`);
  process.exit(1);
}
if (sourcePath === targetPath) {
  console.error("源数据库和目标数据库不能是同一个文件");
  process.exit(1);
}

await mkdir(dirname(targetPath), { recursive: true });
const source = new Database(sourcePath, { readonly: true });
const target = new Database(targetPath);

try {
  const table = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get();
  if (!table) throw new Error("源数据库中没有 messages 表");

  target.pragma("journal_mode = WAL");
  target.exec(`
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

  const rows = source.prepare(
    "SELECT seq, id, author, content_cipher, content_iv, created_at FROM messages ORDER BY seq ASC",
  ).all();
  const insert = target.prepare(`
    INSERT OR IGNORE INTO messages (seq, id, author, content_cipher, content_iv, created_at)
    VALUES (@seq, @id, @author, @content_cipher, @content_iv, @created_at)
  `);
  const importRows = target.transaction((messages) => {
    let imported = 0;
    for (const row of messages) imported += insert.run(row).changes;
    return imported;
  });
  const imported = importRows(rows);
  console.log(`D1 迁移完成：读取 ${rows.length} 条，新增 ${imported} 条，目标 ${targetPath}`);
} finally {
  source.close();
  target.close();
}
