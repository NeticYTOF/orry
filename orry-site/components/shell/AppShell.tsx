/* The signed-in frame, in the LOADOUT Docs shell's arrangement: a boxed sidebar of collapsible groups with the person
   pinned at its foot, and a main column that scrolls on its own. Under 820px the sidebar is a drawer behind a top bar.
   The ids (topbar, nav, scrim, menuBtn, drawerClose, mainCol, view) are what ShellClient drives. */
import type { ReactNode } from "react";
import type { Session } from "@/lib/session";
import { Brand } from "./Brand";
import { NavLink, ViewHost } from "./NavLink";
import { ShellClient } from "./ShellClient";
import { ThemeToggle } from "./ThemeToggle";
import { initials, PersonText } from "./Who";

export function AppShell({ session, light, boardCount, children }: { session: Session; light: boolean; boardCount?: number | null; children: ReactNode }) {
  const org = session.role === "organizer";
  const me = { handle: session.handle, name: session.name };
  const hasName = me.name !== me.handle;
  return (
    <>
      <a className="skip" href="#view" id="skip">Skip to the page</a>
      <div className="app" id="app">
        <header className="topbar" id="topbar">
          <Brand />
          <span className="acts">
            <ThemeToggle light={light} />
            <button className="menu-btn" type="button" id="menuBtn" aria-expanded="false" aria-controls="nav">Menu</button>
          </span>
        </header>

        <nav className="nav" id="nav" aria-label="Help desk">
          <div className="drawer-head"><span>Help desk</span><button className="btn sm" type="button" id="drawerClose">Close</button></div>
          <div className="nav-head">
            <Brand />
            <ThemeToggle light={light} />
          </div>

          <div className="grp">
            <p className="grp-h"><span>Work</span></p>
            <div className="grp-items">
              <NavLink href="/board" route="board" match={["/tickets"]}>
                <span>Open tickets</span>
                <span className="n" id="navBoardCount">{boardCount ?? ""}</span>
              </NavLink>
            </div>
          </div>

          <div className="grp">
            <p className="grp-h"><span>Your week</span></p>
            <div className="grp-items">
              <NavLink href="/rewards" route="rewards" match={["/leaderboard"]}>Weekly rewards</NavLink>
              <NavLink href="/me" route="me">My week</NavLink>
              <NavLink href="/closed" route="closed" match={["/stats/closed"]}>Closed tickets</NavLink>
            </div>
          </div>

          {org ? (
            <div className="grp">
              <p className="grp-h"><span>Organizers</span></p>
              <div className="grp-items">
                <NavLink href="/orry" route="orry" match={["/stats"]}>Orry performance</NavLink>
                <NavLink href="/team" route="team">Team and invites</NavLink>
                <NavLink href="/config" route="config">Config check</NavLink>
              </div>
            </div>
          ) : null}

          <div className="nav-foot">
            <div className="usercard">
              <span className="avatar" id="navAvatar" aria-hidden="true">{initials(me)}</span>
              <span className="u-meta">
                <b id="navName"><PersonText p={me} /></b>
                <small id="navHandle">
                  {hasName ? <span className="pp-name u-h">@{me.handle}</span> : null}
                  <span className="u-role">{session.role}</span>
                </small>
              </span>
            </div>
            <div className="u-links">
              <a className="txt-link" href="/settings">Settings</a>
              <form className="inline-form" method="post" action="/api/auth/sign-out">
                <button className="txt-link" type="submit">Sign out</button>
              </form>
            </div>
          </div>
        </nav>
        <button className="scrim" id="scrim" type="button" aria-label="Close the menu" hidden />

        <main className="main" id="mainCol">
          <ViewHost>{children}</ViewHost>
        </main>
      </div>
      <div className="sr" aria-live="polite" id="announce" />
      <div className="toast" id="toast" role="status" hidden />
      <div className="tip" id="tip" role="tooltip" hidden />
      <p className="vh" role="status" id="live" />
      <ShellClient />
    </>
  );
}
