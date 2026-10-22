/* "/" goes to the board when signed in, else to sign-in. */
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  redirect((await getSession()) ? "/board" : "/sign-in");
}
