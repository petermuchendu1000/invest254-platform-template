import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  loadEncKey, isEncryptionConfigured, encryptSecrets, decryptSecrets, last4, CURRENT_ENC_VERSION,
} from "./providercrypto.js";

const keyB64 = randomBytes(32).toString("base64");
const keyHex = randomBytes(32).toString("hex");
const env = (v?: string) => ({ PAYMENTS_CONFIG_ENC_KEY: v } as unknown as NodeJS.ProcessEnv);

test("loadEncKey accepts 32-byte base64 and hex, rejects wrong length / junk", () => {
  assert.equal(loadEncKey(env(keyB64))!.length, 32);
  assert.equal(loadEncKey(env(keyHex))!.length, 32);
  assert.equal(loadEncKey(env("")), null);
  assert.equal(loadEncKey(env(undefined)), null);
  assert.equal(loadEncKey(env("too-short")), null);
  assert.equal(loadEncKey(env(randomBytes(16).toString("base64"))), null); // 16 bytes
  assert.equal(isEncryptionConfigured(env(keyB64)), true);
  assert.equal(isEncryptionConfigured(env("")), false);
});

test("encrypt -> decrypt round-trips the secret map and drops blanks", () => {
  const e = env(keyB64);
  const { ciphertext, meta, encVersion } = encryptSecrets({ api_key: "MGPYsecretVALUE123", email_ignored: "   " }, e);
  assert.equal(encVersion, CURRENT_ENC_VERSION);
  assert.ok(ciphertext.length > 0);
  // blank field dropped, no meta for it
  assert.deepEqual(Object.keys(meta), ["api_key"]);
  assert.deepEqual(meta.api_key, { set: true, last4: "E123" });
  const back = decryptSecrets(ciphertext, e);
  assert.deepEqual(back, { api_key: "MGPYsecretVALUE123" });
});

test("empty secret map yields empty ciphertext (nothing to store)", () => {
  const { ciphertext, meta } = encryptSecrets({ a: "", b: "  " }, env(keyB64));
  assert.equal(ciphertext, "");
  assert.deepEqual(meta, {});
});

test("last4 never reveals more than half of a short secret", () => {
  assert.equal(last4("abcdefgh"), "efgh"); // len 8 -> ok
  assert.equal(last4("short"), "");          // len 5 -> fully masked
});

test("decrypt with the WRONG key fails loudly (GCM auth) — never returns garbage", () => {
  const { ciphertext } = encryptSecrets({ api_key: "topsecretvalue99" }, env(keyB64));
  assert.throws(() => decryptSecrets(ciphertext, env(keyHex)));
});

test("tampered ciphertext is rejected (GCM tag)", () => {
  const { ciphertext } = encryptSecrets({ api_key: "topsecretvalue99" }, env(keyB64));
  const buf = Buffer.from(ciphertext, "base64"); buf[buf.length - 1] = (buf[buf.length - 1] as number) ^ 0xff; // flip a tag bit
  assert.throws(() => decryptSecrets(buf.toString("base64"), env(keyB64)));
});

test("encrypt/decrypt without a key throws ENC_KEY_NOT_CONFIGURED; decrypt('') -> {}", () => {
  assert.throws(() => encryptSecrets({ a: "x" }, env("")), /ENC_KEY_NOT_CONFIGURED/);
  assert.throws(() => decryptSecrets("abc", env("")), /ENC_KEY_NOT_CONFIGURED/);
  assert.deepEqual(decryptSecrets("", env(keyB64)), {});
  assert.deepEqual(decryptSecrets(null, env(keyB64)), {});
});

test("two encryptions of the same value differ (random IV) but both decrypt equal", () => {
  const e = env(keyB64);
  const a = encryptSecrets({ k: "sameValue1234" }, e).ciphertext;
  const b = encryptSecrets({ k: "sameValue1234" }, e).ciphertext;
  assert.notEqual(a, b);
  assert.deepEqual(decryptSecrets(a, e), decryptSecrets(b, e));
});
