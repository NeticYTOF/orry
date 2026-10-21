/* npm run dev: sets the local defaults (ORRY_DEV_AUTH=1, ORRY_FIXTURES=1, port 9995), seeds data/site.db if it
   is new, prints a short "try it" banner, then starts next dev. Values already set in the environment win. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dbPath, getDb, setDbForTests } from "../lib/db";
import { banner, seedDev } from "./seed-dev";

const PORT = "9995";
const defaults: Record<string, string> = {
  ORRY_DEV_AUTH: "1",
  ORRY_FIXTURES: "1",
  ORRY_SITE_URL: `http://localhost:${PORT}`
};
for (const [k, v] of Object.entries(defaults)) if (process.env[k] === undefined) process.env[k] = v;

const isNew = !fs.existsSync(dbPath());
getDb(); /* runs the migrations */
let seeded: ReturnType<typeof seedDev> | null = null;
if (isNew) {
  try { seeded = seedDev(process.env.ORRY_SITE_URL); } catch (e) { console.error("Seeding failed:", (e as Error).message); }
}
setDbForTests(null); /* close it; the server opens its own */
console.log(banner(process.env.ORRY_SITE_URL!, seeded));

const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "dev", "-H", "127.0.0.1", "-p", PORT, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
const stop = () => { if (!child.killed) child.kill("SIGINT"); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", code => process.exit(code ?? 0));
