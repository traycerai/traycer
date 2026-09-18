import type { ComposerToolbarValues } from "@/stores/composer/composer-toolbar-store";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";
import type { ChatTurnMinimapItem } from "@/components/chat/chat-turn-minimap-logic";
import type { ChatDockCompactChipModel } from "@/components/chat/chat-dock-compact-context";
import type { LeftPanelAvailabilityContext } from "@/components/epic-canvas/sidebar/left-panel-registry";

export const SAMPLE_USAGE_USED_PERCENT = 57;
export const SAMPLE_CHANGED_FILE = {
  path: "src/task-list.tsx",
  additions: 12,
  deletions: 3,
};
export const SAMPLE_AGENT = {
  count: 1,
  label: "Sample agent · Updating the task list",
};
export const SAMPLE_BACKGROUND = {
  count: 1,
  label: "Sample shell · Checking the task list",
};
export const SAMPLE_TOOLBAR_VALUES: ComposerToolbarValues = {
  permission: "supervised",
  selection: {
    harnessId: "claude",
    modelSlug: "sample-model",
    profileId: null,
  },
  reasoning: "medium",
  serviceTier: "",
};
export const SAMPLE_TILE_ID = "sample-workspace";
export const CONTEXT_USAGE_PREVIEW_SAMPLE: TokenUsage = {
  inputTokens: 56,
  outputTokens: 3,
  totalTokens: 946_959,
  contextTokens: 946_956,
  cacheReadInputTokens: 945_800,
  cacheCreationInputTokens: 1_100,
  contextWindow: 1_000_000,
};
export const SAMPLE_RAIL_PRESENCE: Omit<
  LeftPanelAvailabilityContext,
  "visibilityOverrideById"
> = {
  commentsPanelRevealed: false,
  hasActiveCommentableArtifact: false,
  hasPullRequests: false,
};
export const SAMPLE_TURNS = [
  {
    prompt: "Make the task list easier to scan.",
    reply:
      "I’ll group related tasks, give the titles more room, and keep the progress visible beside each item. The changes can stay within the existing list component.",
  },
  {
    prompt: "Keep the layout comfortable on smaller windows.",
    reply:
      "The list now uses the available width. Long titles wrap, metadata stays beside its task, and the controls keep their touch targets. The layout has no fixed content width.",
  },
  {
    prompt: "How should completed tasks look?",
    reply:
      "Completed tasks retain their titles and a clear completion mark. The muted secondary details keep attention on active work without hiding useful context.",
  },
  {
    prompt: "Add a short empty state as well.",
    reply:
      "The empty state explains what belongs here and provides one clear next action. It uses the same spacing and type scale as the populated list, so the page stays steady when the first task arrives.",
  },
  {
    prompt: "Check the keyboard flow.",
    reply:
      "The focus order follows the visual order: task title, task actions, then the next row. Each action has a readable name, and focus stays visible against the list background.",
  },
  {
    prompt: "Does the spacing still work with long descriptions?",
    reply:
      "Descriptions wrap beneath the title and keep a comfortable line length. Related details share one group, with more space between tasks than within them. This makes the hierarchy clear even when several rows contain multiple lines.",
  },
  {
    prompt: "Keep the existing colours.",
    reply:
      "The update uses the existing theme tokens. Completion, focus and secondary text keep their current meanings across light and dark themes. No extra palette or separate set of styles is needed.",
  },
  {
    prompt: "What is ready to review?",
    reply:
      "The task list has clearer grouping, responsive spacing, a useful empty state and a predictable keyboard order. One file changed, and the background check is running. This conversation and its counts are sample content for configuring your layout.",
  },
];
export const SAMPLE_MINIMAP_ITEMS: ReadonlyArray<ChatTurnMinimapItem> =
  SAMPLE_TURNS.map((turn, index) => ({
    key: `sample-turn-${index}`,
    messageId: `sample-turn-${index}`,
    rowIndex: index,
    endRowIndex: index,
    level: 1,
    label: turn.prompt,
  }));
export const SAMPLE_DOCK: ReadonlyArray<
  Omit<ChatDockCompactChipModel, "hotspotRef">
> = [
  {
    section: "filesChanged",
    glyph: "filesChanged",
    working: false,
    text: "1",
    lineDeltas: {
      additions: SAMPLE_CHANGED_FILE.additions,
      deletions: SAMPLE_CHANGED_FILE.deletions,
    },
    label: "Sample: one changed file, 12 additions and 3 deletions",
    pulseToken: null,
  },
  {
    section: "activeAgents",
    glyph: "activeAgents",
    working: true,
    text: "1",
    lineDeltas: null,
    label: "Sample: one active agent",
    pulseToken: null,
  },
  {
    section: "background",
    glyph: "background",
    working: true,
    text: "1",
    lineDeltas: null,
    label: "Sample: one background shell",
    pulseToken: null,
  },
];
export function sampleNoop(): void {}
