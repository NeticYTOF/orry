/* /board: the open tickets board (PLAN 4.1). The server reads the model once and renders the whole page;
   BoardClient then filters in the browser and polls for changes. */
import type { Metadata } from "next";
import { BoardClient } from "@/components/board/BoardClient";
import { parseUi } from "@/components/board/boardState";
import { readPrefs } from "@/components/shell/prefs-server";
import { getBoardModel, rememberBoard } from "@/lib/models";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Board" };
export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function BoardPage({ searchParams }: { searchParams: SP }) {
  const s = await requireSession("helper");
  const sp = await searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") params.set(k, v);
  const ui = parseUi(params);
  const [model, prefs] = await Promise.all([getBoardModel(s, { view: ui.view }), readPrefs()]);
  rememberBoard(model);   // so the first poll can say "n changes" against what this page shows
  return <BoardClient initial={model} initialUi={ui} roomy={prefs.density === "roomy"} />;
}
