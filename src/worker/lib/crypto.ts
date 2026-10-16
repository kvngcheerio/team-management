// Password hashing with WebCrypto PBKDF2-SHA256 (native, so it stays within Workers CPU limits).
// Cloudflare caps PBKDF2 at 100,000 iterations.
const ITERATIONS = 100_000;
const enc = new TextEncoder();

const toB64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2_sha256$${ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [alg, iter, saltB64, hashB64] = stored.split("$");
  if (alg !== "pbkdf2_sha256" || !iter || !saltB64 || !hashB64) return false;
  const actual = new Uint8Array(await derive(password, fromB64(saltB64), Number(iter)));
  return timingSafeEqual(actual, fromB64(hashB64));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function safeStringEqual(a: string, b: string): boolean {
  return timingSafeEqual(enc.encode(a), enc.encode(b));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** URL-safe random token. */
export function randomToken(bytes = 24): string {
  return toB64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
