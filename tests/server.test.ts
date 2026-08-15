import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config";
import { hashPassword } from "../src/crypto";
import { createMessageStore } from "../src/database";
import { createApp } from "../src/server";

describe("Node API with SQLite", () => {
  let directory: string;
  let databasePath: string;
  let closeStore: () => Promise<void>;
  let app: Awaited<ReturnType<typeof createApp>>["app"];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "secret-space-test-"));
    databasePath = join(directory, "messages.db");
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 3000,
      databaseDriver: "sqlite",
      sqlitePath: databasePath,
      userOne: { username: "one", name: "星星", passwordHash: await hashPassword("password-one", 100_000) },
      userTwo: { username: "two", name: "月亮", passwordHash: await hashPassword("password-two", 100_000) },
      sessionSecret: "test-session-secret",
      contentEncryptionKey: Buffer.alloc(32, 3).toString("base64"),
      secureCookies: false,
    };
    const store = createMessageStore(config);
    ({ app } = await createApp(config, store));
    closeStore = () => store.close();
  });

  afterEach(async () => {
    await closeStore();
    await rm(directory, { recursive: true, force: true });
  });

  it("logs in, stores encrypted messages, and enforces ownership", async () => {
    const firstUser = request.agent(app);
    const secondUser = request.agent(app);

    await firstUser.post("/api/login").send({ username: "one", password: "password-one" }).expect(200);
    const created = await firstUser.post("/api/messages").send({ content: "只属于我们" }).expect(201);
    expect(created.body.message.content).toBe("只属于我们");

    const database = new Database(databasePath, { readonly: true });
    const stored = database.prepare("SELECT content_cipher FROM messages WHERE id = ?").get(created.body.message.id) as {
      content_cipher: string;
    };
    database.close();
    expect(stored.content_cipher).not.toContain("只属于我们");

    const messages = await firstUser.get("/api/messages").expect(200);
    expect(messages.body.messages).toMatchObject([{ content: "只属于我们", mine: true }]);

    await secondUser.post("/api/login").send({ username: "two", password: "password-two" }).expect(200);
    await secondUser.delete(`/api/messages/${created.body.message.id}`).expect(404);
    await firstUser.delete(`/api/messages/${created.body.message.id}`).expect(204);
  });
});
