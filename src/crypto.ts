import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  pbkdf2 as derivePassword,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const pbkdf2 = promisify(derivePassword);

export type SessionPayload = {
  user: 1 | 2;
  exp: number;
};

function equalBuffers(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function hashPassword(password: string, iterations = 210_000): Promise<string> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, iterations, 32, "sha256");
  return `pbkdf2$${iterations}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, iterationText, saltText, hashText] = storedHash.split("$");
  const iterations = Number(iterationText);
  if (algorithm !== "pbkdf2" || !Number.isSafeInteger(iterations) || iterations < 100_000 || !saltText || !hashText) {
    return false;
  }

  try {
    const expected = Buffer.from(hashText, "base64url");
    const actual = await pbkdf2(password, Buffer.from(saltText, "base64url"), iterations, expected.length, "sha256");
    return equalBuffers(actual, expected);
  } catch {
    return false;
  }
}

export function createSessionToken(user: 1 | 2, secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ user, exp: now + 30 * 24 * 60 * 60 * 1000 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifySessionToken(token: string, secret: string, now = Date.now()): SessionPayload | null {
  try {
    const [payloadText, signatureText, extra] = token.split(".");
    if (!payloadText || !signatureText || extra) return null;
    const expected = createHmac("sha256", secret).update(payloadText).digest();
    const actual = Buffer.from(signatureText, "base64url");
    if (!equalBuffers(actual, expected)) return null;
    const payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8")) as SessionPayload;
    if ((payload.user !== 1 && payload.user !== 2) || !Number.isFinite(payload.exp) || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

function contentKey(secret: string): Buffer {
  const key = Buffer.from(secret, "base64");
  if (key.length !== 32) throw new Error("CONTENT_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return key;
}

export function encryptContent(content: string, secret: string): { cipher: string; iv: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", contentKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(content, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { cipher: encrypted.toString("base64"), iv: iv.toString("base64") };
}

export function decryptContent(cipherText: string, ivText: string, secret: string): string {
  const encrypted = Buffer.from(cipherText, "base64");
  if (encrypted.length < 17) throw new Error("Encrypted message is invalid");
  const content = encrypted.subarray(0, -16);
  const authTag = encrypted.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", contentKey(secret), Buffer.from(ivText, "base64"));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(content), decipher.final()]).toString("utf8");
}
