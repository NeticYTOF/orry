/* OpenID Connect sign-in (PLAN 7.2). One client for Hack Club Auth and for the local dev identity provider:
   both sit behind IdentityProvider. ID tokens are checked against the issuer's JWKS: RS256 signature, iss, aud,
   exp and nonce. The site keeps only the `sub` and the Slack ID; access and refresh tokens are dropped. */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { timingSafeEqual } from "node:crypto";

export type Identity = { sub: string; slackId: string | null };

export interface IdentityProvider {
  readonly id: "hca" | "dev";
  readonly label: string;
  /** The URL to send the browser to. */
  authorizeUrl(p: { state: string; nonce: string; redirectUri: string; loginHint?: string }): string;
  /** Exchanges the code and returns the checked identity. Throws OidcError on any failure. */
  callback(p: { code: string; nonce: string; redirectUri: string }): Promise<Identity>;
}

export class OidcError extends Error {
  constructor(public code: "token_exchange" | "bad_token" | "bad_nonce" | "no_sub" | "userinfo", message: string) {
    super(message);
    this.name = "OidcError";
  }
}

export type OidcConfig = {
  id: "hca" | "dev";
  label: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  jwksUri?: string;
  userinfoEndpoint?: string;
  scope?: string;
  /** Tests: a fixed key set instead of fetching the JWKS. */
  jwks?: JWTVerifyGetKey;
  fetchImpl?: typeof fetch;
};

/** Validates an ID token. Exported for tests and for the dev provider. */
export async function validateIdToken(
  token: string,
  o: { jwks: JWTVerifyGetKey; issuer: string; audience: string; nonce: string; now?: number }
): Promise<JWTPayload> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, o.jwks, {
      issuer: o.issuer,
      audience: o.audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "sub"],
      clockTolerance: 30,
      ...(o.now ? { currentDate: new Date(o.now) } : {})
    }));
  } catch (e) {
    throw new OidcError("bad_token", "The ID token did not check out: " + (e as Error & { code?: string }).code);
  }
  const got = typeof payload.nonce === "string" ? Buffer.from(payload.nonce) : Buffer.alloc(0);
  const want = Buffer.from(o.nonce);
  if (!o.nonce || got.length !== want.length || !timingSafeEqual(got, want)) throw new OidcError("bad_nonce", "The ID token's nonce does not match this sign-in.");
  if (typeof payload.sub !== "string" || !payload.sub) throw new OidcError("no_sub", "The ID token has no subject.");
  return payload;
}

const pickSlack = (o: Record<string, unknown> | null | undefined): string | null => {
  const v = o?.slack_id;
  return typeof v === "string" && v ? v : null;
};

export class OidcProvider implements IdentityProvider {
  readonly id: "hca" | "dev";
  readonly label: string;
  private cfg: Required<Omit<OidcConfig, "jwks" | "fetchImpl">> & Pick<OidcConfig, "jwks" | "fetchImpl">;
  private keySet: JWTVerifyGetKey | null = null;

  constructor(c: OidcConfig) {
    const iss = c.issuer.replace(/\/+$/, "");
    this.id = c.id;
    this.label = c.label;
    /* Hack Club Auth's endpoints (R10 §8.1). The dev provider passes its own. */
    this.cfg = {
      ...c,
      issuer: iss,
      authorizationEndpoint: c.authorizationEndpoint ?? iss + "/oauth/authorize",
      tokenEndpoint: c.tokenEndpoint ?? iss + "/oauth/token",
      jwksUri: c.jwksUri ?? iss + "/oauth/discovery/keys",
      userinfoEndpoint: c.userinfoEndpoint ?? iss + "/oauth/userinfo",
      scope: c.scope ?? "openid slack_id"
    };
  }

  private jwks(): JWTVerifyGetKey {
    if (this.cfg.jwks) return this.cfg.jwks;
    if (!this.keySet) this.keySet = createRemoteJWKSet(new URL(this.cfg.jwksUri), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
    return this.keySet;
  }

  authorizeUrl(p: { state: string; nonce: string; redirectUri: string; loginHint?: string }): string {
    const u = new URL(this.cfg.authorizationEndpoint);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("redirect_uri", p.redirectUri);
    u.searchParams.set("scope", this.cfg.scope);
    u.searchParams.set("state", p.state);
    u.searchParams.set("nonce", p.nonce);
    if (p.loginHint) u.searchParams.set("login_hint", p.loginHint);
    return u.toString();
  }

  async callback(p: { code: string; nonce: string; redirectUri: string }): Promise<Identity> {
    const f = this.cfg.fetchImpl ?? fetch;
    let tok: { id_token?: unknown; access_token?: unknown };
    try {
      const r = await f(this.cfg.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: p.code,
          redirect_uri: p.redirectUri,
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000)
      });
      if (!r.ok) throw new Error("status " + r.status);
      tok = await r.json();
    } catch (e) {
      throw new OidcError("token_exchange", "The code could not be exchanged: " + (e as Error).message);
    }
    if (typeof tok.id_token !== "string") throw new OidcError("bad_token", "No ID token came back.");
    const claims = await validateIdToken(tok.id_token, { jwks: this.jwks(), issuer: this.cfg.issuer, audience: this.cfg.clientId, nonce: p.nonce });

    let slackId = pickSlack(claims as Record<string, unknown>);
    /* If the claim is only on userinfo, ask once at sign-in, then never again for this person (7.2 steps 3-4). */
    if (!slackId && typeof tok.access_token === "string") {
      try {
        const r = await f(this.cfg.userinfoEndpoint, {
          headers: { Authorization: "Bearer " + tok.access_token, Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(10_000)
        });
        if (r.ok) {
          const info = (await r.json()) as Record<string, unknown>;
          if (info.sub === claims.sub) slackId = pickSlack(info);
        }
      } catch {
        /* treated as no Slack ID below */
      }
    }
    return { sub: claims.sub as string, slackId };
  }
}
