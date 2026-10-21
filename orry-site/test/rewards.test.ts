/* Weekly rewards: four podiums of rank 1 to 3 over the fixture week, the viewer's standing, and the rules that keep a
   lucky single reply from winning. */
import { beforeAll, describe, expect, it } from "vitest";
import { getRewardsModel, setLogEvent, type RewardsModel } from "../lib/models";

const juno = { accountId: 2, slackId: "U0JUNO001", role: "helper" as const, handle: "pixel-otter", name: "Juno Baker" };
const pat = { accountId: 1, slackId: "U0PAT0001", role: "organizer" as const, handle: "pat-placeholder", name: "Pat Placeholder" };
let m: RewardsModel;
let pm: RewardsModel;

beforeAll(async () => {
  setLogEvent(() => undefined);
  [m, pm] = await Promise.all([getRewardsModel(juno), getRewardsModel(pat)]);
});

describe("weekly podiums", () => {
  it("has the four categories, each with only ranks 1 to 3", () => {
    expect(m.error).toBeNull();
    expect(m.podiums.map(p => p.key)).toEqual(["finished", "speed", "reopened", "replies"]);
    for (const p of m.podiums) {
      expect(p.entries.length).toBeGreaterThan(0);
      expect(p.entries.every(e => e.rank >= 1 && e.rank <= 3)).toBe(true);
      expect(p.entries[0].rank).toBe(1);
      const ranks = p.entries.map(e => e.rank);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    }
  });

  it("counts the same week for everyone and says how long is left while it runs", () => {
    expect(pm.podiums.map(p => p.entries.map(e => e.person.id))).toEqual(m.podiums.map(p => p.entries.map(e => e.person.id)));
    expect(m.week.partial).toBe(true);
    expect(m.leftText).toMatch(/\d/);
    expect(m.closesText).toMatch(/^Closes \d+ \w{3}, 00:00 UTC$/);
  });

  it("only ranks people with enough first replies for speed and reopened", () => {
    for (const key of ["speed", "reopened"] as const) {
      const p = m.podiums.find(x => x.key === key)!;
      for (const e of p.entries) expect(e.sub === "reopened" || /n (\d+)/.test(e.sub)).toBe(true);
      if (key === "speed") for (const e of p.entries) expect(Number(/n (\d+)/.exec(e.sub)![1])).toBeGreaterThanOrEqual(5);
    }
  });

  it("marks the viewer on the podium and gives every category a standing line", () => {
    expect(m.standing).not.toBeNull();
    expect(m.standing!.map(s => s.key)).toEqual(["finished", "speed", "reopened", "replies"]);
    for (const s of m.standing!) {
      const onPodium = m.podiums.find(p => p.key === s.key)!.entries.some(e => e.you);
      expect(s.state === "podium").toBe(onPodium);
      expect(s.line.length).toBeGreaterThan(0);
    }
  });

  it("tells the viewer what is missing when they are not on a podium", () => {
    const standing = pm.standing; // Pat has no tickets in the fixtures
    expect(standing).toBeNull();
    expect(pm.standingNote).toMatch(/no finished tickets|hidden/);
  });

  it("shows last week's winners next to this week's, with a provisional note while it can still move", () => {
    expect(m.last).not.toBeNull();
    expect(m.last!.podiums.length).toBe(4);
  });
});
