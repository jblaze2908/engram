import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, req, close, gitLog } from "./_env.mjs";

after(close);

test("first boot: committed vault with areas and empty profile, no facts", () => {
  assert.deepEqual(gitLog(), ["engram: new vault"]);
  for (const f of ["areas/money.md", "areas/building.md", "profile/money.md", "profile/working-style.md"]) assert.ok(existsSync(join(ROOT, "vault", f)), f);
  assert.ok(existsSync(join(ROOT, "master.key")));
});

test("setup, login, session, logout", async () => {
  assert.deepEqual((await req("GET", "/api/session")).json, { setup: false, authed: false });
  assert.equal((await req("GET", "/api/status")).status, 401);

  assert.equal((await req("POST", "/api/setup", { token: "wrong", password: "long enough password" })).status, 403);
  const { readFileSync } = await import("node:fs");
  const token = readFileSync(join(ROOT, "setup-token"), "utf8").trim();
  assert.equal((await req("POST", "/api/setup", { token, password: "short" })).status, 400);
  // Without the CSRF header a mutation is refused before anything else.
  assert.equal((await req("POST", "/api/setup", { token, password: "long enough password" }, { csrf: false })).status, 403);
  const s = await req("POST", "/api/setup", { token, password: "long enough password" });
  assert.equal(s.status, 200);
  const cookie = s.headers.get("set-cookie");
  assert.match(cookie, /eg_s=[\w-]{43}; .*HttpOnly; Secure; SameSite=Strict/);
  assert.ok(!existsSync(join(ROOT, "setup-token")), "setup token is removed once used");

  assert.equal((await req("POST", "/api/setup", { token, password: "long enough password" })).status, 409);
  const c = cookie.split(";")[0];
  assert.deepEqual((await req("GET", "/api/session", undefined, { cookie: c })).json, { setup: true, authed: true });
  assert.equal((await req("GET", "/api/status", undefined, { cookie: c })).status, 200);

  assert.equal((await req("POST", "/api/login", { password: "not the password" })).status, 401);
  const l = await req("POST", "/api/login", { password: "long enough password" });
  assert.equal(l.status, 200);
  const c2 = l.headers.get("set-cookie").split(";")[0];

  assert.equal((await req("POST", "/api/logout", {}, { cookie: c2 })).status, 200);
  assert.equal((await req("GET", "/api/status", undefined, { cookie: c2 })).status, 401);
  assert.equal((await req("GET", "/api/status", undefined, { cookie: c })).status, 200, "other sessions survive");
});

test("cross-origin mutation is refused even with the header", async () => {
  const r = await req("POST", "/api/login", { password: "x" }, { headers: { origin: "https://evil.example" } });
  assert.equal(r.status, 403);
});

test("the privacy policy is public: Google's consent screen links to it", async () => {
  const r = await req("GET", "/privacy");
  assert.equal(r.status, 200);
  assert.match(r.text, /Limited Use requirements/);
  assert.match(r.text, /never sends mail/);
});
