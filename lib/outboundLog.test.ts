process.env.RIVET_DB_PATH = ":memory:";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const slackMessages = require("./slackMessages");
const reply = require("./reply");

before(() => {
  db.close();
  db.open(":memory:");
});

interface OutRow {
  id: number;
  program_id: string | null;
  channel: string;
  thread_ts: string | null;
  message_ts: string | null;
  surface: string;
  source: string;
  status: string;
  error: string | null;
  private: number;
  text: string | null;
  text_chars: number | null;
  edit_count: number;
  deleted_at: number | null;
}

function rows(channel: string): OutRow[] {
  return db.handle().query("SELECT * FROM outbound_messages WHERE channel = ? ORDER BY id").all(channel) as OutRow[];
}

function okClient(ts = "1700000000.000100") {
  const calls: Array<{ method: string; payload: unknown }> = [];
  return {
    calls,
    chat: {
      postMessage: async (payload: unknown) => {
        calls.push({ method: "postMessage", payload });
        return { ok: true, ts };
      },
      update: async (payload: unknown) => {
        calls.push({ method: "update", payload });
        return { ok: true };
      },
      delete: async (payload: unknown) => {
        calls.push({ method: "delete", payload });
        return { ok: true };
      },
    },
  };
}

const PROGRAM = { id: "out-prog", name: "Out" };

test("a thread reply is logged with its text; a DM and a private send keep metadata only", async () => {
  await slackMessages.sendProgramMessage({
    client: okClient("10.1"),
    program: PROGRAM,
    channel: "C-OUT-1",
    threadTs: "9.9",
    text: "Try restarting the board.",
  });
  const [thread] = rows("C-OUT-1");
  assert.equal(thread.surface, "thread");
  assert.equal(thread.message_ts, "10.1");
  assert.equal(thread.text, "Try restarting the board.");
  assert.equal(thread.program_id, "out-prog");
  assert.equal(thread.status, "sent");

  await slackMessages.sendProgramMessage({
    client: okClient("11.1"),
    program: PROGRAM,
    channel: "D-OUT-DM",
    text: "hi",
  });
  const [dm] = rows("D-OUT-DM");
  assert.equal(dm.surface, "dm");
  assert.equal(dm.text, null);
  assert.equal(dm.private, 1);
  assert.equal(dm.text_chars, 2, "length is kept so the log can still show something was said");

  await slackMessages.sendProgramMessage({
    client: okClient("12.1"),
    program: PROGRAM,
    channel: "C-OUT-2",
    threadTs: "8.8",
    text: "A person needs to decide.",
    logSource: "sensitive_reply",
    logPrivate: true,
  });
  const [sensitive] = rows("C-OUT-2");
  assert.equal(sensitive.text, null);
  assert.equal(sensitive.source, "sensitive_reply");
});

test("a failed send is logged as failed and still throws the Slack error", async () => {
  const err = Object.assign(new Error("An API error occurred: channel_not_found"), {
    data: { error: "channel_not_found" },
  });
  const client = {
    chat: {
      postMessage: async () => {
        throw err;
      },
    },
  };
  await assert.rejects(
    slackMessages.sendProgramMessage({ client, program: PROGRAM, channel: "C-OUT-FAIL", text: "x" }),
    (e: unknown) => e === err,
  );
  const [row] = rows("C-OUT-FAIL");
  assert.equal(row.status, "failed");
  assert.equal(row.error, "channel_not_found");
  assert.equal(row.message_ts, null);
});

test("a logging failure never breaks the send", async () => {
  db.handle().exec("ALTER TABLE outbound_messages RENAME TO outbound_messages_away");
  try {
    const res = await slackMessages.sendProgramMessage({
      client: okClient("13.1"),
      program: PROGRAM,
      channel: "C-OUT-BROKEN",
      text: "still sent",
    });
    assert.equal(res.ts, "13.1");
  } finally {
    db.handle().exec("ALTER TABLE outbound_messages_away RENAME TO outbound_messages");
  }
});

test("a placeholder that becomes the answer is one row with the final text", async () => {
  const client = okClient("14.1");
  const placeholder = reply.postThinking(client, "C-OUT-ANS", "7.7", PROGRAM);
  await reply.finalize(client, "C-OUT-ANS", "7.7", placeholder, "Your build goes in the #ship channel.", {
    program: PROGRAM,
  });
  const list = rows("C-OUT-ANS");
  assert.equal(list.length, 1);
  assert.equal(list[0].source, "answer");
  assert.equal(list[0].edit_count, 1);
  assert.equal(list[0].text, "Your build goes in the #ship channel.");
});

export {};
