/* Signed-out screens: sign-in, invite, no access and the dev identity provider. No sidebar: a centred card on the grid. */
import type { ReactNode } from "react";
import { devAuthInProduction } from "@/lib/auth/config";

export const dynamic = "force-dynamic";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <a className="skip" href="#auth" id="skip">Skip to the page</a>
      <main className="au-wrap" id="auth" tabIndex={-1}>
        {devAuthInProduction() ? (
          <p className="banner au-warn" role="alert">
            Warning: dev sign-in is on in production mode (ORRY_DEV_AUTH=1). Anyone who can reach this site can sign in
            as any invented account. Turn it off unless this is a local test.
          </p>
        ) : null}
        {children}
      </main>
    </>
  );
}
