/* Every route the site serves, with the least role it needs (PLAN 7.3). Default deny: a path not listed here
   needs a signed-in helper. test/auth-routes.test.ts walks app/ and fails if a route file is missing from this
   list, or if a guarded route file does not call the guard.
   Pattern syntax: "[x]" matches one segment, a trailing "*" matches the rest of the path. */
import type { Role } from "./store";

export type Access = "public" | Role;
export type RouteEntry = { pattern: string; access: Access; kind: "page" | "api" };

export const ROUTES: RouteEntry[] = [
  /* signed out */
  { pattern: "/", access: "public", kind: "page" },
  { pattern: "/sign-in", access: "public", kind: "page" },
  { pattern: "/invite", access: "public", kind: "page" },
  { pattern: "/invite/[token]", access: "public", kind: "api" },
  { pattern: "/no-access", access: "public", kind: "page" },
  { pattern: "/auth/callback", access: "public", kind: "api" },
  { pattern: "/api/auth/start", access: "public", kind: "api" },
  { pattern: "/api/auth/sign-out", access: "public", kind: "api" },
  { pattern: "/api/health", access: "public", kind: "api" },
  /* the dev identity provider: 404 unless ORRY_DEV_AUTH=1 */
  { pattern: "/dev-idp", access: "public", kind: "page" },
  { pattern: "/dev-idp/authorize", access: "public", kind: "api" },
  { pattern: "/dev-idp/token", access: "public", kind: "api" },
  { pattern: "/dev-idp/jwks", access: "public", kind: "api" },
  { pattern: "/dev-idp/userinfo", access: "public", kind: "api" },

  /* helpers and organizers */
  { pattern: "/board", access: "helper", kind: "page" },
  { pattern: "/tickets/[id]", access: "helper", kind: "page" },
  { pattern: "/stats", access: "helper", kind: "page" },
  { pattern: "/stats/*", access: "helper", kind: "page" },
  { pattern: "/closed", access: "helper", kind: "page" },
  { pattern: "/me", access: "helper", kind: "page" },
  { pattern: "/leaderboard", access: "helper", kind: "page" },
  { pattern: "/rewards", access: "helper", kind: "page" },
  { pattern: "/settings", access: "helper", kind: "page" },
  { pattern: "/api/board/*", access: "helper", kind: "api" },
  { pattern: "/api/tickets/*", access: "helper", kind: "api" },
  { pattern: "/api/me/*", access: "helper", kind: "api" },
  { pattern: "/api/auth/sign-out-all", access: "helper", kind: "api" },

  /* organizers */
  { pattern: "/orry", access: "organizer", kind: "page" },
  { pattern: "/team", access: "organizer", kind: "page" },
  { pattern: "/api/team/*", access: "organizer", kind: "api" }
];

function matches(pattern: string, path: string): boolean {
  const p = pattern.split("/").filter(Boolean), s = path.split("/").filter(Boolean);
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "*") return true;
    if (i >= s.length) return false;
    if (p[i].startsWith("[") && p[i].endsWith("]")) continue;
    if (p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

/** Exact entries win over wildcard ones. */
export function routeFor(path: string): RouteEntry | null {
  const clean = path.split("?")[0].split("#")[0] || "/";
  const exact = ROUTES.find(r => !r.pattern.includes("*") && matches(r.pattern, clean));
  return exact ?? ROUTES.find(r => r.pattern.includes("*") && matches(r.pattern, clean)) ?? null;
}

/** Unknown paths need a helper (default deny). */
export function accessFor(path: string): Access {
  return routeFor(path)?.access ?? "helper";
}

/** Pages a sign-in may return to. */
export function isReturnablePage(path: string): boolean {
  const r = routeFor(path);
  return !!r && r.kind === "page" && r.access !== "public";
}
