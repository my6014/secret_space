const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type SessionPayload = {
  user: 1 | 2;
  exp: number;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, iterationText, saltText, hashText] = storedHash.split("$");
  const iterations = Number(iterationText);
  if (algorithm !== "pbkdf2" || !Number.isSafeInteger(iterations) || iterations < 100_000 || !saltText || !hashText) {
    return false;
  }

  try {
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const derived = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(fromBase64Url(saltText)), iterations },
      key,
      256,
    );
    return equalBytes(new Uint8Array(derived), fromBase64Url(hashText));
  } catch {
    return false;
  }
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function createSessionToken(user: 1 | 2, secret: string, now = Date.now()): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify({ user, exp: now + 30 * 24 * 60 * 60 * 1000 })));
  const signature = toBase64Url(await hmac(secret, payload));
  return `${payload}.${signature}`;
}

export async function verifySessionToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<SessionPayload | null> {
  try {
    const [payloadText, signatureText, extra] = token.split(".");
    if (!payloadText || !signatureText || extra) return null;
    const expected = await hmac(secret, payloadText);
    if (!equalBytes(expected, fromBase64Url(signatureText))) return null;
    const payload = JSON.parse(decoder.decode(fromBase64Url(payloadText))) as SessionPayload;
    if ((payload.user !== 1 && payload.user !== 2) || !Number.isFinite(payload.exp) || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

async function contentKey(secret: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(secret);
  if (bytes.byteLength !== 32) throw new Error("CONTENT_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return crypto.subtle.importKey("raw", toArrayBuffer(bytes), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptContent(content: string, secret: string): Promise<{ cipher: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await contentKey(secret), encoder.encode(content));
  return { cipher: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}

export async function decryptContent(cipher: string, iv: string, secret: string): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(iv)) },
    await contentKey(secret),
    toArrayBuffer(base64ToBytes(cipher)),
  );
  return decoder.decode(decrypted);
}
