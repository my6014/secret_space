import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  decryptContent,
  encryptContent,
  hashPassword,
  verifyPassword,
  verifySessionToken,
} from "../src/crypto";

describe("crypto", () => {
  it("hashes and verifies passwords", async () => {
    const hash = await hashPassword("only-us", 100_000);
    await expect(verifyPassword("only-us", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
  });

  it("signs sessions and rejects tampering or expiration", () => {
    const token = createSessionToken(1, "session-secret", 1_000);
    expect(verifySessionToken(token, "session-secret", 2_000)?.user).toBe(1);
    expect(verifySessionToken(`${token}x`, "session-secret", 2_000)).toBeNull();
    expect(verifySessionToken(token, "session-secret", 31 * 24 * 60 * 60 * 1000)).toBeNull();
  });

  it("encrypts and decrypts message content", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const encrypted = encryptContent("晚安，明天见。", key);
    expect(encrypted.cipher).not.toContain("晚安");
    expect(decryptContent(encrypted.cipher, encrypted.iv, key)).toBe("晚安，明天见。");
  });
});
