/* Display preferences from cookies, for the first paint. Values outside the lists fall back to the defaults. */
import { cookies } from "next/headers";

export type DisplayPrefs = { theme: "dark" | "light"; people: "name" | "handle"; density: "standard" | "roomy" };
export const PREF_COOKIES = { theme: "orry-theme", people: "orry-people", density: "orry-density" } as const;

export function parsePrefs(get: (name: string) => string | undefined): DisplayPrefs {
  return {
    theme: get(PREF_COOKIES.theme) === "light" ? "light" : "dark",
    people: get(PREF_COOKIES.people) === "handle" ? "handle" : "name",
    density: get(PREF_COOKIES.density) === "roomy" ? "roomy" : "standard"
  };
}

export async function readPrefs(): Promise<DisplayPrefs> {
  const c = await cookies();
  return parsePrefs(n => c.get(n)?.value);
}
