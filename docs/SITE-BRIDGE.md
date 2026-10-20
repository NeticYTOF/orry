# Site bridge: the Core routes a status site reads

This page is for anyone building a read-only status site (help desk board,
statistics, ledger) on top of Core's `/internal/v1` bridge. It lists every
route this series adds or changes, with its query and an exact example
response, the settings that control it, and what each change makes possible
on the site.

The series is the commits on top of `696d203` (see `docs/site-changes/README.md`
for the list and the patch files). Every example below was captured from
`bun run dev:bridge`, so every id, name and message in it is invented.

## Conventions

- Base URL: Core's web server, `http://127.0.0.1:4100` by default.
- Every request needs `Authorization: Bearer <token>`.
- Times are epoch milliseconds, UTC. Slack message ids (`threadTs`,
  `messageTs`, `thread_ts`) are Slack `ts` strings.
- Program-scoped routes live under `/internal/v1/programs/:id/...` and only
  ever return that program's rows. An unknown program answers 404
  `{"error":"unknown program"}`. A bad query answers 400 with an `error`.
- Paged routes return `total` (rows matching the whole query), `limit` and
  `offset`. Ask for the next page with `offset = offset + limit`.
- `since` is exclusive and `until` inclusive. When a route has a default
  window it is the last 7 days ending now.

## Auth and tokens

| Presented token | GET routes | `POST /internal/v1/slack/users/info` | Any other method |
|---|---|---|---|
| `RIVET_INTERNAL_TOKEN` | 200 | 200 | allowed (as before) |
| `RIVET_INTERNAL_READ_TOKEN` | 200 | 200 | 403 `{"error":"read-only token"}` |
| none or wrong | 401 `{"error":"unauthorized"}` | 401 | 401 |
| neither token set on Core | 404 `{"error":"internal api disabled"}` | 404 | 404 |

Both tokens use the same constant-time compare. A site should hold only the
read-only token (or none, behind a forwarding proxy that holds it).

## Settings

| Setting | Default | What it does |
|---|---|---|
| `RIVET_INTERNAL_TOKEN` | unset (bridge off) | Full bridge token. Unchanged. |
| `RIVET_INTERNAL_READ_TOKEN` | unset | Optional second token: GET routes and the users/info batch only. Use a different long random value. |
| `RIVET_WEB_HOST` | `0.0.0.0` | Interface the web server binds. Use `127.0.0.1` when the site runs on the same host. An empty value is refused and the console stays off. |
| `RIVET_WEB_PORT` | `4100` | Port. Now wins over `PORT`. |
| `PORT` | unset | Used only when `RIVET_WEB_PORT` is unset (Railway, Docker). |
| `RIVET_ADMIN_USER_IDS` | unset | The organizers. The access route reports `admin` from this list. Unchanged. |
| Slack scope `users:read` | was missing | Needed by users/info and the members route. Reinstall the app after updating the manifest (`bun run manifest`); this may need a workspace admin. |

A web server bind failure (port in use, bad host) is now logged and the bot
keeps running without its console, instead of exiting.

Dev bridge (`bun run dev:bridge`, see the last section) flags: `--port <n>`
(default 4100), `--db <file>` (keep a database between runs), `--seed <n>`
(a different invented history).

## New routes

### GET `/internal/v1/programs/:id/access?userId=`

Is this Slack user an organizer (on Core's admin list) or an active helper of
this program? Booleans only. `userId` is required (`A-Z a-z 0-9 _ -`, up to 64
characters), else 400 `{"error":"userId required"}`.

```json
{
  "programId": "loadout",
  "userId": "U0JUNO001",
  "admin": false,
  "helper": true
}
```

`helper` is true only for an active roster row of this program. A removed
helper is `false`. An organizer who is not also on the roster is
`{"admin": true, "helper": false}`.

### GET `/internal/v1/programs/:id/tickets/closing?since=&until=&limit=&offset=`

Every ticket of the program that finished in the window: status `resolved` or
`closed` with `resolved_at` in `(since, until]`, oldest first by `resolved_at`.
`limit` 1-500 (default 200). One call gives what "closed by Orry", "who
finished it" and the queue-time numbers need, without a detail call per
ticket.

It never returns ticket text, resolution text, the judge's reason, or the
requester's id. A participant closing their own ticket is `actorKind:
"requester"` with `actorId: null`.

Per row:

| Field | Meaning |
|---|---|
| `id`, `status`, `category`, `visibility` | From the ticket row. `visibility: "dashboard"` marks history-import and dashboard-only tickets. |
| `ownerId` | `assignee_id` (the last owner; not cleared on reopen). |
| `creditedId` | `resolved_credit_id`, the helper credited for the finish. |
| `createdAt`, `resolvedAt`, `firstResponseAt`, `firstHumanResponseAt`, `lastHumanReplyAt`, `reopenCount` | From the ticket row. `lastHumanReplyAt` is new (see "Changed data"). |
| `closing` | The latest `resolved` or `closed` event (the newest write wins, because auto-resolves are backdated), or `null` when the ticket was closed without an event (a macro close). |
| `closing.actorKind` | `orry` (no actor), `requester`, `helper` (roster member or admin), or `other`. |
| `closing.actorId` | Only for `helper`. |
| `closing.source`, `rule`, `verdict`, `confidence` | From the event's detail: `source` is `auto`, `backfill`, `macro` or null; `rule` is `last_word` for the last-word rule; `verdict` and `confidence` are set for the judge. |
| `firstEscalatedAt` | First `escalated` event. |
| `firstTaken` | First `claimed` or `assigned` event: when, which, by whom (`assigned` uses the assignee), and whether it was automatic. |
| `pings` | Offers sent by ping (`source` `ping` or `reassign_ping`), with `outcome` (`claimed`, `timed_out`, `declined`, `superseded`, `pending`) and `claimFollowed`. |

How the site maps `closing` to the parts of PLAN 5.3:

| Part | Rule on `closing` |
|---|---|
| Orry, last-word rule | `actorKind = orry`, `rule = last_word`, `source = auto` |
| Orry, judge | `actorKind = orry`, `verdict` set, `source = auto` |
| History import | `source = backfill` (`event = closed` is "closed with no answer") |
| Participant | `actorKind = requester` |
| Helper | `actorKind = helper` |
| Closed by a person or a macro | `closing = null`, or `event = closed` with a helper actor |

Example (`since` 90 days back, one row of each kind picked from the 125 the
call returned):

```json
{
  "programId": "loadout",
  "since": 1784713698927,
  "until": 1792489698927,
  "total": 125,
  "limit": 500,
  "offset": 0,
  "rows": [
    {
      "id": 3,
      "status": "resolved",
      "category": "site_bug",
      "visibility": "thread",
      "ownerId": "U0ZARA001",
      "creditedId": "U0ZARA001",
      "createdAt": 1785783299803,
      "resolvedAt": 1785802127072,
      "firstResponseAt": 1785783339147,
      "firstHumanResponseAt": 1785787213551,
      "lastHumanReplyAt": 1785788835113,
      "reopenCount": 0,
      "closing": {
        "event": "resolved",
        "at": 1785802127072,
        "actorKind": "helper",
        "actorId": "U0ZARA001",
        "source": null,
        "rule": null,
        "verdict": null,
        "confidence": null
      },
      "firstEscalatedAt": 1785783612601,
      "firstTaken": {
        "at": 1785784832728,
        "event": "claimed",
        "by": "U0ZARA001",
        "automatic": false
      },
      "pings": [
        {
          "offeredAt": 1785783714358,
          "to": "U0ZARA001",
          "source": "ping",
          "outcome": "claimed",
          "outcomeAt": 1785784832728,
          "claimFollowed": true
        }
      ]
    },
    {
      "id": 38,
      "status": "resolved",
      "category": "advice_how_to",
      "visibility": "thread",
      "ownerId": null,
      "creditedId": null,
      "createdAt": 1787936198353,
      "resolvedAt": 1787949692765,
      "firstResponseAt": 1787936310001,
      "firstHumanResponseAt": null,
      "lastHumanReplyAt": null,
      "reopenCount": 0,
      "closing": {
        "event": "resolved",
        "at": 1787949692765,
        "actorKind": "orry",
        "actorId": null,
        "source": "auto",
        "rule": null,
        "verdict": "resolved",
        "confidence": 0.83
      },
      "firstEscalatedAt": null,
      "firstTaken": null,
      "pings": []
    },
    {
      "id": 20,
      "status": "resolved",
      "category": "other",
      "visibility": "thread",
      "ownerId": "U0SAM0001",
      "creditedId": "U0SAM0001",
      "createdAt": 1786383941508,
      "resolvedAt": 1786397170956,
      "firstResponseAt": 1786384048902,
      "firstHumanResponseAt": 1786393175057,
      "lastHumanReplyAt": 1786394749152,
      "reopenCount": 0,
      "closing": {
        "event": "resolved",
        "at": 1786397170956,
        "actorKind": "requester",
        "actorId": null,
        "source": null,
        "rule": null,
        "verdict": null,
        "confidence": null
      },
      "firstEscalatedAt": 1786384226014,
      "firstTaken": {
        "at": 1786392652680,
        "event": "claimed",
        "by": "U0SAM0001",
        "automatic": false
      },
      "pings": [
        {
          "offeredAt": 1786384814094,
          "to": "U0JUNO001",
          "source": "ping",
          "outcome": "timed_out",
          "outcomeAt": 1786386614094,
          "claimFollowed": false
        }
      ]
    },
    {
      "id": 4,
      "status": "closed",
      "category": "fulfillment_shipping",
      "visibility": "dashboard",
      "ownerId": null,
      "creditedId": null,
      "createdAt": 1786199605059,
      "resolvedAt": 1786890805059,
      "firstResponseAt": null,
      "firstHumanResponseAt": null,
      "lastHumanReplyAt": null,
      "reopenCount": 0,
      "closing": {
        "event": "closed",
        "at": 1786890805059,
        "actorKind": "orry",
        "actorId": null,
        "source": "backfill",
        "rule": null,
        "verdict": null,
        "confidence": null
      },
      "firstEscalatedAt": null,
      "firstTaken": null,
      "pings": []
    },
    {
      "id": 10,
      "status": "closed",
      "category": "other",
      "visibility": "thread",
      "ownerId": "U0RAVI001",
      "creditedId": null,
      "createdAt": 1786052027251,
      "resolvedAt": 1786064093605,
      "firstResponseAt": 1786056888050,
      "firstHumanResponseAt": 1786056888050,
      "lastHumanReplyAt": 1786058586040,
      "reopenCount": 0,
      "closing": null,
      "firstEscalatedAt": 1786052277104,
      "firstTaken": {
        "at": 1786054590039,
        "event": "claimed",
        "by": "U0RAVI001",
        "automatic": false
      },
      "pings": [
        {
          "offeredAt": 1786052832389,
          "to": "U0RAVI001",
          "source": "ping",
          "outcome": "claimed",
          "outcomeAt": 1786054590039,
          "claimFollowed": true
        }
      ]
    }
  ]
}```

### GET `/internal/v1/programs/:id/outbound?since=&until=&limit=&offset=&source=&channel=&ticketId=&includeBlocks=1`

The outbound log: one row per message Orry put in Slack, newest first,
updated in place when Orry edits or deletes it. `limit` 1-500 (default 100).
Filters: `source`, `channel`, `ticketId`. `includeBlocks=1` adds `blocks`.

- `text` (and `blocks`) is returned only for channel and thread messages that
  are not private and not deleted. DM rows and private rows (the
  sensitive-topic reply) are metadata only: `text: null`, `textChars` set.
- Text is purged after 30 days (`textPurgedAt` set, metadata kept) and rows
  are deleted after 365 days.
- A message Orry deleted (`:x:` reaction, a discarded placeholder, a duplicate
  card) keeps its row as a tombstone with `deletedAt`, `deleteReason` and no
  text.
- When a participant deletes or edits a ticket's question, every row linked
  to that ticket loses its text (the card quotes the question).
- `source` values: `answer`, `placeholder`, `program_message`,
  `ticket_card`, `ticket_thread_card`, `sensitive_reply`, `weekly_report`,
  `cost_digest`, `ops_alert`, `thread_summary`, `update`, `delete`.
- `status` is `sent` or `failed` (with the Slack `error` code and no
  `messageTs`).
- `surface` is `channel`, `thread` or `dm`.
- Ephemeral messages are not logged.

```json
{
  "programId": "loadout",
  "since": 1791884899298,
  "until": 1792489699298,
  "total": 57,
  "limit": 2,
  "offset": 0,
  "rows": [
    {
      "id": 334,
      "ticketId": 144,
      "channel": "C0DEVORG01",
      "threadTs": null,
      "messageTs": "1792472097.600144",
      "surface": "channel",
      "source": "ticket_card",
      "status": "sent",
      "error": null,
      "private": false,
      "text": "[Ticket #144] <@U0KID0027> asked: \"Can I work on a project with a friend and both get Bolts?\"",
      "textChars": 93,
      "editCount": 0,
      "textPurgedAt": null,
      "deletedAt": null,
      "deleteReason": null,
      "createdAt": 1792472097584,
      "updatedAt": 1792472097584
    },
    {
      "id": 333,
      "ticketId": 144,
      "channel": "C0DEVHELP1",
      "threadTs": "1792471977.000144",
      "messageTs": "1792472097.500144",
      "surface": "thread",
      "source": "ticket_thread_card",
      "status": "sent",
      "error": null,
      "private": false,
      "text": "Someone will be here to help you soon!",
      "textChars": 38,
      "editCount": 0,
      "textPurgedAt": null,
      "deletedAt": null,
      "deleteReason": null,
      "createdAt": 1792472097584,
      "updatedAt": 1792472097584
    }
  ]
}```

With `source=weekly_report&includeBlocks=1`:

```json
{
  "programId": "loadout",
  "since": 1791884899353,
  "until": 1792489699353,
  "total": 1,
  "limit": 1,
  "offset": 0,
  "rows": [
    {
      "id": 360,
      "ticketId": null,
      "channel": "C0DEVORG01",
      "threadTs": null,
      "messageTs": "1792400400.900011",
      "surface": "channel",
      "source": "weekly_report",
      "status": "sent",
      "error": null,
      "private": false,
      "text": "Orry weekly report",
      "blocks": [
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": "*Week 2026-W42* (invented numbers)"
          }
        }
      ],
      "textChars": 18,
      "editCount": 0,
      "textPurgedAt": null,
      "deletedAt": null,
      "deleteReason": null,
      "createdAt": 1792400400000,
      "updatedAt": 1792400400000
    }
  ]
}```

A DM row (`channel=D0DEVDM001`), metadata only:

```json
{
  "programId": "loadout",
  "since": 1789897698927,
  "until": 1792489699411,
  "total": 1,
  "limit": 100,
  "offset": 0,
  "rows": [
    {
      "id": 361,
      "ticketId": null,
      "channel": "D0DEVDM001",
      "threadTs": null,
      "messageTs": "1792230494.000001",
      "surface": "dm",
      "source": "program_message",
      "status": "sent",
      "error": null,
      "private": true,
      "text": null,
      "textChars": 42,
      "editCount": 0,
      "textPurgedAt": null,
      "deletedAt": null,
      "deleteReason": null,
      "createdAt": 1792230494676,
      "updatedAt": 1792230494676
    }
  ]
}```

### GET `/internal/v1/programs/:id/answers/outcomes?since=&until=&limit=&offset=`

What the answer pipeline finally did with each message it handled: one row
per finished pipeline trace. No message text and no user id. Newest first,
`limit` 1-500 (default 100). `byAction` and `byReason` count the whole window,
not just the page, so a funnel adds up.

- `finalAction`: `reply`, `uncertain` (an honest decline said out loud),
  `escalate`, `silence`. A clarifying question is `reply` with reason
  `clarification`.
- `reason`: the pipeline's reason code (for example `grounded`,
  `ungrounded`, `gap_escalated`, `sensitive`, `ambient_chatter`,
  `help_chatter`, `thread_humans_talking`, `subjectless`, `rate_limited`,
  `shadow_mode`, `ai_answers_disabled`).
- `grounded`: true or false when the pipeline checked grounding, else null.
- `ticketId`: set when the thread is a ticket.
- Rows are kept 365 days.

```json
{
  "programId": "loadout",
  "since": 1791884970055,
  "until": 1792489770055,
  "total": 71,
  "limit": 2,
  "offset": 0,
  "byAction": {
    "silence": 36,
    "escalate": 21,
    "reply": 8,
    "uncertain": 6
  },
  "byReason": [
    {
      "finalAction": "silence",
      "reason": "ambient_chatter",
      "count": 20
    },
    {
      "finalAction": "escalate",
      "reason": "gap_escalated",
      "count": 19
    },
    {
      "finalAction": "reply",
      "reason": "grounded",
      "count": 8
    },
    {
      "finalAction": "silence",
      "reason": "thread_humans_talking",
      "count": 8
    },
    {
      "finalAction": "silence",
      "reason": "help_chatter",
      "count": 6
    },
    {
      "finalAction": "uncertain",
      "reason": "ungrounded",
      "count": 6
    },
    {
      "finalAction": "escalate",
      "reason": "sensitive",
      "count": 2
    },
    {
      "finalAction": "silence",
      "reason": "subjectless",
      "count": 2
    }
  ],
  "rows": [
    {
      "id": 456,
      "channel": "C0DEVMAIN1",
      "threadTs": "1792485461.000462",
      "messageTs": "1792485461.000462",
      "ticketId": null,
      "channelRole": "main",
      "addressed": false,
      "finalAction": "silence",
      "reason": "ambient_chatter",
      "grounded": null,
      "latencyMs": 277,
      "createdAt": 1792485461047
    },
    {
      "id": 460,
      "channel": "C0DEVHELP1",
      "threadTs": "1792482623.000466",
      "messageTs": "1792482623.000466",
      "ticketId": null,
      "channelRole": "help",
      "addressed": false,
      "finalAction": "silence",
      "reason": "ambient_chatter",
      "grounded": null,
      "latencyMs": 356,
      "createdAt": 1792482623376
    }
  ]
}
```

### GET `/internal/v1/programs/:id/members?channel=`

The people in one of the program's channels, for an invite picker: active
humans only (bots, app users, deactivated accounts and Slackbot are left
out), sorted by real name. Default channel: the program's organizer channel,
else its help channel. `channel` may name another channel of this program;
any other channel answers 400. It reads `conversations.members` and the
cached `users.info` lookups (needs `users:read`). At most 300 people per
channel (`truncated: true` beyond that); `unresolved` counts ids whose
lookup failed. Cached 10 minutes per channel (failures 1 minute). No Slack
connection answers 503 `{"programId":"loadout","channel":"C0DEVORG01","error":"slack not connected"}`.

A full workspace `users.list` is not used on purpose: in a large workspace it
is thousands of pages.

```json
{
  "programId": "loadout",
  "channel": "C0DEVORG01",
  "fetchedAt": 1792489699548,
  "truncated": false,
  "unresolved": 0,
  "members": [
    {
      "id": "U0CAL0001",
      "handle": "coal-newt",
      "realName": "Cal Nguyen",
      "displayName": "coal-newt"
    },
    {
      "id": "U0JUNO001",
      "handle": "pixel-otter",
      "realName": "Juno Baker",
      "displayName": "pixel-otter"
    },
    {
      "id": "U0LEILA01",
      "handle": "copper-wren",
      "realName": "Leila Haddad",
      "displayName": "copper-wren"
    }
  ]
}
```

(Trimmed to 3 of the 12 people the dev bridge returns.)

## Changed routes

### GET `/internal/v1/programs/:id/tickets/:ticketId` and GET `/internal/v1/tickets/:id`

Both now return the newest events instead of the oldest 100: `eventsLimit`
(default 100, max 200) newest events, oldest-first within the page, plus
`eventsTotal`, `eventsOffset`, `eventsLimit` and `eventsHasOlder`. Page back
with `eventsOffset`. For a ticket with 100 events or fewer the list is the
same as before. The rest of the response is unchanged, so it still carries
the question and event texts (`requester_followup`, `helper_reply` details):
strip them as PLAN 2.4 rule 18 says.

`GET /internal/v1/programs/loadout/tickets/100?eventsLimit=3`:

```json
{
  "ticket": {
    "id": 100,
    "program_id": "loadout",
    "channel": "C0DEVHELP1",
    "thread_ts": "1790190433.000100",
    "card_ts": "1790190553.600100",
    "requester_id": "U0KID0022",
    "question": "How long does review take for a Tools track project?",
    "status": "resolved",
    "assignee_id": "U0LEILA01",
    "resolution": "resolved by <@U0LEILA01>",
    "created_at": 1790190433794,
    "claimed_at": 1790196105043,
    "resolved_at": 1790359923469,
    "workspace_id": "T0DEVWS01",
    "category": "review",
    "category_source": "human",
    "priority": "normal",
    "summary": null,
    "resolution_summary": null,
    "resolution_summary_at": null,
    "ai_confidence": null,
    "ai_decision": null,
    "duplicate_of": null,
    "first_response_at": 1790198394052,
    "first_human_response_at": 1790198394052,
    "visibility": "thread",
    "assigned_at": 1790196105043,
    "reopened_at": 1790350762933,
    "reopen_count": 1,
    "snoozed_until": null,
    "updated_at": 1790359923469,
    "public_ack_ts": "1790190553.500100",
    "resolved_by": "U0LEILA01",
    "resolved_credit_id": "U0LEILA01",
    "reopened_by": "U0KID0022",
    "last_human_reply_at": 1790352967874,
    "text_redacted_at": null,
    "text_redaction": null,
    "resolutionSummary": null
  },
  "resolutionSummary": null,
  "events": [
    {
      "id": 775,
      "ticket_id": 100,
      "program_id": "loadout",
      "actor_id": "U0KID0022",
      "event_type": "requester_followup",
      "detail": "{\"text\":\"Do I need to do anything else?\"}",
      "created_at": 1790350762933
    },
    {
      "id": 776,
      "ticket_id": 100,
      "program_id": "loadout",
      "actor_id": "U0LEILA01",
      "event_type": "helper_reply",
      "detail": "{\"via\":\"thread\"}",
      "created_at": 1790352967874
    },
    {
      "id": 777,
      "ticket_id": 100,
      "program_id": "loadout",
      "actor_id": "U0LEILA01",
      "event_type": "resolved",
      "detail": null,
      "created_at": 1790359923469
    }
  ],
  "eventsTotal": 14,
  "eventsOffset": 0,
  "eventsLimit": 3,
  "eventsHasOlder": true,
  "notes": []
}```

### GET `/internal/v1/programs/:id/tickets/search`

New query parameters, combinable with the old ones:

| Parameter | Effect |
|---|---|
| `status=a,b,c` | Several statuses (up to 10, trimmed, deduped). One value works as before. |
| `unassigned=1` | No assignee. |
| `hasAssignedAt=1` | `assigned_at` is set; with `status=open` this finds released tickets. |
| `visibility=dashboard` | Only that visibility. |

Rows are the full ticket rows as before (they include `question`), now with
the new columns `last_human_reply_at`, `text_redacted_at` and
`text_redaction`. `status=claimed,reopened&limit=1`:

```json
{
  "total": 9,
  "rows": [
    {
      "id": 150,
      "program_id": "loadout",
      "channel": "C0DEVHELP1",
      "thread_ts": "1792410545.000150",
      "card_ts": "1792410665.600150",
      "requester_id": "U0KID0004",
      "question": "How long does review take for a Tools track project?",
      "status": "claimed",
      "assignee_id": "U0JUNO001",
      "resolution": null,
      "created_at": 1792410545585,
      "claimed_at": 1792414072814,
      "resolved_at": null,
      "workspace_id": "T0DEVWS01",
      "category": "review",
      "category_source": "human",
      "priority": "high",
      "summary": null,
      "resolution_summary": null,
      "resolution_summary_at": null,
      "ai_confidence": null,
      "ai_decision": null,
      "duplicate_of": null,
      "first_response_at": 1792410641743,
      "first_human_response_at": null,
      "visibility": "thread",
      "assigned_at": 1792414072814,
      "reopened_at": null,
      "reopen_count": 0,
      "snoozed_until": null,
      "updated_at": 1792414072814,
      "public_ack_ts": "1792410665.500150",
      "resolved_by": null,
      "resolved_credit_id": null,
      "reopened_by": null,
      "last_human_reply_at": null,
      "text_redacted_at": null,
      "text_redaction": null,
      "first_responder_id": null,
      "notes_count": 0
    }
  ]
}```

### GET `/internal/v1/programs/:id/audit`

New query parameters: `action` (exact, or a prefix when it ends in `*`, so
`ticket.*` matches `ticket.resolved` but not `ticket_x`), `since`, `until`,
`offset`. `limit` is still 1-500. With none of them the response is as
before. `metadata` is the event detail as a JSON string and can hold text:
strip it except for the actions the site whitelists (`sla.notified`).

`action=sla.notified&limit=1`:

```json
[
  {
    "id": 829,
    "program_id": "loadout",
    "actor_id": null,
    "action": "sla.notified",
    "entity_type": "ticket",
    "entity_id": "139",
    "metadata": "{\"rule\":\"unassigned\"}",
    "created_at": 1792121555533
  }
]```

### Unchanged routes the site depends on

- `POST /internal/v1/slack/users/info` (`{"userIds": [...]}`, up to 200) and
  `GET /internal/v1/slack/users/info?user=` keep their response shapes. They
  only work once the app has `users:read`; without it every lookup is
  `ok: false` with a `missing_scope` reason.

## Changed data (no new route)

| Change | Where it shows | Notes |
|---|---|---|
| `tickets.last_human_reply_at` | ticket rows (search, detail), `lastHumanReplyAt` on the closing route | Moves forward on every reply by a helper or admin, including repeat thread replies, dashboard replies and replies found by the history import. Never moves back, never touches `updated_at`. Existing tickets were backfilled once from their newest `helper_reply` event, so for old tickets it is a lower bound. Exact "no human reply since the reopen": `last_human_reply_at IS NULL OR last_human_reply_at < reopened_at`. |
| `tickets.text_redacted_at`, `tickets.text_redaction` | ticket rows | Set when the participant deleted (`deleted`) or edited (`edited`) the ticket's root message in Slack. On delete, `question` is `""`, `summary` and `resolution_summary` are null, `resolution` keeps only the `auto-resolved:` label, and every event and audit row of the ticket has its `text` and `reason` removed (`"redacted": true`). On edit, only `question` and `summary` are removed; the new text is not stored. A `root_message_deleted` or `root_message_edited` event (no detail) marks the moment. A deleted or edited reply loses the stored text of the event recorded for that message. The site should show its tombstone wording when `text_redaction` is set. |
| History import no longer finishes live tickets | ticket rows, closing route | The import now resolves or closes only tickets it imported (dashboard-only and created by the import). Before, it could close a live ticket as "no answer (history import)" or resolve it with its own last-word rule. Rows written before this change are not rewritten. |

## What each change unblocks on the site

| Gap | Commit | Unblocks |
|---|---|---|
| G18 bind safety | `d51bf40` | Safe co-location on one host: Core on `127.0.0.1:4100`, a stray `PORT` cannot move it, a busy port cannot kill the bot. |
| G17 read-only token | `ddef13f` | The site (or its proxy) holds a token that cannot write. Gate for phase 2. |
| G27 access route | `fb60cf0` | One access rule: sign-in checks organizer or helper against Core, no second admin list. |
| G9 closing route | `26ea2f2` | Exact "closed by Orry" split (K17), who finished it, queue times (K10, K22, K23, K30), ping-to-claim rates, without one detail call per ticket. |
| G10 newest events | `124add3` | Long tickets' timelines show the latest reply, reopen and close. |
| G29 last human reply | `5bb53ba` | Exact over-limit rule for reopened tickets (K4). |
| G25 importer fix | `bd8881b` | Trustworthy "who finished it" for live tickets. |
| G7 audit filters | `6780a36` | SLA history (`action=sla.notified`), other action timelines and K28 without paging everything. |
| G11 search filters | `15f6900` | Smaller board fetches on the large path (`status=a,b`, `unassigned=1`, `hasAssignedAt=1`, `visibility`). |
| G31 deletes and edits | `e2eebdd` | Ticket text that disappears when the participant deletes it; tombstones instead of the copy notice. |
| G1/G15 outbound log | `0be174b`, `5e84bd4`, `2c137dd`, `f34f923` | The message log page, exact report text, answer text, O40, O41, O45. |
| G13 log to ticket links | `e751adb` | Per-ticket "what Orry said" (K31), and redaction of cards that quote a deleted question. |
| G30 answer outcomes | `54adf1f` | An Answers funnel that adds up (reply, uncertain, escalate, silence, by reason). |
| G12 users:read | `3d9e180` | Names for helpers and organizers through users/info. |
| Members route | `8277083` | The invite form's people picker. |
| Dev bridge | the last commit | The site's real bridge path runs locally on invented data. |

## Notes for the site's data layer

- Only rows of the program in the path are ever returned by the routes on
  this page. The existing global routes (`GET /internal/v1/programs`,
  `GET /internal/v1/usage`) are unchanged and still global: keep filtering
  them to `loadout`.
- Routes that carry participant text: ticket search and detail (`question`,
  event `detail`), audit (`metadata`) and the outbound log (`text`: Orry's
  own words, which can quote a question). The closing, access, outcomes and
  members routes carry none.
- The closing route is the source for finished-ticket numbers. Page it with
  `limit=500`; `total` tells you when you are done.
- `firstTaken.by` on an `assigned` event is the assignee, not the actor.
- `pings` lists only ping offers. Queue offers (`source` `queue`, `auto`,
  `released`, `reopened`) are not returned.
- Answer outcomes are written only by messages that reach the answer
  pipeline. The sensitive-topic escalation in the message handler, commands
  and macros write no row, so read the counts as "handled by the answer
  pipeline", not "every message".
- The members route lists one channel. Use the organizer channel (the
  default) for the invite form.

## Running it locally: the dev bridge

```
cd orry-bot-patched
bun install
bun run dev:bridge          # http://127.0.0.1:4100, fresh invented data each run
```

It prints the tokens. Unless `RIVET_INTERNAL_TOKEN` or
`RIVET_INTERNAL_READ_TOKEN` are set in its environment, they are the fixed
local values `dev-bridge-local-token` (full) and `dev-bridge-read-token`
(GET routes and the users/info batch only). Point the site at it with
`RIVET_CORE_BASE_URL=http://127.0.0.1:4100` and the read token.

What it is:

- Only Core's web server. No Slack connection, no model keys, no corpus
  refresh, no SLA, radar or resolution loops. It binds `127.0.0.1` only.
- It removes Slack and model keys from its own environment (Bun loads a
  `.env` by itself), so a developer's real keys are never used.
- A fake Slack client answers `users.info` and channel membership from the
  invented people and refuses anything that would post or change Slack. A
  write route that tries to post (a ticket reply, for example) fails with
  `dev_bridge_no_slack`; claim, resolve and other database-only writes work.
- The database is a fresh temp file per port, replaced on every run.
  `--db <file>` keeps one and seeds it only while it has no tickets.
- The seed is deterministic for a given `--seed` and start time: 150 tickets
  over the 12 ISO weeks ending this week (125 finished, 25 open or parked),
  about 1,100 events, about 870 audit rows, about 360 outbound log rows and
  480 answer outcomes. Program `loadout`, workspace `T0DEVWS01`, channels
  `C0DEVHELP1` (help), `C0DEVMAIN1` (main), `C0DEVORG01` (organizers).
- People (ids match the site's `lib/data/fixtures/people.ts`): organizer
  `U0PAT0001`; helpers `U0JUNO001`, `U0LEILA01`, `U0RAVI001`, `U0MIA0001`,
  `U0NOAH001`, `U0ZARA001`, `U0TESS001`, `U0SAM0001`; others in the
  workspace `U0QUIN001`, `U0OLI0001`, `U0CAL0001`, `U0MAX0001`, `U0FERN001`,
  `U0OTHER01`; participants `U0KID0001` to `U0KID0040` ("Maker 01" to
  "Maker 40"); one bot, `U0BOTDEV1`.
- Two invented tickets ask to talk to a human, so the site's sensitive-topic
  path has something to hide.

## Not covered by this series

- Ephemeral messages are not in the outbound log.
- G31 does not touch copies outside tickets, events, audit rows and the
  outbound log: `doc_gaps`, learned facts, the answer cache, in-memory thread
  context, and Slack cards Orry already posted keep their text. Backups age
  out on their own schedule.
- The members route lists at most 300 people of one channel.
- The weekly report, stats, gaps, ops alerts and knowledge health routes
  (G2-G6, G16, G21), the sensitive flag (G20), safe actions and data requests
  (G28) are not in this series.
