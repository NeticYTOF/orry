/* Root layout. Reads the orry-theme, orry-people and orry-density cookies so the first paint is right (no flash).
   The attributes sit on <html> and on <body class="screen">; the mockup's CSS keys on .screen. */
import "./ui/tokens.css";
import "./ui/frame.css";
import "./ui/kit.css";
import "./ui/board.css";
import "./ui/ticket.css";
import "./ui/stats.css";
import "./ui/orry.css";
import "./ui/admin.css";
import "./ui/auth.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SvgDefs } from "@/components/shell/Brand";
import { Grain } from "@/components/shell/Grain";
import { readPrefs } from "@/components/shell/prefs-server";

export const metadata: Metadata = {
  title: { default: "LOADOUT ORRY", template: "%s | LOADOUT ORRY" },
  description: "The help desk for Loadout's Slack helpers.",
  robots: { index: false, follow: false },
  referrer: "no-referrer"
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const p = await readPrefs();
  return (
    <html lang="en" data-display-theme={p.theme} data-people={p.people} data-density={p.density}>
      <body className="screen" id="screen" data-display-theme={p.theme} data-people={p.people} data-density={p.density}>
        {children}
        <SvgDefs />
        <Grain />
      </body>
    </html>
  );
}
