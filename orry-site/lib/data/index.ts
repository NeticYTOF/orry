/* Chooses where data comes from. ORRY_FIXTURES=1 (the local default) uses invented data; ORRY_FIXTURES=0 reads the Core bridge. */
import type { DataSource } from "./types";
import { FixtureSource } from "./fixtures/source";
import { BridgeSource } from "./bridge/source";

let cached: DataSource | null = null;

export function dataMode(): "fixtures" | "bridge" {
  return process.env.ORRY_FIXTURES === "0" ? "bridge" : "fixtures";
}

export function getDataSource(): DataSource {
  if (cached) return cached;
  // BridgeSource never throws on construction: missing config shows as the offline state.
  cached = dataMode() === "bridge" ? new BridgeSource() : new FixtureSource();
  return cached;
}

/** Tests only: swap or clear the cached source. */
export function setDataSourceForTests(ds: DataSource | null): void {
  cached = ds;
}

export type { DataSource, Health, Person } from "./types";
