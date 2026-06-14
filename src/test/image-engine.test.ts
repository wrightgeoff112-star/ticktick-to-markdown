import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createHash,
  pbkdf2Sync,
} from "node:crypto";
import { test } from "node:test";

import { decryptChromeCookieValue } from "../lib/image-engine.js";

/** Encrypt a value the way Chrome (v10/v11) does, to round-trip the decryptor. */
function encryptLikeChrome(
  plaintext: string,
  password: string,
  hostKey?: string,
): Buffer {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  const cipher = createCipheriv("aes-128-cbc", key, iv);

  const prefix = hostKey
    ? createHash("sha256").update(hostKey).digest()
    : Buffer.alloc(0);
  const body = Buffer.concat([prefix, Buffer.from(plaintext, "utf8")]);
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([Buffer.from("v11", "utf8"), encrypted]);
}

test("round-trips a Chrome v11 cookie without host prefix", () => {
  const password = "s3cr3t-safe-storage";
  const value = "login-token-abcdef";
  const enc = encryptLikeChrome(value, password);
  assert.equal(decryptChromeCookieValue(enc, password), value);
});

test("round-trips a Chrome v11 cookie with the host_key SHA-256 prefix", () => {
  const password = "another-key";
  const value = "t=cookievalue";
  const hostKey = ".dida365.com";
  const enc = encryptLikeChrome(value, password, hostKey);
  assert.equal(decryptChromeCookieValue(enc, password, hostKey), value);
});

test("returns empty string for empty buffer", () => {
  assert.equal(decryptChromeCookieValue(Buffer.alloc(0), "x"), "");
});
