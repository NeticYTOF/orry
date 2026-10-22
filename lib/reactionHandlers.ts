const configModule = require("./config");
const db = require("./db");
const log = require("./log");
const { stagingBlocked } = require("./slackEventPolicy");
import type { SlackClient } from "./types";

const { config } = configModule;

interface ReactionItem {
  channel: string;
  ts: string;
}
interface ReactionEvent {
  item: ReactionItem;
  item_user?: string;
  user: string;
  reaction?: string;
}

const DELETE_REACTIONS = new Set(["x", "heavy_multiplication_x"]);
const UP_REACTIONS = new Set([
  "yay",
  "thumbsup",
  "thumbs-up",
  "+1",
  "yesyes",
  "white_check_mark",
  "heavy_check_mark",
  "upvote",
  "sparkling_heart",
  "heart",
  "heart_eyes",
]);
const DOWN_REACTIONS = new Set(["nono", "-1", "thumbsdown", "sad-pf"]);

function errorMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("message" in error)) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

function errorData(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== "object" || error === null || !("data" in error)) return undefined;
  const data = (error as { data?: unknown }).data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
}

async function messageAuthor(client: SlackClient, channel: string, ts: string): Promise<string | null> {
  try {
    const replies = await client.conversations?.replies?.({ channel, ts, limit: 1, inclusive: true });
    if (replies?.messages?.[0]) return replies.messages[0].user || null;
  } catch (e: unknown) {
    log.debug("handlers", `replies lookup failed for ${ts}: ${errorMessage(e)}`);
  }
  try {
    const hist = await client.conversations?.history?.({ channel, latest: ts, limit: 1, inclusive: true });
    return hist?.messages?.[0]?.user || null;
  } catch (e: unknown) {
    log.debug("handlers", `history lookup failed for ${ts}: ${errorMessage(e)}`);
    return null;
  }
}

async function onReactionAdded({ event, client }: { event: ReactionEvent; client: SlackClient }): Promise<void> {
  if (stagingBlocked(event.item.channel)) return;
  const channel = event.item.channel;
  const normReaction = (event.reaction || "").toLowerCase();

  if (DELETE_REACTIONS.has(normReaction)) {
    try {
      const author = event.item_user || (await messageAuthor(client, channel, event.item.ts));

      if (!author) {
        log.warn("handlers", `delete reaction on ${event.item.ts}: could not tell who wrote it`);
        return;
      }
      if (author !== config.slack.botUserId) return;

      await client.chat.delete({ channel, ts: event.item.ts });
      require("./outboundLog").recordDelete({ channel, ts: event.item.ts, source: "x_reaction" });
      log.info("handlers", `deleted message ${event.item.ts} via reaction`);
    } catch (e: unknown) {
      log.warn("handlers", `could not delete ${event.item.ts}: ${errorData(e)?.error || errorMessage(e)}`);
    }
    return;
  }

  const vote = UP_REACTIONS.has(normReaction) ? 1 : DOWN_REACTIONS.has(normReaction) ? -1 : 0;
  if (vote !== 0) {
    db.recordFeedback(event.item.ts, event.user, vote);
    log.info("feedback", `vote=${vote} ts=${event.item.ts} user=${event.user}`);
  }
}

async function onReactionRemoved({ event }: { event: ReactionEvent }): Promise<void> {
  const normReaction = (event.reaction || "").toLowerCase();
  if (UP_REACTIONS.has(normReaction) || DOWN_REACTIONS.has(normReaction)) {
    db.removeFeedback(event.item.ts, event.user);
  }
}

export = { onReactionAdded, onReactionRemoved };
