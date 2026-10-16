# Orry the ore Maulwürf — feature and behavior guide

This guide describes the Rivet bot as configured for Loadout and the behavior
implemented in Core. “Orry” is the bot's public persona; Rivet remains the
repository and internal project name.

## Identity and personality

- **Display name:** Orry the ore Maulwürf.
- **Slash-command prefix:** `/orry` (for example, `/orry`, `/orry-sources`,
  `/orry-teach`). `RIVET_BOT_NAME` and `RIVET_BOT_SLUG` control the generated
  name and commands. The word “Rivet” remains a spoken compatibility alias.
- **Character:** a cheerful, cheeky mine-mole who likes ore, tiny tools,
  tunnels, and gentle mine puns.
- **Humor:** dry, friendly, and low-stakes. Orry may make obviously fictional
  preference jokes, such as polished ore being tidier. It must not present
  pretend preferences as facts or personal experiences.
- **German flavor:** a small, natural phrase in casual replies when it fits,
  such as “ja, ja”, “na ja”, “alles klar”, or “passt”. Do not force German,
  imitate an accent, or make answers hard to understand.
- **Tone examples:** “Ja, ja, I missed that — the correct command is …”;
  “Alles klar, let's dig into the error.”
- **Hard style guidance:** avoid profanity and swear words, slurs, insults,
  crude or sexual jokes, stereotypes, and controversial opinions. Keep factual,
  coding, sensitive, safety, and escalation replies direct. Humor never
  changes a fact, policy, or recommendation.
- **Emoji:** replies may use one to three mood-matched Slack emoji. Dry factual
  answers can omit them; repeated endings are discouraged.

These are instructions in the language-model prompts, not a deterministic
output filter. They strongly guide generated text but cannot guarantee that a
model will never violate them.

## Where Orry listens

Rivet Core connects to Slack through Socket Mode. It opens an outbound
connection; Slack does not call an inbound Rivet endpoint. Current Loadout
channel roles are:

| Surface | Behavior |
| --- | --- |
| `#loadout` (main) | Answers eligible questions in the program channel. It can answer ambient questions according to program behavior settings. |
| `#loadout-help` (help) | Answers support requests and can open tickets and route them to helpers. Top-level help-channel posts are treated as requests. |
| `#loadout-development` (organizer/report-only) | Does not volunteer answers. Explicit `@Orry` mentions use the Loadout answer path; reports may be posted here when configured. |
| Direct messages | Replies to the user directly, subject to DM rate limits for expensive paths such as image analysis. |
| Other channels | A Slack @mention or a recognized name-address can reach the configured safety/answer path even when the channel is otherwise unclaimed. Without a direct address, an unclaimed channel stays quiet. |

Channel names and roles are configuration, not hard-coded product promises.
Direct @mentions are handled from both Slack `message` and `app_mention`
events, then deduplicated so the same message is answered once. Orry ignores
its own messages and posts replies in the source thread; DMs are sent as direct
messages.

## When Orry replies, waits, or stays quiet

1. **Addressing:** Slack @mentions, “orry”/the configured bot name, and the
   legacy “rivet” alias can address Orry. Name detection works anywhere in a
   message and recognizes a name with a word suffix (such as “Orrybot”).
2. **Name references:** wording such as “ask Orry”, “Orry already answered”,
   or “ignore Rivet” is treated as a reference rather than a request to speak.
   A fresh question in the same message can still be handled.
3. **Channel and thread policy:** help channels answer help requests; main
   channels follow their ambient-reply settings; organizer channels do not
   volunteer. In an existing thread, Orry follows along after it has spoken or
   when directly invited. An acknowledgement such as “thanks” does not get a
   needless extra reply.
4. **Human handoff:** explicit requests for a human, a helper's takeover, or
   an already-open escalation prevent Orry from talking over the helper.
   Takeover signals include phrases such as “I'll handle this” and “let me
   check”.
5. **Mute and resume:** people can ask Orry to be quiet or use `!mute` / `!stfu`.
   A muted thread remains quiet until an explicit invitation such as “come
   back”, “resume”, or a direct mention.
6. **Greetings and noise:** an unaddressed greeting, a short compliment, or an
   acknowledgement is generally ignored in a public channel. Direct greetings
   and DMs can receive a brief conversational response.
7. **Safety/escalation precedence:** sensitive topics and requests that need a
   human can go to the help/ticket path even if ordinary chatter would be
   ignored. Human-directed messages are not reclassified as questions for Orry.
8. **Verdict before heuristics:** engagement classification determines whether
   a message needs program help, is casual conversation, or is off-topic. A
   secondary “directed at a person” signal must not override a help-needed
   verdict.

The exact result depends on the program's channel role, posture, behavior
settings, ticket state, and thread history. Orry does not promise to answer
every message containing its name; normal policy and safety checks still run.

## Answers and knowledge

- **Program documentation first:** the configured program corpus is the source
  for program rules, dates, prices, eligibility, rewards, and other program
  facts. For the current Loadout setup, nine sources loaded successfully in the
  last local smoke run.
- **Retrieval:** sources are assembled into a program-scoped corpus and ranked
  with BM25 text search. Rivet does not use embeddings or a vector database.
  Source text is cached in SQLite and refreshed at startup and on a timer
  (30-minute default).
- **Grounding:** numeric claims must be supported verbatim; claims must match
  the same program; unsupported hedge/filler answers are rejected; final
  actions decide whether to reply, decline, escalate, or stay silent. A
  program can require grounded answers, which disables casual model replies for
  that program.
- **Unknowns:** Orry should state when the corpus cannot establish a program
  fact, point the person to helpers, and avoid guessing. Unanswered questions
  can be recorded as documentation gaps.
- **Compound questions:** supported parts may be answered while unsupported
  parts are identified separately. Follow-ups use thread context but are
  checked against the latest question, so an earlier answer does not become
  evidence for an unrelated new claim.
- **General help:** when the request is not about program-specific facts,
  configured chat/debug prompts can answer general coding, tools, math, and
  similar questions. Program guardrails remain in effect.
- **Images:** an image with a question can be sent to the configured vision
  model. Orry answers the question or helps with the visible error instead of
  merely describing the image. If the ask is unclear or unsupported, the
  vision path can skip the reply. Slack file bytes are fetched for the request;
  only a text placeholder is retained in conversation context.
- **Streaming and cache:** answers may stream when allowed by policy. Grounded
  mode disables streaming and general chat. Cached answers are scoped by
  program and refreshed/invalidated as source or learned knowledge changes.

## Tickets, helpers, and learning

- **Support tickets:** eligible help requests can create or update a ticket
  from the Slack thread. Duplicate detection, ticket visibility, status,
  assignment, and resolution are tracked in SQLite.
- **Helper routing:** candidates are ranked using expertise match, current
  load, recency, and ping fatigue. Helpers can claim, decline, release, or
  respond to offers; timeouts and reassignments are tracked.
- **Thread summaries:** helper-only `!sum` creates a summary. A button can
  post that summary back into the thread. Summaries do not become knowledge.
- **Reactions:** supported positive and negative reactions record feedback on
  bot replies; removing a vote reaction removes that user's feedback. `:x:`
  or `:heavy_multiplication_x:` deletes a message only when that message was
  authored by Orry.
- **Teaching:** helpers can submit `!teach <question> :: <answer>` or teach the
  current thread. Organizer/admin slash commands can add a Q/A directly.
  Captured answers can wait for review before use.
- **Review:** approved answers enter the program's learned facts. Organizers
  can inspect pending items, approve one, or remove an item/range/pending set.
  Resolved tickets can also produce candidate learned facts. New knowledge
  invalidates the relevant answer cache and retrieval index.
- **Documentation gaps:** repeated unanswered questions are counted and
  clustered to help organizers find missing FAQ coverage. A gap is a prompt
  for a human documentation update, not permission to invent an answer.

## Slack commands and controls

All listed commands use `/orry` as the prefix and respond privately unless
noted. Access still depends on channel role and the global admin/helper roster.

| Command | Access | Behavior |
| --- | --- | --- |
| `/orry [question]` | Anyone in main/help/DM | Returns a private answer; `/orry help` lists available commands. |
| `/orry-sources` | Anyone | Lists the active program's configured sources and last refresh. |
| `/orry-stats` | Anyone | Shows answer, cache, feedback, and latency metrics. |
| `/orry-check <github_repo_url>` | Anyone | Inspects a public GitHub repository and formats a readiness report. |
| `/orry-report [last]` | Global admin | Shows the current or previous weekly report privately. |
| `/orry-reload` | Global admin | Refreshes sources and clears the answer cache. |
| `/orry-gaps` | Global admin | Shows frequent documentation gaps from the recent window. |
| `/orry-teach <question> :: <answer>` | Global admin | Saves a direct Q/A for the current program. |
| `/orry-pending` | Global admin | Lists captured answers awaiting review. |
| `/orry-approve <n>` | Global admin | Approves a pending learned answer. |
| `/orry-forget <n \| from-to \| pending \| all>` | Global admin | Removes learned answers by ID, range, status, or all. |
| `/orry-program list\|add\|set\|remove` | Global admin | Manages program configuration; `tickets on\|off` is also available to that program's helper or an admin in its channel. |

Text commands:

- `!teach`, `!learn`, `!remember`, or `!memorize` are helper/admin routes to
  save a Q/A or capture a thread for review.
- `!sum`, `!summary`, `!summarize`, or `!summarise` summarize the current
  thread for helpers. `public`/`share` requests a share action; it still does
  not write knowledge.
- `!mute` and `!stfu` mute the thread. Natural-language mute requests are also
  recognized.
- A message shortcut can capture a thread as a teach candidate; it is
  organizer/admin gated.

Slack app actions also handle ticket cards, assignment controls, summary
posting, and App Home actions. App Home can show documentation coverage,
learned-answer/cache information, and review controls to authorized admins.

## Reports, costs, and operational tools

- **Weekly report:** summarizes program support activity and can be requested
  with `/orry-report`. The report target is configuration-driven.
- **API cost digest:** daily totals are derived from metered `llm_usage` rows
  and known provider prices. Unknown pricing is reported separately; it is not
  silently counted as zero.
- **Program health and support analytics:** the dashboard aggregates coverage,
  response times, ticket/reopen/duplicate rates, helper load, stale work, and
  documentation gaps from Core's SQLite state.
- **Web console:** Core can serve its authenticated console/API (default port
  4100). The console is not Slack ingress. Its session cookie is HMAC-signed;
  login fails closed if no passcode is configured.
- **Wizard:** the separate Next.js/Postgres app owns program configuration and
  pushes it to Core through the authenticated internal bridge. It does not
  import Core modules.
- **Diagnostics:** `bun index.ts --doctor` checks required environment,
  channels, program/source wiring, and related startup prerequisites.
  `bun index.ts --ask "..." --program loadout` exercises corpus/model answering
  without Slack.
- **Persistence:** Core uses one SQLite database with WAL, migrations,
  idempotent message claims, and retained operational metrics. Secrets and
  live channel wiring belong only in ignored `.env` and `config/` files.

## Current identity rollout status

The code default, `.env.example`, local bot environment, Loadout support name,
and generated Slack manifest use **Orry the ore Maulwürf** and `/orry`. The
generated manifest was verified to contain the new display name and commands.
The installed Slack bot profile still reported the old name when checked; the
profile update was rejected by Slack with `not_admin`. A workspace admin must
apply the generated manifest or update the bot profile to change the live
Slack title. The language-model profanity/controversy restrictions are prompt
guidance, not a hard output filter.

## Source map

| Area | Main implementation |
| --- | --- |
| Startup, Socket Mode, CLI | `index.ts` |
| Events, mentions, thread routing | `lib/handlers.ts`, `lib/eligibility.ts`, `lib/channelPolicy.ts` |
| Brand, name, command prefix | `lib/brand.ts`, `scripts/manifest.cjs` |
| Retrieval and corpus refresh | `lib/knowledge.ts`, `lib/retrieve.ts`, `lib/sourceGuard.ts` |
| Prompts, chat, image answers | `lib/answer.ts`, `lib/chat.ts`, `lib/vision.ts` |
| Grounding and final action | `lib/lookup.ts`, `lib/grounding.ts`, `lib/pipeline/messagePolicy.ts` |
| Tickets and helper routing | `lib/tickets.ts`, `lib/helperRoute.ts`, `lib/assignmentLifecycle.ts` |
| Teaching and active learning | `lib/learn.ts`, `lib/activeLearning.ts`, `lib/resolutionWatcher.ts`, `lib/gapClusters.ts` |
| Commands, App Home, reports | `lib/commands.ts`, `lib/commandRegistry.ts`, `lib/home.ts`, `lib/report.ts`, `lib/costReport.ts` |
| Database and dashboard | `lib/db.ts`, `lib/schema.ts`, `lib/web/` |
