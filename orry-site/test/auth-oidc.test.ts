/* The OpenID Connect client (PLAN 7.2 step 2) against a local fake OIDC server on a random port, and the
   in-app dev identity provider through the same client. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { OidcError, OidcProvider } from "../lib/auth/oidc";

type Mode = { aud?: string; nonce?: string | null; exp?: number; iss?: string; slackInToken?: boolean; slackOnUserinfo?: boolean; signWith?: "good" | "other"; alg?: "RS256" | "HS256"; tokenStatus?: number };

let server: http.Server, base = "";
let good: { privateKey: CryptoKey; jwk: JWK }, other: { privateKey: CryptoKey };
let mode: Mode = {};
let lastNonce = "";
const CLIENT = "orry-site-test", SECRET = "test-secret";

beforeAll(async () => {
  const k = await generateKeyPair("RS256", { extractable: true });
  good = { privateKey: k.privateKey, jwk: { ...(await exportJWK(k.publicKey)), kid: "k1", alg: "RS256", use: "sig" } };
  other = { privateKey: (await generateKeyPair("RS256")).privateKey };
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const send = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/oauth/discovery/keys") return send(200, { keys: [good.jwk] });
    if (url.pathname === "/oauth/userinfo") {
      if (req.headers.authorization !== "Bearer at-1") return send(401, { error: "invalid_token" });
      return send(200, { sub: "hca-123", ...(mode.slackOnUserinfo ? { slack_id: "U0JUNO001" } : {}) });
    }
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      let body = ""; for await (const c of req) body += c;
      const f = new URLSearchParams(body);
      if (mode.tokenStatus) return send(mode.tokenStatus, { error: "invalid_grant" });
      if (f.get("client_id") !== CLIENT || f.get("client_secret") !== SECRET || f.get("code") !== "code-1" || f.get("grant_type") !== "authorization_code") return send(400, { error: "invalid_grant" });
      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = {};
      if (mode.nonce !== null) claims.nonce = mode.nonce ?? lastNonce;
      if (mode.slackInToken !== false) claims.slack_id = "U0JUNO001";
      let jwt = new SignJWT(claims).setIssuer(mode.iss ?? base).setAudience(mode.aud ?? CLIENT).setSubject("hca-123").setIssuedAt(now).setExpirationTime(mode.exp ?? now + 300);
      let token: string;
      if (mode.alg === "HS256") token = await jwt.setProtectedHeader({ alg: "HS256", kid: "k1" }).sign(new TextEncoder().encode("x".repeat(32)));
      else token = await jwt.setProtectedHeader({ alg: "RS256", kid: "k1" }).sign(mode.signWith === "other" ? other.privateKey : good.privateKey);
      return send(200, { id_token: token, access_token: "at-1", token_type: "Bearer" });
    }
    send(404, {});
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const provider = () => new OidcProvider({ id: "hca", label: "Hack Club", issuer: base, clientId: CLIENT, clientSecret: SECRET });
async function run(m: Mode, nonce = "nonce-abc") {
  mode = m; lastNonce = nonce;
  return provider().callback({ code: "code-1", nonce, redirectUri: "http://localhost:9995/auth/callback" });
}
async function failsWith(m: Mode, code: OidcError["code"], nonce?: string) {
  const e = await run(m, nonce).then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(OidcError);
  expect((e as OidcError).code).toBe(code);
}

describe("OidcProvider against a fake OIDC server", () => {
  it("builds the authorize URL with code flow, openid slack_id, state and nonce", () => {
    const u = new URL(provider().authorizeUrl({ state: "s1", nonce: "n1", redirectUri: "http://localhost:9995/auth/callback" }));
    expect(u.origin + u.pathname).toBe(base + "/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: "code", client_id: CLIENT, scope: "openid slack_id", state: "s1", nonce: "n1", redirect_uri: "http://localhost:9995/auth/callback" });
  });

  it("accepts a good ID token and returns sub and slack_id", async () => {
    await expect(run({})).resolves.toEqual({ sub: "hca-123", slackId: "U0JUNO001" });
  });

  it("reads slack_id from userinfo once when it is not in the ID token", async () => {
    await expect(run({ slackInToken: false, slackOnUserinfo: true })).resolves.toEqual({ sub: "hca-123", slackId: "U0JUNO001" });
    await expect(run({ slackInToken: false, slackOnUserinfo: false })).resolves.toEqual({ sub: "hca-123", slackId: null });
  });

  it("refuses a bad audience", () => failsWith({ aud: "someone-else" }, "bad_token"));
  it("refuses a bad nonce", () => failsWith({ nonce: "not-this-one" }, "bad_nonce"));
  it("refuses a missing nonce", () => failsWith({ nonce: null }, "bad_nonce"));
  it("refuses an expired token", () => failsWith({ exp: Math.floor(Date.now() / 1000) - 120 }, "bad_token"));
  it("refuses a bad signature", () => failsWith({ signWith: "other" }, "bad_token"));
  it("refuses a token from another issuer", () => failsWith({ iss: "https://evil.example" }, "bad_token"));
  it("refuses HS256 (only RS256 is allowed)", () => failsWith({ alg: "HS256" }, "bad_token"));
  it("reports a failed code exchange", () => failsWith({ tokenStatus: 400 }, "token_exchange"));
});

describe("the dev identity provider through the same client", () => {
  it("issues a code for a fake account, and the client checks the RS256 ID token", async () => {
    process.env.ORRY_DEV_AUTH = "1";
    const idp = await import("../lib/auth/dev-idp");
    const iss = idp.devIssuer();
    const p = { clientId: idp.DEV_CLIENT_ID, redirectUri: idp.devRedirectUri(), state: "st", nonce: "nn", responseType: "code" };
    expect(idp.checkAuthorize(p)).toBeNull();
    expect(idp.checkAuthorize({ ...p, redirectUri: "https://evil.example/cb" })).toMatch(/redirect_uri/);
    const back = new URL(idp.issueCode(p, "dev-hca-u0juno001"));
    expect(back.searchParams.get("state")).toBe("st");
    const code = back.searchParams.get("code")!;

    /* route the client's HTTP calls to the dev IdP functions, as the in-app routes do */
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === iss + "/token") {
        const f = new URLSearchParams(String(init!.body));
        const out = await idp.exchangeCode({ grantType: f.get("grant_type")!, code: f.get("code")!, redirectUri: f.get("redirect_uri")!, clientId: f.get("client_id")!, clientSecret: f.get("client_secret")! });
        return new Response(JSON.stringify("error" in out ? out : out.ok), { status: "error" in out ? 400 : 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const client = new OidcProvider({
      id: "dev", label: "dev", issuer: iss, clientId: idp.DEV_CLIENT_ID, clientSecret: idp.devClientSecret(),
      tokenEndpoint: iss + "/token", jwks: createLocalJWKSet(await idp.devJwks()), fetchImpl
    });
    await expect(client.callback({ code, nonce: "nn", redirectUri: idp.devRedirectUri() })).resolves.toEqual({ sub: "dev-hca-u0juno001", slackId: "U0JUNO001" });
    /* a code works once */
    await expect(client.callback({ code, nonce: "nn", redirectUri: idp.devRedirectUri() })).rejects.toMatchObject({ code: "token_exchange" });
    /* the account with no Slack link comes back with slackId null */
    const c2 = new URL(idp.issueCode(p, "dev-hca-no-slack")).searchParams.get("code")!;
    await expect(client.callback({ code: c2, nonce: "nn", redirectUri: idp.devRedirectUri() })).resolves.toEqual({ sub: "dev-hca-no-slack", slackId: null });
    /* a wrong nonce is refused here too */
    const c3 = new URL(idp.issueCode(p, "dev-hca-u0juno001")).searchParams.get("code")!;
    await expect(client.callback({ code: c3, nonce: "other", redirectUri: idp.devRedirectUri() })).rejects.toMatchObject({ code: "bad_nonce" });
  });
});
