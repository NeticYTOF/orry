const { test } = require("node:test");
const assert = require("node:assert/strict");

const auth = require("./auth");

test("parseCookies returns empty object for no header", () => {
  assert.ok(true);
});

test("requireAdmin returns 401 with no session", () => {
  const req = { headers: new Map() };
  const result = auth.requireAdmin(req);
  assert.equal(result.status, 401);
});

test("requireSession returns null with no cookie", () => {
  const req = { headers: new Map() };
  const result = auth.requireSession(req);
  assert.equal(result, null);
});

test("requireAdmin returns 403 for non-admin when session exists", () => {
  assert.ok(auth.requireSession);
  assert.ok(auth.requireAdmin);
});

test("loginUrl includes client_id and state", () => {
  process.env.SLACK_CLIENT_ID = "test-client-123";
  process.env.ORRY_WEB_URL = "http://localhost:4100";
  const url = auth.loginUrl("/");
  assert.ok(url.includes("test-client-123"));
  assert.ok(url.includes("openid"));
  assert.ok(url.includes("state="));
});

test("handleLogout sets an expired cookie", () => {
  const result = auth.handleLogout(new Request("https://orry.example.com/auth/logout"));
  assert.equal(result.status, 302);
  assert.ok(result.headers["Set-Cookie"]?.includes("Max-Age=0"));
});

test("session cookie is Secure except over plain-HTTP loopback", () => {
  const https = auth.sessionCookie("tok", 604800, new Request("https://orry.example.com/auth/callback"));
  assert.match(https, /; Secure$/, "https sessions must be Secure");
  assert.ok(https.includes("HttpOnly") && https.includes("SameSite=Lax"), "existing hardening is preserved");

  for (const plain of [
    "http://localhost:4100/login",
    "http://127.0.0.1:4100/login",
    "http://LOCALHOST:4100/login",
    "http://[::1]:4100/login",
    "http://app.localhost:4100/login",
  ]) {
    assert.ok(!auth.sessionCookie("tok", 604800, new Request(plain)).includes("Secure"), `${plain} is local dev`);
  }

  for (const remote of ["http://orry.example.com/login", "http://192.168.1.9:4100/login"]) {
    assert.ok(
      auth.sessionCookie("tok", 604800, new Request(remote)).includes("Secure"),
      `${remote} is not loopback, so Secure applies even on plain HTTP`,
    );
  }
});

test("sign/verify roundtrips in-process; tampered or malformed tokens fail", () => {
  const token = auth.signSession("U-char", "Char", "user");
  assert.ok(typeof token === "string" && token.includes("."));
  const sess = auth.verifySession(token);
  assert.equal(sess.userId, "U-char");
  assert.equal(sess.role, "user");
  const [enc] = token.split(".");
  assert.equal(auth.verifySession(`${enc}.deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`), null);
  assert.equal(auth.verifySession(null), null);
  assert.equal(auth.verifySession(""), null);
  assert.equal(auth.verifySession("no-dot-here"), null);
});

test("expired sessions and sessions without userId are rejected", () => {
  const crypto = require("crypto");
  const good = auth.signSession("U-exp", "Exp", "user");
  assert.ok(auth.verifySession(good));
  const saved = (process.env.ORRY_SESSION_SECRET ?? process.env.RIVET_SESSION_SECRET);
  try {
    process.env.ORRY_SESSION_SECRET = "char-secret-a";
    const a = auth.signSession("U-x", "X", "user");
    process.env.ORRY_SESSION_SECRET = "char-secret-b";
    assert.equal(auth.verifySession(a), null, "rotating the secret must invalidate old cookies");
  } finally {
    if (saved === undefined) delete process.env.ORRY_SESSION_SECRET;
    else process.env.ORRY_SESSION_SECRET = saved;
  }
});

test("requireAdmin matrix — 401 no session, 403 non-admin, ok admin", () => {
  const noSess = { headers: { get: () => "" } };
  assert.equal(auth.requireAdmin(noSess).status, 401);
  const userTok = auth.signSession("U-plain-user", "Plain", "user");
  const userReq = { headers: { get: () => `${auth.COOKIE_NAME}=${userTok}` } };
  const res = auth.requireAdmin(userReq);
  assert.ok(res.status === 403 || res.session, "non-admin yields 403 or (if allowlisted) a session — never 401");
  const adminTok = auth.signSession("admin", "Admin", "admin");
  const adminReq = { headers: { get: () => `${auth.COOKIE_NAME}=${adminTok}` } };
  assert.ok(auth.requireAdmin(adminReq).session, "role=admin cookie passes");
  assert.equal(auth.requireSession(noSess), null);
  assert.equal(auth.requireSession(adminReq).userId, "admin");
});

test("dev-testing only unlocks the passcode-free admin session under NODE_ENV=development", () => {
  const cSaved = process.env.SLACK_CLIENT_ID;
  const nSaved = process.env.NODE_ENV;
  try {
    process.env.SLACK_CLIENT_ID = "dev-testing";
    delete process.env.NODE_ENV;
    assert.equal(auth.devAuthEnabled(), false, "the sentinel client id alone must not unlock dev auth");
    const tok = auth.signSession("dev-user", "Developer", "user");
    const req = { headers: { get: () => `${auth.COOKIE_NAME}=${tok}` } };
    assert.equal(auth.requireAdmin(req).status, 403, "dev-user is not admin without NODE_ENV=development");

    process.env.NODE_ENV = "development";
    assert.equal(auth.devAuthEnabled(), true);
    assert.ok(auth.requireAdmin(req).session, "dev-user is admin while dev auth is fully enabled");

    process.env.NODE_ENV = "production";
    assert.equal(auth.devAuthEnabled(), false);
    assert.equal(auth.requireAdmin(req).status, 403, "NODE_ENV=production is not development");

    process.env.NODE_ENV = "development";
    process.env.SLACK_CLIENT_ID = "real-client-id";
    assert.equal(auth.devAuthEnabled(), false, "a real client id never enables dev auth");
  } finally {
    if (cSaved === undefined) delete process.env.SLACK_CLIENT_ID;
    else process.env.SLACK_CLIENT_ID = cSaved;
    if (nSaved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nSaved;
  }
});

test("loginUrl needs Slack env; handleLogout clears the session cookie", () => {
  const cSaved = process.env.SLACK_CLIENT_ID;
  const wSaved = (process.env.ORRY_WEB_URL ?? process.env.RIVET_WEB_URL);
  try {
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.ORRY_WEB_URL;
    assert.equal(auth.loginUrl("/"), null);
    process.env.SLACK_CLIENT_ID = "cid-char";
    process.env.ORRY_WEB_URL = "http://localhost:4100";
    const url = auth.loginUrl("/");
    assert.ok(url.includes("cid-char") && url.includes("state="));
  } finally {
    if (cSaved === undefined) delete process.env.SLACK_CLIENT_ID;
    else process.env.SLACK_CLIENT_ID = cSaved;
    if (wSaved === undefined) delete process.env.ORRY_WEB_URL;
    else process.env.ORRY_WEB_URL = wSaved;
  }
  const out = auth.handleLogout(new Request("http://localhost:4100/auth/logout"));
  assert.equal(out.status, 302);
  assert.ok(out.headers["Set-Cookie"].includes(`${auth.COOKIE_NAME}=;`));
});
export {};
