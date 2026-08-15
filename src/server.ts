import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { loadConfig, type AppConfig } from "./config";
import { createSessionToken, decryptContent, encryptContent, verifyPassword, verifySessionToken } from "./crypto";
import { createMessageStore, type MessageRow, type MessageStore } from "./database";

type AuthenticatedUser = { id: 1 | 2; name: string };
const MAX_MESSAGE_LENGTH = 2000;
const SESSION_COOKIE = "secret_space_session";
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 12;

function parseCookie(request: Request, name: string): string | null {
  for (const cookie of request.headers.cookie?.split(";") ?? []) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function validOrigin(request: Request): boolean {
  const origin = request.get("origin");
  if (!origin) return true;
  return origin === `${request.protocol}://${request.get("host")}`;
}

function currentUser(request: Request, config: AppConfig): AuthenticatedUser | null {
  const token = parseCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const session = verifySessionToken(token, config.sessionSecret);
  if (!session) return null;
  return { id: session.user, name: session.user === 1 ? config.userOne.name : config.userTwo.name };
}

function presentMessage(row: MessageRow, user: AuthenticatedUser, config: AppConfig) {
  return {
    seq: row.seq,
    id: row.id,
    author: row.author,
    authorName: row.author === 1 ? config.userOne.name : config.userTwo.name,
    content: decryptContent(row.content_cipher, row.content_iv, config.contentEncryptionKey),
    createdAt: row.created_at,
    mine: row.author === user.id,
  };
}

export async function createApp(config = loadConfig(), store: MessageStore = createMessageStore(config)) {
  await store.init();
  const app = express();
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  const publicDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../public");

  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.use((_request, response, next) => {
    response.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    next();
  });

  app.post("/api/login", async (request, response) => {
    if (!validOrigin(request)) return response.status(403).json({ error: "请求来源无效" });
    const key = request.ip || request.socket.remoteAddress || "unknown";
    const now = Date.now();
    const attempt = loginAttempts.get(key);
    if (attempt && attempt.resetAt > now && attempt.count >= LOGIN_LIMIT) {
      return response.status(429).json({ error: "尝试次数过多，请稍后再试" });
    }

    const username = typeof request.body?.username === "string" ? request.body.username.trim() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!username || !password || username.length > 80 || password.length > 256) {
      return response.status(400).json({ error: "请输入账号和密码" });
    }

    let id: 1 | 2 | null = null;
    let hash = config.userOne.passwordHash;
    if (username === config.userOne.username) id = 1;
    if (username === config.userTwo.username) {
      id = 2;
      hash = config.userTwo.passwordHash;
    }

    const valid = await verifyPassword(password, hash);
    if (!id || !valid) {
      loginAttempts.set(key, {
        count: attempt && attempt.resetAt > now ? attempt.count + 1 : 1,
        resetAt: attempt && attempt.resetAt > now ? attempt.resetAt : now + LOGIN_WINDOW_MS,
      });
      return response.status(401).json({ error: "账号或密码不正确" });
    }

    loginAttempts.delete(key);
    response.cookie(SESSION_COOKIE, createSessionToken(id, config.sessionSecret), {
      httpOnly: true,
      sameSite: "strict",
      secure: config.secureCookies,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: "/",
    });
    return response.json({ user: { id, name: id === 1 ? config.userOne.name : config.userTwo.name } });
  });

  app.post("/api/logout", (request, response) => {
    if (!validOrigin(request)) return response.status(403).json({ error: "请求来源无效" });
    response.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "strict", secure: config.secureCookies, path: "/" });
    return response.json({ ok: true });
  });

  app.use("/api", (request, response, next) => {
    const user = currentUser(request, config);
    if (!user) return response.status(401).json({ error: "请先登录" });
    response.locals.user = user;
    next();
  });

  app.get("/api/session", (_request, response) => {
    const user = response.locals.user as AuthenticatedUser;
    response.json({ user, partnerName: user.id === 1 ? config.userTwo.name : config.userOne.name });
  });

  app.get("/api/messages", async (request, response) => {
    const user = response.locals.user as AuthenticatedUser;
    const after = Number(request.query.after);
    const before = Number(request.query.before);
    let rows: MessageRow[];
    let hasMore = false;

    if (Number.isSafeInteger(after) && after > 0) {
      rows = await store.listAfter(after, 100);
    } else if (Number.isSafeInteger(before) && before > 0) {
      rows = await store.listBefore(before, 40);
      hasMore = rows.length === 40;
      rows.reverse();
    } else {
      rows = await store.listRecent(40);
      hasMore = rows.length === 40;
      rows.reverse();
    }
    response.json({ messages: rows.map((row) => presentMessage(row, user, config)), hasMore });
  });

  app.post("/api/messages", async (request, response) => {
    if (!validOrigin(request)) return response.status(403).json({ error: "请求来源无效" });
    const user = response.locals.user as AuthenticatedUser;
    const content = typeof request.body?.content === "string" ? request.body.content.trim() : "";
    if (!content) return response.status(400).json({ error: "写点什么再发送吧" });
    if (content.length > MAX_MESSAGE_LENGTH) return response.status(400).json({ error: `最多可以写 ${MAX_MESSAGE_LENGTH} 个字` });

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const encrypted = encryptContent(content, config.contentEncryptionKey);
    const seq = await store.create({
      id,
      author: user.id,
      content_cipher: encrypted.cipher,
      content_iv: encrypted.iv,
      created_at: createdAt,
    });
    response.status(201).json({
      message: { seq, id, author: user.id, authorName: user.name, content, createdAt, mine: true },
    });
  });

  app.delete("/api/messages/:id", async (request, response) => {
    if (!validOrigin(request)) return response.status(403).json({ error: "请求来源无效" });
    const user = response.locals.user as AuthenticatedUser;
    const deleted = await store.deleteOwn(request.params.id, user.id);
    if (!deleted) return response.status(404).json({ error: "消息不存在或无法删除" });
    response.status(204).end();
  });

  app.use("/api", (_request, response) => response.status(404).json({ error: "接口不存在" }));
  app.use(express.static(publicDirectory, { index: false, maxAge: "1h" }));
  app.use((request, response, next) => {
    if (request.method === "GET" && request.accepts("html")) return response.sendFile(resolve(publicDirectory, "index.html"));
    next();
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error(error);
    response.status(500).json({ error: "暂时出了点问题，请稍后再试" });
  });

  return { app, store };
}

async function main() {
  const config = loadConfig();
  const { app, store } = await createApp(config);
  const server = app.listen(config.port, config.host, () => {
    console.log(`Secret Space is running at http://${config.host}:${config.port} (${config.databaseDriver})`);
  });

  const shutdown = () => {
    server.close(() => void store.close().finally(() => process.exit(0)));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.env.NODE_ENV !== "test") {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
