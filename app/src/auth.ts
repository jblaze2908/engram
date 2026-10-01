// Your web sign-in: one scrypt password, first run gated by a setup-token file, sessions stored only as hashes.
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ROOT, now, httpErr } from "./config.js";
import { one, run, getSetting, setSetting } from "./db.js";
import { trace, YOU } from "./trace.js";

const SESSION_MS = 30 * 24 * 3600 * 1000;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 << 20 };
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function fileSecret(name: string, bytes: number) {
  const p = join(ROOT, name);
  if (!existsSync(p)) writeFileSync(p, randomBytes(bytes).toString("base64url"), { mode: 0o600 });
  return readFileSync(p, "utf8").trim();
}
// Upstream credentials arrive with M2; the key exists from first boot so it never has to be introduced later.
export const ensureMasterKey = () => { fileSecret("master.key", 32); };

export const setupDone = () => !!getSetting("password");
export function ensureSetupToken() { if (!setupDone()) fileSecret("setup-token", 18); }

export function setupPassword(token: unknown, password: unknown) {
  if (setupDone()) throw httpErr(409, "Already set up");
  if (!existsSync(join(ROOT, "setup-token")) || !safeEq(token, fileSecret("setup-token", 18))) throw httpErr(403, "Setup token doesn't match");
  setPassword(password);
  rmSync(join(ROOT, "setup-token"), { force: true });
  trace(YOU, "setup", "password");
}

export function setPassword(password: unknown) {
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) throw httpErr(400, "Use at least 12 characters");
  const salt = randomBytes(16);
  setSetting("password", `scrypt$${salt.toString("base64url")}$${scryptSync(password, salt, 64, SCRYPT).toString("base64url")}`);
}

// Global, not per IP: there is one account, and behind the proxy every caller looks alike.
let failures: number[] = [];
export function checkPassword(password: unknown) {
  const t = now();
  failures = failures.filter((f) => t - f < 15 * 60 * 1000);
  if (failures.length >= 10) throw httpErr(429, "Too many attempts. Try again in 15 minutes.");
  const [, salt, hash] = (getSetting("password") || "").split("$");
  const ok = !!salt && typeof password === "string" && password.length <= 1024 &&
    timingSafeEqual(scryptSync(password, Buffer.from(salt, "base64url"), 64, SCRYPT), Buffer.from(hash, "base64url"));
  if (!ok) { failures.push(t); trace({ id: null, name: "anon" }, "login", "password", "refused"); throw httpErr(401, "Wrong password"); }
  failures = [];
}

export function newSession() {
  const token = randomBytes(32).toString("base64url");
  run("INSERT INTO sessions(hash,created_at,expires_at) VALUES(?,?,?)", sha(token), now(), now() + SESSION_MS);
  run("DELETE FROM sessions WHERE expires_at < ?", now());
  return token;
}
export const sessionValid = (token: string | undefined) => !!token && !!one("SELECT 1 FROM sessions WHERE hash=? AND expires_at>?", sha(token), now());
export const endSession = (token: string | undefined) => { if (token) run("DELETE FROM sessions WHERE hash=?", sha(token)); };

export function safeEq(a: unknown, b: string) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
