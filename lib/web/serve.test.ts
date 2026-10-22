process.env.ORRY_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");

before(() => {
  db.close();
  db.open(":memory:");
});

test("handleRequest dispatches /internal/v1/* to the API handler, not the static 404 fallback", async () => {
  const savedToken = (process.env.ORRY_INTERNAL_TOKEN ?? process.env.RIVET_INTERNAL_TOKEN);
  process.env.ORRY_INTERNAL_TOKEN = "test-serve-token";
  try {
    const serve = require("./serve");
    const req = new Request("http://localhost/internal/v1/health", {
      headers: { Authorization: "Bearer test-serve-token" },
    });
    const res = await serve.handleRequest(req);
    assert.equal(res.status, 200, "a correctly authed internal route must not fall through to the generic 404");
    const body = await res.json();
    assert.equal(body.ok, true);
  } finally {
    if (savedToken === undefined) delete process.env.ORRY_INTERNAL_TOKEN;
    else process.env.ORRY_INTERNAL_TOKEN = savedToken;
  }
});

test("handleRequest still gates /internal/v1/* with the wrong token — dispatch isn't the same as bypassing auth", async () => {
  const savedToken = (process.env.ORRY_INTERNAL_TOKEN ?? process.env.RIVET_INTERNAL_TOKEN);
  process.env.ORRY_INTERNAL_TOKEN = "test-serve-token";
  try {
    const serve = require("./serve");
    const req = new Request("http://localhost/internal/v1/health", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    const res = await serve.handleRequest(req);
    assert.equal(res.status, 401);
  } finally {
    if (savedToken === undefined) delete process.env.ORRY_INTERNAL_TOKEN;
    else process.env.ORRY_INTERNAL_TOKEN = savedToken;
  }
});

test("an actually unmatched route still falls through to the plain 404", async () => {
  const serve = require("./serve");
  const req = new Request("http://localhost/definitely-not-a-real-route");
  const res = await serve.handleRequest(req);
  assert.equal(res.status, 404);
  const text = await res.text();
  assert.equal(text, "not found");
});

function withToken(tok: string) {
  return { Authorization: `Bearer ${tok}` };
}

test("absent ORRY_INTERNAL_TOKEN → 404 (not 401/403); bad bearer → 401", async () => {
  const saved = (process.env.ORRY_INTERNAL_TOKEN ?? process.env.RIVET_INTERNAL_TOKEN);
  const serve = require("./serve");
  try {
    delete process.env.ORRY_INTERNAL_TOKEN;
    const disabled = await serve.handleRequest(
      new Request("http://localhost/internal/v1/health", { headers: withToken("anything") }),
    );
    assert.equal(disabled.status, 404);
    const body = await disabled.json();
    assert.match(body.error, /disabled/);

    process.env.ORRY_INTERNAL_TOKEN = "char-serve-token";
    const bad = await serve.handleRequest(
      new Request("http://localhost/internal/v1/health", { headers: withToken("wrong") }),
    );
    assert.equal(bad.status, 401);
    const noHeader = await serve.handleRequest(new Request("http://localhost/internal/v1/health"));
    assert.equal(noHeader.status, 401);
    const good = await serve.handleRequest(
      new Request("http://localhost/internal/v1/health", { headers: withToken("char-serve-token") }),
    );
    assert.equal(good.status, 200);
    assert.equal((await good.json()).ok, true);
  } finally {
    if (saved === undefined) delete process.env.ORRY_INTERNAL_TOKEN;
    else process.env.ORRY_INTERNAL_TOKEN = saved;
  }
});

test("dashboard gates — pulse/stream/ask/health need session; writes need admin", async () => {
  const serve = require("./serve");
  const auth = require("./auth");
  const anon = new Request("http://localhost/api/pulse");
  assert.equal((await serve.handleRequest(anon)).status, 401);
  assert.equal((await serve.handleRequest(new Request("http://localhost/api/health"))).status, 401);
  assert.equal(
    (await serve.handleRequest(new Request("http://localhost/api/queue"))).status,
    401,
    "writes without any session are 401, not 403",
  );
  const userTok = auth.signSession("U-serve-plain", "Plain", "user");
  const userHeaders = { Cookie: `${auth.COOKIE_NAME}=${userTok}` };
  assert.equal(
    (await serve.handleRequest(new Request("http://localhost/api/pulse", { headers: userHeaders }))).status,
    200,
  );
  const forbidden = await serve.handleRequest(new Request("http://localhost/api/queue", { headers: userHeaders }));
  assert.ok(
    [403, 200].includes(forbidden.status),
    "non-admin queue read is 403 unless the deployer allowlisted the user",
  );
  const adminTok = auth.signSession("admin", "Admin", "admin");
  const adminHeaders = { Cookie: `${auth.COOKIE_NAME}=${adminTok}` };
  assert.equal(
    (await serve.handleRequest(new Request("http://localhost/api/queue", { headers: adminHeaders }))).status,
    200,
  );
  const saved = (process.env.ORRY_INTERNAL_TOKEN ?? process.env.RIVET_INTERNAL_TOKEN);
  process.env.ORRY_INTERNAL_TOKEN = "char-serve-token-2";
  try {
    const sessOnly = await serve.handleRequest(
      new Request("http://localhost/internal/v1/health", { headers: adminHeaders }),
    );
    assert.equal(sessOnly.status, 401);
  } finally {
    if (saved === undefined) delete process.env.ORRY_INTERNAL_TOKEN;
    else process.env.ORRY_INTERNAL_TOKEN = saved;
  }
});

test("cancelled SSE streams remove their subscriber immediately", async () => {
  const serve = require("./serve");
  const before = serve.sseClientCount();
  const response = serve.sseStream(new Request("http://localhost/api/stream"));
  assert.equal(serve.sseClientCount(), before + 1);
  await response.body.cancel();
  assert.equal(serve.sseClientCount(), before);
});

test("a request aborted before SSE stream setup never leaves a subscriber", async () => {
  const serve = require("./serve");
  const controller = new AbortController();
  controller.abort();
  const before = serve.sseClientCount();
  serve.sseStream(new Request("http://localhost/api/stream", { signal: controller.signal }));
  assert.equal(serve.sseClientCount(), before);
});

test("internal error→status mapping per route family (pinned current values)", async () => {
  const saved = (process.env.ORRY_INTERNAL_TOKEN ?? process.env.RIVET_INTERNAL_TOKEN);
  process.env.ORRY_INTERNAL_TOKEN = "char-map-token";
  const serve = require("./serve");
  const api = require("./api");
  const H = withToken("char-map-token");
  try {
    assert.equal(
      (await serve.handleRequest(new Request("http://localhost/internal/v1/nope", { headers: H }))).status,
      404,
    );
    assert.equal(
      (await serve.handleRequest(new Request("http://localhost/internal/v1/tickets", { headers: H }))).status,
      400,
    );
    api.internalProgramSync("char-map", {
      name: "Map",
      workspaceId: "TW-M",
      claimedBy: "U-map-org",
      programChannels: [],
    });
    const miss = await serve.handleRequest(
      new Request("http://localhost/internal/v1/tickets/999999/claim", {
        method: "PATCH",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ programId: "char-map", actorId: "U-map-org" }),
      }),
    );
    assert.equal(miss.status, 400);
    assert.match((await miss.json()).error, /not found/);
    const tid = require("../db").createTicket({
      programId: "char-map",
      workspaceId: "TW-M",
      channel: "C1",
      threadTs: "char-map-1",
      requesterId: "U1",
      question: "q",
    });
    const mm = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/tickets/${tid}/claim`, {
        method: "PATCH",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ programId: "wrong-prog", actorId: "U-map-org" }),
      }),
    );
    assert.equal(mm.status, 403);
    const denied = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/tickets/${tid}/claim`, {
        method: "PATCH",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ programId: "char-map", actorId: "U-stranger-map" }),
      }),
    );
    assert.equal(denied.status, 403);
    const unk = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/tickets/${tid}/frobnicate`, {
        method: "PATCH",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ programId: "char-map", actorId: "U-map-org" }),
      }),
    );
    assert.equal(unk.status, 400);
    const sweep = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/char-map/retention", {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: "U-stranger-map", confirm: true }),
      }),
    );
    assert.equal(sweep.status, 403);
    const malformed = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/Bad_Slug!/x", {
        method: "PUT",
        headers: { ...H, "Content-Type": "application/json" },
        body: "{not-json",
      }),
    );
    assert.ok([400, 404].includes(malformed.status), "malformed bodies must not become 500s");
  } finally {
    if (saved === undefined) delete process.env.ORRY_INTERNAL_TOKEN;
    else process.env.ORRY_INTERNAL_TOKEN = saved;
  }
});

test("internal responses never leak token/secret fields", async () => {
  const saved = (process.env.ORRY_INTERNAL_TOKEN ?? process.env.RIVET_INTERNAL_TOKEN);
  process.env.ORRY_INTERNAL_TOKEN = "char-leak-token";
  const serve = require("./serve");
  try {
    const H = withToken("char-leak-token");
    for (const path of ["/internal/v1/health", "/internal/v1/programs"]) {
      const res = await serve.handleRequest(new Request(`http://localhost${path}`, { headers: H }));
      const text = await res.text();
      assert.equal(text.includes("char-leak-token"), false, `${path} must not echo the bearer`);
      assert.equal(/"secret"\s*:/i.test(text), false, `${path} must not carry secret fields`);
      assert.equal(/ORRY_INTERNAL_TOKEN/.test(text), false);
    }
  } finally {
    if (saved === undefined) delete process.env.ORRY_INTERNAL_TOKEN;
    else process.env.ORRY_INTERNAL_TOKEN = saved;
  }
});

test("PUT /internal/v1/programs/:id maps a channel conflict to 409 naming the channel", async () => {
  const saved = (process.env.ORRY_INTERNAL_TOKEN ?? process.env.RIVET_INTERNAL_TOKEN);
  process.env.ORRY_INTERNAL_TOKEN = "dash-serve-token";
  const serve = require("./serve");
  const api = require("./api");
  const H = withToken("dash-serve-token");
  try {
    const first = api.internalProgramSync("dash-serve-owner", {
      name: "Owner",
      workspaceId: "TW-DS",
      claimedBy: "U-ds-org",
      helpChannel: "C-ds-help",
      programChannels: [{ id: "C-ds-help", kind: "help" }],
    });
    assert.equal(first.ok, true);
    const res = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/dash-serve-intruder", {
        method: "PUT",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Intruder",
          workspaceId: "TW-DS",
          claimedBy: "U-ds-org",
          programChannels: [{ id: "C-ds-help", kind: "help" }],
        }),
      }),
    );
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /C-ds-help/);
  } finally {
    if (saved === undefined) delete process.env.ORRY_INTERNAL_TOKEN;
    else process.env.ORRY_INTERNAL_TOKEN = saved;
  }
});

test("POST /internal/v1/programs/:id/test-question proxies the probe; unknown program is 404", async () => {
  const saved = (process.env.ORRY_INTERNAL_TOKEN ?? process.env.RIVET_INTERNAL_TOKEN);
  process.env.ORRY_INTERNAL_TOKEN = "dash-serve-token-2";
  const serve = require("./serve");
  const api = require("./api");
  const H = withToken("dash-serve-token-2");
  try {
    api.internalProgramSync("dash-serve-probe", {
      name: "Probe",
      workspaceId: "TW-DS",
      claimedBy: "U-ds-org",
      programChannels: [],
    });
    const knowledge = require("../knowledge");
    const lookup = require("../lookup");
    const origContext = knowledge.getContext;
    const origLookup = lookup.lookupAnswer;
    knowledge.getContext = () => "### Probe Docs\nProbe answer text.";
    lookup.lookupAnswer = async () => ({
      source: "Probe Docs",
      answer: "Probe answer text.",
      passageCitations: ["p1"],
      citationEvidence: [
        {
          id: "p1",
          programId: "dash-serve-probe",
          source: "Probe Docs",
          text: "Probe answer text.",
        },
      ],
    });
    try {
      const res = await serve.handleRequest(
        new Request("http://localhost/internal/v1/programs/dash-serve-probe/test-question", {
          method: "POST",
          headers: { ...H, "Content-Type": "application/json" },
          body: JSON.stringify({ question: "what is this?", role: "help" }),
        }),
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.deepEqual(body.sources, ["Probe Docs"]);
      assert.equal(body.grounded, true);
      assert.equal(body.expectedAction, "reply");
    } finally {
      knowledge.getContext = origContext;
      lookup.lookupAnswer = origLookup;
    }
    const missing = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/nope-missing-serve/test-question", {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ question: "hi" }),
      }),
    );
    assert.equal(missing.status, 404);
    const empty = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/dash-serve-probe/test-question", {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ question: "  " }),
      }),
    );
    assert.equal(empty.status, 400);
  } finally {
    if (saved === undefined) delete process.env.ORRY_INTERNAL_TOKEN;
    else process.env.ORRY_INTERNAL_TOKEN = saved;
  }
});

test("regression: DELETE /internal/v1/macros/:id reads its JSON body (actorId survives)", async () => {
  const saved = (process.env.ORRY_INTERNAL_TOKEN ?? process.env.RIVET_INTERNAL_TOKEN);
  process.env.ORRY_INTERNAL_TOKEN = "char-del-token";
  const serve = require("./serve");
  const api = require("./api");
  const H = withToken("char-del-token");
  try {
    api.internalProgramSync("char-del", {
      name: "Del",
      workspaceId: "TW-D",
      claimedBy: "U-del-org",
      programChannels: [],
    });
    const created = api.internalMacroCreate("char-del", {
      actorId: "U-del-org",
      trigger: "?delpin",
      name: "Del",
      content: "bye {helper}",
    });
    assert.equal(created.ok, true);
    const mid = created.macro.id;
    const denied = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/macros/${mid}`, {
        method: "DELETE",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: "U-del-stranger" }),
      }),
    );
    assert.equal(denied.status, 403);
    const ok = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/macros/${mid}`, {
        method: "DELETE",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: "U-del-org" }),
      }),
    );
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);
  } finally {
    if (saved === undefined) delete process.env.ORRY_INTERNAL_TOKEN;
    else process.env.ORRY_INTERNAL_TOKEN = saved;
  }
});

test("POST /internal/v1/programs/:id/incidents/manual creates only for a program helper", async () => {
  const saved = (process.env.ORRY_INTERNAL_TOKEN ?? process.env.RIVET_INTERNAL_TOKEN);
  process.env.ORRY_INTERNAL_TOKEN = "manual-incident-token";
  const serve = require("./serve");
  const api = require("./api");
  const H = withToken("manual-incident-token");
  try {
    api.internalProgramSync("manual-route-a", {
      name: "Manual Route A",
      workspaceId: "TW-MRA",
      claimedBy: "U-mra",
      programChannels: [],
    });
    api.internalProgramSync("manual-route-b", {
      name: "Manual Route B",
      workspaceId: "TW-MRB",
      claimedBy: "U-mrb",
      programChannels: [],
    });
    const created = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/manual-route-a/incidents/manual", {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({
          actorId: "U-mra",
          title: "Manual outage",
          description: "The site is unavailable",
          publicMessage: "We are investigating the outage.",
        }),
      }),
    );
    assert.equal(created.status, 200);
    assert.equal((await created.json()).incident.status, "confirmed");

    const denied = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/manual-route-a/incidents/manual", {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: "U-mrb", title: "Cross-tenant", publicMessage: "nope" }),
      }),
    );
    assert.equal(denied.status, 403);
    assert.equal(api.internalIncidents("manual-route-b", {}).length, 0);
  } finally {
    if (saved === undefined) delete process.env.ORRY_INTERNAL_TOKEN;
    else process.env.ORRY_INTERNAL_TOKEN = saved;
  }
});
test("read-only token: GET routes and users/info only; writes are 403; the full token still writes", async () => {
  const serve = require("./serve");
  const api = require("./api");
  const saved = { full: (process.env.ORRY_INTERNAL_TOKEN ?? process.env.RIVET_INTERNAL_TOKEN), read: (process.env.ORRY_INTERNAL_READ_TOKEN ?? process.env.RIVET_INTERNAL_READ_TOKEN) };
  try {
    process.env.ORRY_INTERNAL_TOKEN = "full-token-for-writes";
    process.env.ORRY_INTERNAL_READ_TOKEN = "read-token-for-gets";
    api.internalProgramSync("ro-token-prog", {
      name: "RO",
      workspaceId: "TW-RO",
      claimedBy: "U-ro-org",
      programChannels: [],
    });
    const R = withToken("read-token-for-gets");
    const get = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/ro-token-prog/helpers", { headers: R }),
    );
    assert.equal(get.status, 200);
    const lookup = await serve.handleRequest(
      new Request("http://localhost/internal/v1/slack/users/info", {
        method: "POST",
        headers: { ...R, "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: [] }),
      }),
    );
    assert.equal(lookup.status, 200, "the batch name lookup is a read that uses POST");
    const write = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/ro-token-prog/helpers", {
        method: "PUT",
        headers: { ...R, "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: "U-ro-org", members: ["U-ro-sneak"] }),
      }),
    );
    assert.equal(write.status, 403);
    assert.equal(require("../db").isHelper("ro-token-prog", "U-ro-sneak"), false);
    const importStart = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/ro-token-prog/history-import", { method: "POST", headers: R }),
    );
    assert.equal(importStart.status, 403, "the history-import route shares the same gate");
    const ticketWrite = await serve.handleRequest(
      new Request("http://localhost/internal/v1/tickets/1/resolve", { method: "PATCH", headers: R }),
    );
    assert.equal(ticketWrite.status, 403);
    const wrong = await serve.handleRequest(
      new Request("http://localhost/internal/v1/health", { headers: withToken("read-token-for-getz") }),
    );
    assert.equal(wrong.status, 401);
    const fullWrite = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/ro-token-prog/helpers", {
        method: "PUT",
        headers: { ...withToken("full-token-for-writes"), "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: "U-ro-org", members: ["U-ro-sneak"] }),
      }),
    );
    assert.equal(fullWrite.status, 200);
    assert.equal(require("../db").isHelper("ro-token-prog", "U-ro-sneak"), true);
  } finally {
    for (const [key, value] of [
      ["RIVET_INTERNAL_TOKEN", saved.full],
      ["RIVET_INTERNAL_READ_TOKEN", saved.read],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("web bind: RIVET_WEB_PORT beats PORT, host defaults to 0.0.0.0, an empty host is refused", () => {
  const serve = require("./serve");
  assert.deepEqual(serve.resolveWebBind({}), { host: "0.0.0.0", port: 4100, error: null });
  assert.equal(serve.resolveWebBind({ PORT: "3000", RIVET_WEB_PORT: "4100" }).port, 4100);
  assert.equal(serve.resolveWebBind({ PORT: "3000" }).port, 3000, "PORT is still honoured when it is the only one");
  assert.equal(serve.resolveWebBind({ RIVET_WEB_PORT: "nope", PORT: "8080" }).port, 8080);
  assert.equal(serve.resolveWebBind({ RIVET_WEB_HOST: "127.0.0.1" }).host, "127.0.0.1");
  const empty = serve.resolveWebBind({ RIVET_WEB_HOST: "  " });
  assert.equal(empty.host, null);
  assert.match(empty.error, /empty/);
});

test("web start: a port already in use returns null instead of throwing into the bot", () => {
  const serve = require("./serve");
  const holder = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("held") });
  const keys = ["ORRY_WEB_HOST", "ORRY_WEB_PORT", "RIVET_WEB_HOST", "RIVET_WEB_PORT"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
  try {
    for (const key of ["RIVET_WEB_HOST", "RIVET_WEB_PORT"] as const) delete process.env[key];
    process.env.ORRY_WEB_HOST = "127.0.0.1";
    process.env.ORRY_WEB_PORT = String(holder.port);
    assert.equal(serve.start(), null);
    process.env.ORRY_WEB_HOST = "";
    assert.equal(serve.start(), null, "an empty host never binds");
  } finally {
    holder.stop(true);
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("no RIVET_DASHBOARD_PASSCODE → passcode login refuses instead of accepting a guessable default", async () => {
  const serve = require("./serve");
  const saved = (process.env.ORRY_DASHBOARD_PASSCODE ?? process.env.RIVET_DASHBOARD_PASSCODE);
  try {
    delete process.env.ORRY_DASHBOARD_PASSCODE;
    const res = await serve.handleRequest(
      new Request("http://localhost/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "passcode=orry",
      }),
    );
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("Set-Cookie"), null, "an unconfigured passcode must never mint a session");
    assert.match(await res.text(), /ORRY_DASHBOARD_PASSCODE/);

    const page = await serve.handleRequest(new Request("http://localhost/login"));
    assert.match(await page.text(), /ORRY_DASHBOARD_PASSCODE/, "the login page says why passcode login is off");
  } finally {
    if (saved === undefined) delete process.env.ORRY_DASHBOARD_PASSCODE;
    else process.env.ORRY_DASHBOARD_PASSCODE = saved;
  }
});

test("a configured ORRY_DASHBOARD_PASSCODE still signs in — and the cookie is Secure off-loopback", async () => {
  const serve = require("./serve");
  const saved = (process.env.ORRY_DASHBOARD_PASSCODE ?? process.env.RIVET_DASHBOARD_PASSCODE);
  try {
    process.env.ORRY_DASHBOARD_PASSCODE = "correct-horse";
    const good = await serve.handleRequest(
      new Request("https://orry.example.com/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "passcode=correct-horse",
      }),
    );
    assert.equal(good.status, 302);
    const cookie = good.headers.get("Set-Cookie");
    assert.ok(cookie.includes("rivet_sid="), "configured passcode still signs in");
    assert.ok(cookie.includes("; Secure"), "an https session cookie is Secure");

    const bad = await serve.handleRequest(
      new Request("http://localhost/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "passcode=orry",
      }),
    );
    assert.equal(bad.status, 200);
    assert.equal(bad.headers.get("Set-Cookie"), null);

    const dev = await serve.handleRequest(
      new Request("http://localhost/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "passcode=correct-horse",
      }),
    );
    assert.ok(!dev.headers.get("Set-Cookie").includes("Secure"), "plain-HTTP loopback stays workable in dev");
  } finally {
    if (saved === undefined) delete process.env.ORRY_DASHBOARD_PASSCODE;
    else process.env.ORRY_DASHBOARD_PASSCODE = saved;
  }
});

test("dev-testing auto-signin needs NODE_ENV=development, not just the sentinel client id", async () => {
  const serve = require("./serve");
  const cSaved = process.env.SLACK_CLIENT_ID;
  const nSaved = process.env.NODE_ENV;
  try {
    process.env.SLACK_CLIENT_ID = "dev-testing";
    delete process.env.NODE_ENV;
    const refused = await serve.handleRequest(new Request("http://localhost/login"));
    assert.equal(refused.status, 200, "no auto-session: the login page renders instead");
    assert.equal(refused.headers.get("Set-Cookie"), null, "dev-testing alone must not mint an admin cookie");

    process.env.NODE_ENV = "production";
    const prod = await serve.handleRequest(new Request("http://localhost/login"));
    assert.equal(prod.headers.get("Set-Cookie"), null, "NODE_ENV=production still refuses the auto-signin");

    process.env.NODE_ENV = "development";
    const allowed = await serve.handleRequest(new Request("http://localhost/login"));
    assert.equal(allowed.status, 302);
    assert.ok(allowed.headers.get("Set-Cookie").includes("rivet_sid="), "the dev affordance survives");
  } finally {
    if (cSaved === undefined) delete process.env.SLACK_CLIENT_ID;
    else process.env.SLACK_CLIENT_ID = cSaved;
    if (nSaved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nSaved;
  }
});

test("GET /internal/v1/programs/:id/access is 404 for an unknown program and 400 without a userId", async () => {
  const saved = (process.env.ORRY_INTERNAL_TOKEN ?? process.env.RIVET_INTERNAL_TOKEN);
  process.env.ORRY_INTERNAL_TOKEN = "access-route-token";
  const serve = require("./serve");
  const api = require("./api");
  const H = withToken("access-route-token");
  try {
    api.internalProgramSync("access-route", { name: "Access", workspaceId: "TW-AC", programChannels: [] });
    require("../db").syncHelper({ programId: "access-route", userId: "U-ac-helper" });
    const ok = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/access-route/access?userId=U-ac-helper", { headers: H }),
    );
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).helper, true);
    const missing = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/no-such-access/access?userId=U-ac-helper", { headers: H }),
    );
    assert.equal(missing.status, 404);
    const noUser = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/access-route/access", { headers: H }),
    );
    assert.equal(noUser.status, 400);
  } finally {
    if (saved === undefined) delete process.env.ORRY_INTERNAL_TOKEN;
    else process.env.ORRY_INTERNAL_TOKEN = saved;
  }
});

test("GET /internal/v1/programs/:id/audit filters by action, action prefix, since/until and pages with offset", async () => {
  const saved = (process.env.ORRY_INTERNAL_TOKEN ?? process.env.RIVET_INTERNAL_TOKEN);
  process.env.ORRY_INTERNAL_TOKEN = "audit-route-token";
  const serve = require("./serve");
  const db = require("../db");
  const H = withToken("audit-route-token");
  const get = async (query: string) => {
    const res = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/programs/audit-route/audit?${query}`, { headers: H }),
    );
    assert.equal(res.status, 200);
    return (await res.json()) as Array<{ action: string; created_at: number }>;
  };
  try {
    const at = (id: number | null, t: number) =>
      db.handle().query("UPDATE audit_events SET created_at = ? WHERE id = ?").run(t, id);
    at(db.recordAuditEvent({ programId: "audit-route", action: "sla.notified" }), 1000);
    at(db.recordAuditEvent({ programId: "audit-route", action: "ticket.resolved" }), 2000);
    at(db.recordAuditEvent({ programId: "audit-route", action: "ticket.claimed" }), 3000);
    at(db.recordAuditEvent({ programId: "audit-route", action: "sla.notified" }), 4000);
    at(db.recordAuditEvent({ programId: "audit-other", action: "sla.notified" }), 4500);
    at(db.recordAuditEvent({ programId: "audit-route", action: "ticket_x" }), 5000);

    assert.deepEqual(
      (await get("action=sla.notified")).map((r) => r.created_at),
      [4000, 1000],
      "exact action, this program only",
    );
    assert.deepEqual(
      (await get("action=ticket.*")).map((r) => r.action),
      ["ticket.claimed", "ticket.resolved"],
      "prefix match; the dot is literal, so ticket_x is not a ticket.* row",
    );
    assert.deepEqual(
      (await get("since=1000&until=3000")).map((r) => r.created_at),
      [3000, 2000],
    );
    assert.deepEqual(
      (await get("limit=2&offset=1")).map((r) => r.created_at),
      [4000, 3000],
    );
  } finally {
    if (saved === undefined) delete process.env.ORRY_INTERNAL_TOKEN;
    else process.env.ORRY_INTERNAL_TOKEN = saved;
  }
});

export {};
