/* Default deny (PLAN 7.3): every route the app serves is on the route list with its least role, and every
   route that needs a role calls the guard. A new page or route handler that skips either fails here. */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { accessFor, ROUTES, routeFor } from "../lib/auth/routes";

const APP = path.join(__dirname, "..", "app");
const GUARD = /\b(requireSession|requireApiSession|organizerAction)\s*\(/;

type RouteFile = { file: string; url: string; kind: "page" | "api" };
function walk(dir: string, out: RouteFile[] = []): RouteFile[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith("_")) walk(p, out); continue; }
    const m = e.name.match(/^(page|route)\.(tsx?|jsx?)$/);
    if (!m) continue;
    const segs = path.relative(APP, dir).split(path.sep).filter(s => s && !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"));
    out.push({ file: path.relative(path.join(APP, ".."), p).replace(/\\/g, "/"), url: "/" + segs.join("/"), kind: m[1] === "page" ? "page" : "api" });
  }
  return out;
}
const files = walk(APP);

describe("route list", () => {
  it("finds the app's routes", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.map(f => f.url)).toEqual(expect.arrayContaining(["/sign-in", "/team", "/config", "/auth/callback", "/api/auth/start"]));
  });

  it("every route file is on the route list", () => {
    const missing = files.filter(f => !routeFor(f.url)).map(f => `${f.file} (${f.url})`);
    expect(missing, "add these to lib/auth/routes.ts").toEqual([]);
  });

  it("every guarded route file calls the guard itself", () => {
    const unguarded = files
      .filter(f => routeFor(f.url)!.access !== "public")
      .filter(f => !GUARD.test(fs.readFileSync(path.join(APP, "..", f.file), "utf8")))
      .map(f => `${f.file} (${routeFor(f.url)!.access})`);
    expect(unguarded, "call requireSession() / requireApiSession() in these").toEqual([]);
  });

  it("organizer routes are organizer-only on the list", () => {
    for (const u of ["/team", "/config", "/api/team/invites", "/api/team/accounts/3/role"]) expect(accessFor(u)).toBe("organizer");
  });

  it("an unknown path needs a signed-in helper (default deny)", () => {
    for (const u of ["/brand-new-page", "/api/whatever", "/admin", "/team-x"]) expect(accessFor(u)).toBe("helper");
  });

  it("only sign-in, invite, callback, health and the dev provider are public", () => {
    const pub = ROUTES.filter(r => r.access === "public").map(r => r.pattern).sort();
    expect(pub).toEqual(["/", "/api/auth/sign-out", "/api/auth/start", "/api/health", "/auth/callback", "/dev-idp", "/dev-idp/authorize", "/dev-idp/jwks", "/dev-idp/token", "/dev-idp/userinfo", "/invite", "/invite/[token]", "/no-access", "/sign-in"]);
  });

  it("the signed-in layout runs the guard", () => {
    expect(fs.readFileSync(path.join(APP, "(app)", "layout.tsx"), "utf8")).toMatch(GUARD);
  });
});
