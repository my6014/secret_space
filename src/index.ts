import { createSessionToken, decryptContent, encryptContent, verifyPassword, verifySessionToken } from "./crypto";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  USER_ONE_USERNAME: string;
  USER_ONE_NAME: string;
  USER_ONE_PASSWORD_HASH: string;
  USER_TWO_USERNAME: string;
  USER_TWO_NAME: string;
  USER_TWO_PASSWORD_HASH: string;
  SESSION_SECRET: string;
  CONTENT_ENCRYPTION_KEY: string;
}

type AuthenticatedUser = { id: 1 | 2; name: string };
type MessageRow = {
  seq: number;
  id: string;
  author: 1 | 2;
  content_cipher: string;
  content_iv: string;
  created_at: string;
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_MESSAGE_LENGTH = 2000;

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function getCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie")?.split(";") ?? [];
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function sessionCookie(request: Request, token: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `secret_space_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function validOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

async function currentUser(request: Request, env: Env): Promise<AuthenticatedUser | null> {
  const token = getCookie(request, "secret_space_session");
  if (!token) return null;
  const session = await verifySessionToken(token, env.SESSION_SECRET);
  if (!session) return null;
  return { id: session.user, name: session.user === 1 ? env.USER_ONE_NAME : env.USER_TWO_NAME };
}

async function login(request: Request, env: Env): Promise<Response> {
  if (!validOrigin(request)) return json({ error: "请求来源无效" }, 403);
  const body = await request.json<{ username?: unknown; password?: unknown }>().catch(() => null);
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!username || !password || username.length > 80 || password.length > 256) {
    return json({ error: "请输入账号和密码" }, 400);
  }

  let id: 1 | 2 | null = null;
  let hash = env.USER_ONE_PASSWORD_HASH;
  if (username === env.USER_ONE_USERNAME) id = 1;
  if (username === env.USER_TWO_USERNAME) {
    id = 2;
    hash = env.USER_TWO_PASSWORD_HASH;
  }

  const valid = await verifyPassword(password, hash);
  if (!id || !valid) return json({ error: "账号或密码不正确" }, 401);

  const token = await createSessionToken(id, env.SESSION_SECRET);
  return json(
    { user: { id, name: id === 1 ? env.USER_ONE_NAME : env.USER_TWO_NAME } },
    200,
    { "set-cookie": sessionCookie(request, token, 30 * 24 * 60 * 60) },
  );
}

async function listMessages(request: Request, env: Env, user: AuthenticatedUser): Promise<Response> {
  const url = new URL(request.url);
  const after = Number(url.searchParams.get("after"));
  const before = Number(url.searchParams.get("before"));
  let query: D1PreparedStatement;
  let shouldReverse = false;

  if (Number.isSafeInteger(after) && after > 0) {
    query = env.DB.prepare("SELECT * FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT 100").bind(after);
  } else if (Number.isSafeInteger(before) && before > 0) {
    query = env.DB.prepare("SELECT * FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT 40").bind(before);
    shouldReverse = true;
  } else {
    query = env.DB.prepare("SELECT * FROM messages ORDER BY seq DESC LIMIT 40");
    shouldReverse = true;
  }

  const result = await query.all<MessageRow>();
  const rows = shouldReverse ? result.results.reverse() : result.results;
  const messages = await Promise.all(
    rows.map(async (row) => ({
      seq: row.seq,
      id: row.id,
      author: row.author,
      authorName: row.author === 1 ? env.USER_ONE_NAME : env.USER_TWO_NAME,
      content: await decryptContent(row.content_cipher, row.content_iv, env.CONTENT_ENCRYPTION_KEY),
      createdAt: row.created_at,
      mine: row.author === user.id,
    })),
  );
  return json({ messages, hasMore: rows.length === 40 && !(after > 0) });
}

async function createMessage(request: Request, env: Env, user: AuthenticatedUser): Promise<Response> {
  if (!validOrigin(request)) return json({ error: "请求来源无效" }, 403);
  const body = await request.json<{ content?: unknown }>().catch(() => null);
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  if (!content) return json({ error: "写点什么再发送吧" }, 400);
  if (content.length > MAX_MESSAGE_LENGTH) return json({ error: `最多可以写 ${MAX_MESSAGE_LENGTH} 个字` }, 400);

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const encrypted = await encryptContent(content, env.CONTENT_ENCRYPTION_KEY);
  const result = await env.DB.prepare(
    "INSERT INTO messages (id, author, content_cipher, content_iv, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, user.id, encrypted.cipher, encrypted.iv, createdAt)
    .run();

  return json(
    {
      message: {
        seq: Number(result.meta.last_row_id),
        id,
        author: user.id,
        authorName: user.name,
        content,
        createdAt,
        mine: true,
      },
    },
    201,
  );
}

async function deleteMessage(request: Request, env: Env, user: AuthenticatedUser, id: string): Promise<Response> {
  if (!validOrigin(request)) return json({ error: "请求来源无效" }, 403);
  const result = await env.DB.prepare("DELETE FROM messages WHERE id = ? AND author = ?").bind(id, user.id).run();
  if (!result.meta.changes) return json({ error: "消息不存在或无法删除" }, 404);
  return new Response(null, { status: 204 });
}

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/login" && request.method === "POST") return login(request, env);
  if (path === "/api/logout" && request.method === "POST") {
    if (!validOrigin(request)) return json({ error: "请求来源无效" }, 403);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(request, "", 0) });
  }

  const user = await currentUser(request, env);
  if (!user) return json({ error: "请先登录" }, 401);

  if (path === "/api/session" && request.method === "GET") {
    return json({ user, partnerName: user.id === 1 ? env.USER_TWO_NAME : env.USER_ONE_NAME });
  }
  if (path === "/api/messages" && request.method === "GET") return listMessages(request, env, user);
  if (path === "/api/messages" && request.method === "POST") return createMessage(request, env, user);
  if (path.startsWith("/api/messages/") && request.method === "DELETE") {
    const id = decodeURIComponent(path.slice("/api/messages/".length));
    return deleteMessage(request, env, user, id);
  }

  return json({ error: "接口不存在" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (new URL(request.url).pathname.startsWith("/api/")) return await api(request, env);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: "暂时出了点问题，请稍后再试" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
