/* The dev identity provider: a small OpenID Connect server inside the app, standing in for Hack Club Auth when
   ORRY_DEV_AUTH=1. Its accounts are invented (one per person in lib/data/fixtures/people.ts, plus one with no
   Slack link). The site signs in through it with the same OidcProvider code it uses for Hack Club. Its keys,
   client secret and codes live in memory and change at every server start. */
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { PEOPLE } from "../data/fixtures/people";
import { baseUrl } from "./config";
import { randomToken } from "./crypto";

export type DevAccount = { sub: string; slackId: string | null; name: string; handle: string | null; note?: string };

export const DEV_ACCOUNTS: DevAccount[] = [
  ...PEOPLE.map(p => ({ sub: "dev-hca-" + p.id.toLowerCase(), slackId: p.id, name: p.name, handle: p.handle })),
  { sub: "dev-hca-no-slack", slackId: null, name: "Robin Unlinked", handle: null, note: "No Slack account linked" }
];
export const devAccount = (sub: string) => DEV_ACCOUNTS.find(a => a.sub === sub) ?? null;

export const DEV_CLIENT_ID = "orry-site-dev";
export const devIssuer = () => baseUrl() + "/dev-idp";
export const devRedirectUri = () => baseUrl() + "/auth/callback";

type State = {
  key: { privateKey: CryptoKey; publicJwk: JWK } | null;
  secret: string;
  codes: Map<string, { sub: string; nonce: string; redirectUri: string; exp: number }>;
  tokens: Map<string, { sub: string; exp: number }>;
};
const G = globalThis as unknown as { __orryDevIdp?: State };
const st = (G.__orryDevIdp ??= { key: null, secret: randomToken(24), codes: new Map(), tokens: new Map() });

export const devClientSecret = () => st.secret;

async function key() {
  if (!st.key) {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = { ...(await exportJWK(publicKey)), kid: "dev-" + randomToken(6), alg: "RS256", use: "sig" };
    st.key = { privateKey, publicJwk };
  }
  return st.key;
}

export async function devJwks(): Promise<{ keys: JWK[] }> {
  return { keys: [(await key()).publicJwk] };
}

export type AuthorizeParams = { clientId: string; redirectUri: string; state: string; nonce: string; responseType: string };
export function checkAuthorize(p: AuthorizeParams): string | null {
  if (p.responseType !== "code") return "response_type must be code";
  if (p.clientId !== DEV_CLIENT_ID) return "unknown client_id";
  if (p.redirectUri !== devRedirectUri()) return "redirect_uri is not registered";
  if (!p.state || !p.nonce) return "state and nonce are required";
  return null;
}

/** Issues a one-time code for the chosen account and returns the redirect back to the site. */
export function issueCode(p: AuthorizeParams, sub: string): string {
  const now = Date.now();
  for (const [c, v] of st.codes) if (v.exp < now) st.codes.delete(c);
  const code = randomToken(24);
  st.codes.set(code, { sub, nonce: p.nonce, redirectUri: p.redirectUri, exp: now + 60_000 });
  const u = new URL(p.redirectUri);
  u.searchParams.set("code", code);
  u.searchParams.set("state", p.state);
  return u.toString();
}

export async function exchangeCode(f: { grantType: string; code: string; redirectUri: string; clientId: string; clientSecret: string }) {
  if (f.grantType !== "authorization_code") return { error: "unsupported_grant_type" as const };
  if (f.clientId !== DEV_CLIENT_ID || f.clientSecret !== st.secret) return { error: "invalid_client" as const };
  const c = st.codes.get(f.code);
  st.codes.delete(f.code); /* single use, even when it fails */
  if (!c || c.exp < Date.now() || c.redirectUri !== f.redirectUri) return { error: "invalid_grant" as const };
  const acct = devAccount(c.sub);
  if (!acct) return { error: "invalid_grant" as const };
  const k = await key();
  const claims: Record<string, unknown> = { nonce: c.nonce, name: acct.name };
  if (acct.slackId) claims.slack_id = acct.slackId;
  const idToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: k.publicJwk.kid })
    .setIssuer(devIssuer())
    .setAudience(DEV_CLIENT_ID)
    .setSubject(acct.sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(k.privateKey);
  const access = randomToken(24);
  st.tokens.set(access, { sub: acct.sub, exp: Date.now() + 5 * 60_000 });
  return { ok: { id_token: idToken, access_token: access, token_type: "Bearer", expires_in: 300 } };
}

export function devUserinfo(accessToken: string) {
  const t = st.tokens.get(accessToken);
  if (!t || t.exp < Date.now()) return null;
  const acct = devAccount(t.sub);
  if (!acct) return null;
  return { sub: acct.sub, name: acct.name, ...(acct.slackId ? { slack_id: acct.slackId } : {}) };
}
