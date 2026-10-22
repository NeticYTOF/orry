/* Auth settings. Everything comes from environment variables with safe local defaults; no secrets live in files. */

export const IDLE_MS = 12 * 60 * 60 * 1000; // sign out after 12 hours unused
export const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000; // and after 7 days at most
export const ROLE_RECHECK_MS = 5 * 60 * 1000; // ask Orry about the roster every 5 minutes
export const ROLE_GRACE_MS = 15 * 60 * 1000; // a role from the last good check lasts 15 minutes when Orry cannot be asked
export const TOUCH_MS = 60 * 1000; // write last_seen_at at most once a minute
export const SHORT_COOKIE_MS = 10 * 60 * 1000; // oauth state, invite and return-path cookies

export const INVITE_DAYS = [1, 7, 30] as const;
export const OPEN_INVITES_MAX = 20;
export const INVITES_PER_DAY = 30;

export const SLACK_ID_RE = /^[UW][A-Z0-9]{8,14}$/;

export function baseUrl(): string {
  return (process.env.ORRY_SITE_URL || "http://localhost:9995").replace(/\/+$/, "");
}
export function baseOrigin(): string {
  return new URL(baseUrl()).origin;
}
export function secureCookies(): boolean {
  return baseUrl().startsWith("https://");
}

/* __Host- needs Secure, so it is used only when the site runs on https. On http://localhost the plain names are used. */
const name = (n: string) => (secureCookies() ? "__Host-" : "") + n;
export const cookieNames = {
  get session() {
    return name("orry_session");
  },
  get oauth() {
    return name("orry_oauth");
  },
  get invite() {
    return name("orry_invite");
  },
  get flash() {
    return name("orry_flash");
  },
  get next() {
    return name("orry_next");
  },
};

export function cookieBase(maxAgeSec?: number) {
  return {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax" as const,
    path: "/",
    ...(maxAgeSec !== undefined ? { maxAge: maxAgeSec } : {}),
  };
}

/* The dev identity provider is on only when ORRY_DEV_AUTH=1 is set. npm run dev sets it.
   Under NODE_ENV=production it still needs the explicit setting, and every sign-in page then shows a warning. */
export function devAuthEnabled(): boolean {
  return process.env.ORRY_DEV_AUTH === "1";
}
export function devAuthInProduction(): boolean {
  return devAuthEnabled() && process.env.NODE_ENV === "production";
}

export function oneTimePasswordEnabled(): boolean {
  return (
    /^[A-Za-z0-9_-]{20,32}$/.test(process.env.ORRY_SITE_OTP_SALT || "") &&
    /^[a-f0-9]{64}$/i.test(process.env.ORRY_SITE_OTP_HASH || "") &&
    /^[UW][A-Z0-9]{8,14}$/.test(process.env.ORRY_SITE_OTP_SLACK_ID || "") &&
    !devAuthEnabled()
  );
}

export type HcaConfig = { issuer: string; clientId: string; clientSecret: string };
export function hcaConfig(): HcaConfig | null {
  const clientId = process.env.ORRY_HCA_CLIENT_ID,
    clientSecret = process.env.ORRY_HCA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    issuer: (process.env.ORRY_HCA_ISSUER || "https://auth.hackclub.com").replace(/\/+$/, ""),
    clientId,
    clientSecret,
  };
}

export function breakGlassIds(): string[] {
  return (process.env.ORRY_SITE_BREAKGLASS_SLACK_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => SLACK_ID_RE.test(s))
    .slice(0, 2);
}

export function authMode(): "hack-club" | "dev" | "hack-club+dev" | "none" {
  const h = !!hcaConfig(),
    d = devAuthEnabled();
  return h && d ? "hack-club+dev" : h ? "hack-club" : d ? "dev" : "none";
}
