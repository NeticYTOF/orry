// Workspace-scoped IDs
import configModule = require("./config");

const { config } = configModule;

interface SlackBody {
  team_id?: string;
  team?: { id?: string };
}

const DEFAULT_WORKSPACE = "default";

function configuredWorkspaceId() {
  return ((process.env.ORRY_WORKSPACE_ID ?? process.env.RIVET_WORKSPACE_ID) || "").trim() || null;
}

function teamOfBody(body: SlackBody = {}): string | null {
  if (body.team_id) return body.team_id;
  if (body.team && body.team.id) return body.team.id;
  return null;
}

function explicitWorkspaceOf(event: SlackBody = {}, body: SlackBody = {}): string | null {
  if (event && typeof event.team === "string") return event.team;
  return teamOfBody(body);
}

function workspaceOf(event: SlackBody = {}, body: SlackBody = {}): string | null {
  return explicitWorkspaceOf(event, body) || configuredWorkspaceId();
}

function scopedKey(workspaceId: string | null, suffix: string): string {
  return `${workspaceId || DEFAULT_WORKSPACE}:${suffix}`;
}

function threadKey(workspaceId: string | null, threadTs: string): string {
  return scopedKey(workspaceId, threadTs);
}

function channelKey(workspaceId: string | null, channelId: string): string {
  return scopedKey(workspaceId, channelId);
}

export = { configuredWorkspaceId, explicitWorkspaceOf, workspaceOf, threadKey, channelKey, DEFAULT_WORKSPACE };
