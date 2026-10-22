/* /settings: two tabs that are real links (?tab=): Display (theme, how people are shown, density) and Account (who you are,
   sign out everywhere). Both are for the signed-in person only. */
import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/ui/PageHead";
import { pickTab, TabNav, type TabDef } from "@/components/ui/TabNav";
import { readPrefs } from "@/components/shell/prefs-server";
import { SignOutEverywhere } from "@/components/shell/SignOutEverywhere";
import { Who } from "@/components/shell/Who";
import { requireSession } from "@/lib/session";
import { DisplayPrefs } from "./Prefs";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

const TABS: TabDef[] = [{ key: "display", label: "Display" }, { key: "account", label: "Account" }];

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSession("helper");
  const sp = await searchParams;
  const tab = pickTab(TABS, sp.tab);
  const prefs = tab === "display" ? await readPrefs() : null;
  return (
    <div id="top" className="ad-page" tabIndex={-1}>
      <PageHead kicker="Your account" title="Settings" />
      <div className="ad-tabs"><TabNav label="Settings sections" tabs={TABS} current={tab} href={k => `/settings?tab=${k}`} /></div>
      <div className="ad-narrow">
        {prefs ? (
          <section className="panel" aria-labelledby="h-disp">
            <div className="panel-h"><h2 id="h-disp">Display</h2></div>
            <DisplayPrefs initial={prefs} />
          </section>
        ) : (
          <section className="panel" aria-labelledby="h-acct">
            <div className="panel-h"><h2 id="h-acct">Your account</h2></div>
            <div className="panel-b">
              <dl className="kv">
                <div><dt>Signed in as</dt><dd><Who p={{ handle: s.handle, name: s.name }} /></dd></div>
                <div><dt>Role</dt><dd>{s.role === "organizer" ? "Organizer" : "Helper"}</dd></div>
                <div><dt>Leaderboard</dt><dd><Link className="lnk" href="/me?tab=profile">Profile in My week</Link></dd></div>
              </dl>
              <div className="ad-out-wrap"><SignOutEverywhere /></div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
