/* The stub data source the auth tests inject in place of lib/data. It imports nothing that imports lib/data. */
import { PEOPLE } from "../lib/data/fixtures/people";

export const roster = {
  admin: new Set<string>(["U0PAT0001"]),
  helper: new Set<string>(["U0JUNO001", "U0LEILA01", "U0RAVI001", "U0MIA0001", "U0NOAH001", "U0ZARA001", "U0TESS001", "U0SAM0001"]),
  down: false,
  calls: 0
};

export const stub = {
  mode: "fixtures" as const,
  async health() {
    return { ok: !roster.down, mode: "fixtures" as const, checkedAt: new Date().toISOString(), lastPollAt: null, openTickets: null, message: "stub", usersReadGranted: true, ticketCardsOn: true, waitLimitMinutes: 120 };
  },
  async access(slackId: string) {
    roster.calls++;
    if (roster.down) return null;
    return { admin: roster.admin.has(slackId), helper: roster.helper.has(slackId) };
  },
  async getSlackUser(id: string) { return PEOPLE.find(p => p.id === id) ?? null; },
  async findSlackUserByHandle(h: string) { return PEOPLE.find(p => p.handle === h.replace(/^@/, "").toLowerCase()) ?? null; },
  async searchSlackUsers(q: string, limit = 8) { return PEOPLE.filter(p => p.handle.startsWith(q)).slice(0, limit); },
  async roster() { return []; }
};
