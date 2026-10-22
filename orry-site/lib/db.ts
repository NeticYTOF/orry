/* The site's own database (data/site.db). It holds accounts, invites, access events and sessions:
   IDs, roles, times and labels only. Never ticket text, never names (PLAN 2.4 rule 2, 7.6). */
import type { DatabaseSync as DatabaseSyncT, SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/* process.getBuiltinModule keeps bundlers from trying to resolve node:sqlite. */
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

export type Db = DatabaseSyncT;
export type Row = Record<string, SQLInputValue>;

/* Each entry runs once, in order. user_version records how many have run. Never edit a shipped entry; add a new one. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE accounts (
    id              INTEGER PRIMARY KEY,
    slack_id        TEXT    NOT NULL UNIQUE,
    hca_sub         TEXT    UNIQUE,
    role            TEXT    NOT NULL CHECK (role IN ('helper', 'organizer')),
    status          TEXT    NOT NULL DEFAULT 'on' CHECK (status IN ('on', 'off')),
    created_at      INTEGER NOT NULL,
    created_by      TEXT,
    last_sign_in_at INTEGER
  );
  CREATE TABLE invites (
    id          INTEGER PRIMARY KEY,
    token_hash  TEXT    NOT NULL UNIQUE,
    slack_id    TEXT    NOT NULL,
    role        TEXT    NOT NULL CHECK (role IN ('helper', 'organizer')),
    created_by  TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    state       TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'used', 'cancelled')),
    used_at     INTEGER
  );
  CREATE INDEX invites_slack ON invites (slack_id);
  CREATE INDEX invites_creator ON invites (created_by, created_at);
  CREATE TABLE access_events (
    id               INTEGER PRIMARY KEY,
    at               INTEGER NOT NULL,
    actor_slack_id   TEXT,
    kind             TEXT    NOT NULL,
    subject_slack_id TEXT,
    reason           TEXT
  );
  CREATE INDEX access_events_at ON access_events (at);
  CREATE TABLE sessions (
    id_hash          TEXT    PRIMARY KEY,
    account_id       INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    created_at       INTEGER NOT NULL,
    last_seen_at     INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL,
    role_checked_at  INTEGER NOT NULL
  );
  CREATE INDEX sessions_account ON sessions (account_id);
  `,
  `
  CREATE TABLE used_one_time_passwords (
    digest      TEXT PRIMARY KEY,
    consumed_at INTEGER NOT NULL
  );
  CREATE TABLE one_time_attempts (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    window_start INTEGER NOT NULL,
    failures     INTEGER NOT NULL,
    locked_until INTEGER NOT NULL
  );
  `,
];

export function dbPath(): string {
  return process.env.ORRY_SITE_DB || path.join(process.cwd(), "data", "site.db");
}

export function openDb(file: string = dbPath()): Db {
  if (file !== ":memory:")
    fs.mkdirSync(path.dirname(path.resolve(/*turbopackIgnore: true*/ file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const v = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

export function schemaVersion(): number {
  return MIGRATIONS.length;
}

/* One connection per process. Kept on globalThis because Next can load this module more than once (route handlers, pages, dev reloads). */
const G = globalThis as unknown as { __orryDb?: Db; __orryDbPath?: string };

export function getDb(): Db {
  if (!G.__orryDb) {
    G.__orryDbPath = dbPath();
    G.__orryDb = openDb(G.__orryDbPath);
  }
  return G.__orryDb;
}

/** Tests only: use this database (for example openDb(":memory:")), or null to reopen from ORRY_SITE_DB. */
export function setDbForTests(db: Db | null): void {
  if (G.__orryDb && G.__orryDb !== db) {
    try {
      G.__orryDb.close();
    } catch {
      /* already closed */
    }
  }
  G.__orryDb = db ?? undefined;
}

/** Runs fn inside BEGIN IMMEDIATE ... COMMIT. Nested calls join the outer transaction. */
let depth = 0;
export function tx<T>(fn: (db: Db) => T): T {
  const db = getDb();
  if (depth > 0) return fn(db);
  db.exec("BEGIN IMMEDIATE");
  depth++;
  try {
    const out = fn(db);
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* nothing to roll back */
    }
    throw e;
  } finally {
    depth--;
  }
}

/* The clock for every auth decision. Tests move it with setNowForTests. */
const C = globalThis as unknown as { __orryNow?: number | null };
export const now = (): number => C.__orryNow ?? Date.now();
export function setNowForTests(ms: number | null): void {
  C.__orryNow = ms;
}
