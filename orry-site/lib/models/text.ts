/* Slack markup to plain text for excerpts (PLAN 2.4 rule 9): user mentions become names, channel mentions labels,
   links their label. The UI escapes the result; nothing here returns HTML. */
import type { PersonRef } from "../people";

export const MENTION = /<@([UW][A-Z0-9]{2,20})(?:\|[^>]*)?>/g;

export function mentionIds(text: string): string[] {
  return [...text.matchAll(MENTION)].map(m => m[1]);
}

export function slackToPlain(text: string, people: ReadonlyMap<string, PersonRef>): string {
  return text
    .replace(MENTION, (_, id: string) => { const p = people.get(id); return p ? (p.name ?? p.handle ?? `@${id}`) : `@${id}`; })
    .replace(/<#([CG][A-Z0-9]+)\|([^>]+)>/g, (_, __, name: string) => `#${name}`)
    .replace(/<#([CG][A-Z0-9]+)>/g, "#channel")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function excerpt(text: string, n = 140): string {
  return text.length <= n ? text : text.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
}
