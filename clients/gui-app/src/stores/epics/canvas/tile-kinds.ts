import { makeLiteralGuard } from "@/lib/type-guard";
const TILE_KIND_CHAT = "chat";
const TILE_KIND_TERMINAL_AGENT = "terminal-agent";
const TILE_KIND_SPEC = "spec";
const TILE_KIND_TICKET = "ticket";
const TILE_KIND_STORY = "story";
const TILE_KIND_REVIEW = "review";
const TILE_KIND_TERMINAL = "terminal";
const TILE_KIND_WORKSPACE_FILE = "workspace-file";
export const TILE_KIND_GIT_DIFF = "git-diff";
export const TILE_KIND_SNAPSHOT_DIFF = "snapshot-diff";
// A read-only window on one shell's log timeline. Renderer-local like
// `terminal`: the tile points at a shell the host owns, it does not carry one.
export const TILE_KIND_MANAGED_COMMAND_OUTPUT = "managed-command-output";
/**
 * The per-epic communication graph. Epic-scoped rather than host-scoped: the
 * tile itself fans in one `epic.communicationGraph.subscribe` per host the
 * epic's agents live on, so it carries no host binding (see
 * `CommGraphTileRef`).
 */
export const TILE_KIND_COMM_GRAPH = "comm-graph";
/**
 * A chat this device can only READ: its owning host is out of reach, so the
 * tile renders the last copy that host published to the cloud.
 *
 * A kind of its own rather than a flag on the chat tile, because the ref names
 * WHICH THING is open - a published copy or a live session - and those are two
 * different things that can carry the SAME chat id. A fork leaves exactly that
 * geometry behind: two lineages under one id, one live here and one owned by
 * another machine. Keeping the kinds distinct also survives the owning host
 * coming back, where the same row becomes openable live and both must be
 * addressable at once.
 */
export const TILE_KIND_PUBLISHED_CHAT = "published-chat";
export const TILE_KIND_PR_DETAIL = "pr-detail";
export const TILE_KIND_PR_DIFF = "pr-diff";
// A "blank" tab: a real strip tab whose body renders the inline opener until
// content is picked (which replaces it in place).
export const TILE_KIND_BLANK = "blank";

export type TileKindId =
  | typeof TILE_KIND_CHAT
  | typeof TILE_KIND_TERMINAL_AGENT
  | typeof TILE_KIND_SPEC
  | typeof TILE_KIND_TICKET
  | typeof TILE_KIND_STORY
  | typeof TILE_KIND_REVIEW
  | typeof TILE_KIND_TERMINAL
  | typeof TILE_KIND_WORKSPACE_FILE
  | typeof TILE_KIND_GIT_DIFF
  | typeof TILE_KIND_SNAPSHOT_DIFF
  | typeof TILE_KIND_MANAGED_COMMAND_OUTPUT
  | typeof TILE_KIND_COMM_GRAPH
  | typeof TILE_KIND_PUBLISHED_CHAT
  | typeof TILE_KIND_PR_DETAIL
  | typeof TILE_KIND_PR_DIFF
  | typeof TILE_KIND_BLANK;

export const isTileKind = makeLiteralGuard<TileKindId>({
  [TILE_KIND_CHAT]: true,
  [TILE_KIND_TERMINAL_AGENT]: true,
  [TILE_KIND_SPEC]: true,
  [TILE_KIND_TICKET]: true,
  [TILE_KIND_STORY]: true,
  [TILE_KIND_REVIEW]: true,
  [TILE_KIND_TERMINAL]: true,
  [TILE_KIND_WORKSPACE_FILE]: true,
  [TILE_KIND_GIT_DIFF]: true,
  [TILE_KIND_SNAPSHOT_DIFF]: true,
  [TILE_KIND_MANAGED_COMMAND_OUTPUT]: true,
  [TILE_KIND_COMM_GRAPH]: true,
  [TILE_KIND_PUBLISHED_CHAT]: true,
  [TILE_KIND_PR_DETAIL]: true,
  [TILE_KIND_PR_DIFF]: true,
  [TILE_KIND_BLANK]: true,
});
