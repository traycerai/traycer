/**
 * The per-window snapshot entries the landing writer emits for two raw
 * Terminal drafts: one whose account still follows the default, and one
 * whose account was chosen. The gui-app test asserts the writer output
 * equals this, and the desktop parser test reads the same entries.
 */
export const RAW_TERMINAL_FOLLOWS_DRAFT_ID = "draft-follows-default";
export const RAW_TERMINAL_CHOSEN_DRAFT_ID = "draft-chosen-terminal";

const RAW_TERMINAL_SETTINGS = {
  harnessId: "claude",
  model: "haiku",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const EMPTY_PROJECTION_CONTENT = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

const EMPTY_PROJECTION_WORKSPACE = {
  folders: [],
  folderInfoByPath: {},
  primaryPath: null,
};

export function rawTerminalLandingProjection(input: {
  readonly followsTouchedAt: number;
  readonly chosenTouchedAt: number;
}) {
  return [
    {
      id: RAW_TERMINAL_FOLLOWS_DRAFT_ID,
      content: EMPTY_PROJECTION_CONTENT,
      selection: null,
      lastTouchedAt: input.followsTouchedAt,
      settings: RAW_TERMINAL_SETTINGS,
      composerMode: "chat",
      workspace: EMPTY_PROJECTION_WORKSPACE,
      closed: false,
      accountFollowsDefault: true,
    },
    {
      id: RAW_TERMINAL_CHOSEN_DRAFT_ID,
      content: EMPTY_PROJECTION_CONTENT,
      selection: null,
      lastTouchedAt: input.chosenTouchedAt,
      settings: RAW_TERMINAL_SETTINGS,
      composerMode: "chat",
      workspace: EMPTY_PROJECTION_WORKSPACE,
      closed: false,
    },
  ];
}
