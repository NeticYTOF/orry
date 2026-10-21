/* Which identity providers are on: Hack Club Auth when ORRY_HCA_CLIENT_ID and ORRY_HCA_CLIENT_SECRET are set,
   and the dev provider when ORRY_DEV_AUTH=1. */
import { baseUrl, devAuthEnabled, hcaConfig } from "./config";
import { DEV_CLIENT_ID, devClientSecret, devIssuer } from "./dev-idp";
import { OidcProvider, type IdentityProvider } from "./oidc";

export const redirectUri = () => baseUrl() + "/auth/callback";

const G = globalThis as unknown as { __orryProviders?: Map<string, IdentityProvider> };
const cache = (G.__orryProviders ??= new Map());

export function getProvider(id: string): IdentityProvider | null {
  if (id === "hca") {
    const c = hcaConfig();
    if (!c) return null;
    const k = "hca:" + c.issuer + ":" + c.clientId;
    if (!cache.has(k)) cache.set(k, new OidcProvider({ id: "hca", label: "Hack Club", issuer: c.issuer, clientId: c.clientId, clientSecret: c.clientSecret }));
    return cache.get(k)!;
  }
  if (id === "dev") {
    if (!devAuthEnabled()) return null;
    const iss = devIssuer();
    const k = "dev:" + iss;
    if (!cache.has(k)) cache.set(k, new OidcProvider({
      id: "dev", label: "Dev Hack Club (local)", issuer: iss, clientId: DEV_CLIENT_ID, clientSecret: devClientSecret(),
      authorizationEndpoint: iss + "/authorize", tokenEndpoint: iss + "/token", jwksUri: iss + "/jwks", userinfoEndpoint: iss + "/userinfo"
    }));
    return cache.get(k)!;
  }
  return null;
}

/** The provider behind "Sign in with Hack Club": the real one when configured, else the dev stand-in. */
export function primaryProviderId(): "hca" | "dev" | null {
  if (hcaConfig()) return "hca";
  if (devAuthEnabled()) return "dev";
  return null;
}
