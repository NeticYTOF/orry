/* The six view-models the pages render (BUILD-BRIEF "Contracts between agents"). Plain JSON-serialisable objects. */
export { getBoardModel, boardChanges, rememberBoard, rowsFor, facetCounts, BOARD_VIEWS } from "./board";
export type { BoardModel, BoardQuery, BoardRow, BoardView, BoardChanges } from "./board";
export type { BoardFilters, AgeBucket, LimitChipKind } from "./boardTypes";
export { getTicketModel, revealTicket } from "./ticket";
export type { TicketModel, RevealResult } from "./ticket";
export { getStatsModel, weekHeader } from "./stats";
export type { StatsModel, StripItem, WeekHeader } from "./stats";
export { getClosedModel } from "./closed";
export type { ClosedModel, ClosedQuery, ClosedRow, ClosedBy } from "./closed";
export { getMeModel, getLeaderboardModel, setShowOnLeaderboard } from "./people";
export type { MeModel, LeaderboardModel, LeaderboardRow } from "./people";
export type { Freshness, PanelError, PanelState } from "./shared";
export type { PersonRef } from "../people";
export { preferences, setPreferencesStore, MemoryPreferences, setLogEvent } from "./deps";
export type { PreferencesStore } from "./deps";
export { getRewardsModel } from "./rewards";
export type { RewardsModel, Podium, PodiumEntry, Standing, CategoryKey } from "./rewards";
