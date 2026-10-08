import type { ComposerToolbarValues } from "@/stores/composer/composer-toolbar-store";
import type { ComposerDictationControl } from "@/components/home/toolbar/composer-mic-button";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";
import type { ChatTurnMinimapItem } from "@/components/chat/chat-turn-minimap-logic";
import type { ChatDockCompactChipModel } from "@/components/chat/chat-dock-compact-context";
import type { LeftPanelAvailabilityContext } from "@/components/epic-canvas/sidebar/left-panel-registry";
import type {
  BackgroundItem,
  OpenChatQueueState,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { AccumulatedChangeRow } from "@/lib/chat/accumulated-change-rows";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";
import type { AgentRow } from "@/hooks/agent/use-agent-stop-controls";
import type { RateLimitWindowKind } from "@/lib/rate-limits/rate-limit-window-catalog";
import type { ResourceMetric } from "@/lib/layout/layout-values";
import type { PrLightItem } from "@traycer/protocol/host/pr-schemas";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import type { MessageSegment } from "@/stores/composer/chat-store";
import type { NeedsYouRow } from "@/components/layout/tabs/side-strip/strip-sections";
import type {
  StripAgent,
  StripAgentStatus,
} from "@/components/layout/tabs/side-strip/strip-task-agents";

/**
 * One sample data set for the canvas and every picture of it (C12): the
 * sample status bar, the depictions and the Style examples all read these, so
 * the form and the canvas can never print two different readings.
 */
export interface SampleUsageReading {
  readonly durationMinutes: number;
  readonly usedPercent: number;
  /** How far off the reset is, so the countdown differs per window too. */
  readonly resetsInMinutes: number;
  readonly kind: RateLimitWindowKind;
}

/**
 * The three readings a sample usage segment is taken from, by rotation.
 *
 * One short window part-way through, one long one further along and one day
 * window close to its limit: three different percentages, durations and
 * countdowns, so no two neighbouring segments print the same string.
 *
 * The day window is the one reading over a warning threshold (84% of a short
 * window is `running_low`, never `limited`). The status bar draws a healthy
 * profile as a bare bar and expands only one that needs attention, so a
 * sample with nothing running low would never draw the expanded form - the
 * one form Percent shows and Reset time change - and the layout editor's
 * picture of those two rows would not move.
 */
const SAMPLE_USAGE_READINGS: ReadonlyArray<SampleUsageReading> = [
  {
    durationMinutes: 5 * 60,
    usedPercent: 35,
    resetsInMinutes: 59,
    kind: "session",
  },
  {
    durationMinutes: 7 * 24 * 60,
    usedPercent: 78,
    resetsInMinutes: 2 * 24 * 60 + 12 * 60,
    kind: "weekly",
  },
  {
    durationMinutes: 24 * 60,
    usedPercent: 84,
    resetsInMinutes: 6 * 60 + 20,
    kind: "period",
  },
];

export function sampleUsageReading(index: number): SampleUsageReading {
  return SAMPLE_USAGE_READINGS[index % SAMPLE_USAGE_READINGS.length];
}

export const SAMPLE_USAGE_USED_PERCENT = SAMPLE_USAGE_READINGS[0].usedPercent;

/** The name a sample usage segment prints where a real account's would go. */
export const SAMPLE_ACCOUNT_LABEL = "Sample account";

/** The resource segment's sample readings, in the strip's own wording. */
export const SAMPLE_RESOURCE_VALUES: Readonly<Record<ResourceMetric, string>> =
  {
    cpu: "12%",
    memory: "1.2 GB",
    processes: "6",
    ramShare: "8%",
  };
export const SAMPLE_CHANGED_FILE = {
  path: "src/task-list.tsx",
  additions: 12,
  deletions: 3,
};

/**
 * The ids the sample dock's real panels are addressed by (L-98).
 *
 * They are strings no host ever mints, which is the point: the panels read
 * their own stores with them and get an empty answer, so the sample dock shows
 * exactly the sample data below and never joins a real chat's managed
 * commands, held shells or agent records.
 */
export const SAMPLE_EPIC_ID = "sample-workspace-epic";
export const SAMPLE_CHAT_ID = "sample-workspace-chat";
export const SAMPLE_VIEW_TAB_ID = "sample-workspace-tab";
export const SAMPLE_HOST_ID = "sample-workspace-host";

/**
 * The changed files the real "N files changed" panel lists (L-98).
 *
 * Three rows rather than one: the panel's header counts them and sums their
 * `+`/`-`, and a one-row list cannot show that the count and the totals are
 * two different measurements. `undoable` is true on all three so "Undo all"
 * draws enabled, which is the state the owner's own composer shows.
 */
export const SAMPLE_CHANGED_FILES: ReadonlyArray<AccumulatedChangeRow> = [
  {
    filePath: SAMPLE_CHANGED_FILE.path,
    operation: "edit",
    diffSource: "snapshot",
    reason: "snapshot",
    undoable: true,
    artifact: null,
    counts: {
      additions: SAMPLE_CHANGED_FILE.additions,
      deletions: SAMPLE_CHANGED_FILE.deletions,
    },
    hasContents: true,
    digest: null,
    liveDiff: null,
  },
  {
    filePath: "src/task-list-empty.tsx",
    operation: "create",
    diffSource: "snapshot",
    reason: "snapshot",
    undoable: true,
    artifact: null,
    counts: { additions: 28, deletions: 0 },
    hasContents: true,
    digest: null,
    liveDiff: null,
  },
  {
    filePath: "src/task-list.css",
    operation: "edit",
    diffSource: "snapshot",
    reason: "snapshot",
    undoable: true,
    artifact: null,
    counts: { additions: 7, deletions: 6 },
    hasContents: true,
    digest: null,
    liveDiff: null,
  },
];

/** What the panel's header and the Changed files chip both print. */
export const SAMPLE_CHANGE_TOTALS = { additions: 47, deletions: 9 };

/**
 * The restore context the changes panel reads.
 *
 * `accessRole: "owner"` with no active turn is what opens `revertGate`, so the
 * sample shows "Undo all" in its ENABLED state; the handler returns `null`,
 * the panel's own "handled, nothing to track", and the edit firewall swallows
 * the gesture at the app column before it is ever reached (L-131).
 */
export const SAMPLE_RESTORE: ChatRestoreContextValue = {
  accessRole: "owner",
  currentUserId: null,
  activeHostId: null,
  activeTurnStatus: null,
  localSnapshotsClearedAt: null,
  restore: null,
  restoreActionPending: false,
  restoreCheckpoint: sampleNoopAction,
  accumulatedFileChanges: SAMPLE_CHANGED_FILES,
  undeliveredChangeCount: 0,
  accumulatedSetComplete: true,
  revertFileChanges: sampleNoopAction,
};

/** The agent the real Active agents panel titles itself with, plus one child. */
export const SAMPLE_SELF_AGENT: AgentRow = {
  id: SAMPLE_CHAT_ID,
  title: "Sample agent",
  surface: "gui",
  activity: "turn",
  hostId: SAMPLE_HOST_ID,
};
export const SAMPLE_AGENT_DESCENDANTS: ReadonlyArray<AgentRow> = [
  {
    id: "sample-workspace-agent-child",
    title: "Sample reviewer",
    surface: "gui",
    activity: "turn",
    hostId: SAMPLE_HOST_ID,
  },
];

/** Two running shells, so the Background panel's summary counts more than one. */
export const SAMPLE_BACKGROUND_ITEMS: ReadonlyArray<BackgroundItem> = [
  {
    taskId: "sample-background-1",
    title: "bun run test src/task-list.test.tsx",
    blockId: "sample-background-block-1",
    parentTaskId: null,
    kind: "command",
    scheduledFor: null,
    individualStopUnavailable: null,
  },
  {
    taskId: "sample-background-2",
    title: "Sample shell · Checking the task list",
    blockId: "sample-background-block-2",
    parentTaskId: null,
    kind: "monitor",
    scheduledFor: null,
  },
];

/** The pinned Todo row, part-done so the panel's counts all have a value. */
export const SAMPLE_TODO: PinnedTodoSnapshot = {
  id: "sample-todo",
  items: [
    {
      id: "sample-todo-1",
      status: "completed",
      text: "Group related tasks",
      priority: null,
      activeForm: null,
    },
    {
      id: "sample-todo-2",
      status: "in_progress",
      text: "Give the titles more room",
      priority: null,
      activeForm: "Giving the titles more room",
    },
    {
      id: "sample-todo-3",
      status: "pending",
      text: "Add the empty state",
      priority: null,
      activeForm: null,
    },
  ],
};

/**
 * One queued prompt, so the canvas shows the queue where it always sits:
 * directly on the composer, in every preset (it is not a region, G1-G2).
 */
export const SAMPLE_QUEUE: OpenChatQueueState = {
  status: "running",
  items: [
    {
      kind: "prompt",
      queueItemId: "sample-queue-1",
      messageId: "sample-queue-1-message",
      message: {
        kind: "user",
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Then check the keyboard order." },
              ],
            },
          ],
        },
        browserAnnotations: [],
      },
      sender: { type: "user", userId: "sample-user" },
      sentFromHostId: null,
      settings: {
        harnessId: "claude",
        model: "sample-model",
        permissionMode: "supervised",
        reasoningEffort: "medium",
        serviceTier: null,
        agentMode: "epic",
        profileId: null,
      },
      accountContext: { type: "PERSONAL" },
      delivery: "next_turn",
      status: "pending",
      targetTurnId: null,
      steerRequest: null,
      fallbackReason: null,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
};

/** Nothing in the sample dock has a stop in flight. */
export const SAMPLE_NO_PENDING_STOPS: ReadonlySet<string> = new Set<string>();

/**
 * The dictation control the mic slot needs before it draws anything (L-116).
 *
 * `ComposerMicSlot` returns null without one whatever Layout ▸ Microphone says,
 * because withholding the control is how `voiceInputEnabled` turns the feature
 * off - right for the real composer, wrong for a scene whose job is to depict
 * the toolbar in each state (L-98). `idle` is the state the chip rests in, so
 * the sample draws the plain mic the user is choosing to keep or remove, and
 * `getStream` answers the recording bar's one question with "no stream" - a
 * question it never asks, since nothing in this scene can start recording.
 */
export const SAMPLE_DICTATION: ComposerDictationControl = {
  state: "idle",
  onToggle: sampleNoop,
  onStop: sampleNoop,
  onCancel: sampleNoop,
  getStream: sampleNoStream,
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
/** Context left in the sample chat: room to spare, so nothing reads as a warning. */
export const SAMPLE_CONTEXT_PERCENT_LEFT = 36;
export const CONTEXT_USAGE_PREVIEW_SAMPLE: TokenUsage = {
  inputTokens: 56,
  outputTokens: 3,
  totalTokens: 640_000,
  contextTokens: 640_000,
  cacheReadInputTokens: 638_841,
  cacheCreationInputTokens: 1_100,
  contextWindow: 1_000_000,
};
/** When the sample's pull requests and comments are stamped from. */
const SAMPLE_EPOCH = Date.now();
const MINUTE_MS = 60_000;

/** The task's name, as the sidebar's task header names it. */
export const SAMPLE_TASK_TITLE = "Sample task";

/**
 * The Agents panel's rows: how long ago each was last active, and what each is
 * using. The three add up to the status bar's sample resource reading.
 */
export const SAMPLE_SIDEBAR_AGENTS: ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly idleMinutes: number;
  readonly resources: {
    readonly cpuPercent: number;
    readonly rssBytes: number;
    readonly processCount: number;
  };
}> = [
  {
    id: "sample-sidebar-agent-1",
    title: "Plan the migration",
    idleMinutes: 0,
    resources: { cpuPercent: 7, rssBytes: 640 * 2 ** 20, processCount: 3 },
  },
  {
    id: "sample-sidebar-agent-2",
    title: "Write the tests",
    idleMinutes: 10,
    resources: { cpuPercent: 4, rssBytes: 384 * 2 ** 20, processCount: 2 },
  },
  {
    id: "sample-sidebar-agent-3",
    title: "Rebuild the index",
    idleMinutes: 18,
    resources: { cpuPercent: 1, rssBytes: 205 * 2 ** 20, processCount: 1 },
  },
];

/**
 * The same three agents as the Activity view nests them under the task's tab
 * (D9), in its list order and one in each state that reads differently there:
 * waiting on a reply, stopped on an error, and working. The canvas's strip and
 * every picture of it draw these.
 */
export const SAMPLE_LIVE_AGENTS: ReadonlyArray<StripAgent> = [
  sampleLiveAgent(SAMPLE_SIDEBAR_AGENTS[0], "waiting", "interview"),
  sampleLiveAgent(SAMPLE_SIDEBAR_AGENTS[2], "failed", "failure"),
  sampleLiveAgent(SAMPLE_SIDEBAR_AGENTS[1], "turn", "running"),
];

/**
 * The sample task's row in the Activity view's sections: waiting on the reply
 * its first agent asks for, so the layout editor's strip shows a Needs you row
 * over the agents nested under it.
 */
export const SAMPLE_NEEDS_YOU_ROW: NeedsYouRow = {
  section: "needs-you",
  reason: "reply",
  agentTitle: SAMPLE_SIDEBAR_AGENTS[0].title,
  count: 1,
  createdAt: SAMPLE_EPOCH - 2 * MINUTE_MS,
};

function sampleLiveAgent(
  agent: (typeof SAMPLE_SIDEBAR_AGENTS)[number],
  status: StripAgentStatus,
  kind: StripAgent["kind"],
): StripAgent {
  return {
    id: agent.id,
    title: agent.title,
    status,
    kind,
    since: SAMPLE_EPOCH - agent.idleMinutes * MINUTE_MS,
  };
}

/** The Artifacts panel's rows; the first is the open, commented artifact. */
export const SAMPLE_SIDEBAR_ARTIFACTS: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
}> = [
  { id: "sample-sidebar-artifact-1", name: "Onboarding flow spec" },
  { id: "sample-sidebar-artifact-2", name: "Release notes draft" },
];

/** The artifact open in the sample task, which the comment threads are on. */
export const SAMPLE_OPEN_ARTIFACT_ID = SAMPLE_SIDEBAR_ARTIFACTS[0].id;

const SAMPLE_REPO = { owner: "sample", repo: "task-app" } as const;

function samplePullRequest(
  item: Pick<
    PrLightItem,
    | "state"
    | "title"
    | "headRefName"
    | "additions"
    | "deletions"
    | "checksRollup"
    | "reviewDecision"
    | "commentCount"
  > & { readonly prNumber: number; readonly updatedMinutesAgo: number },
): PrLightItem {
  const updatedAt = SAMPLE_EPOCH - item.updatedMinutesAgo * MINUTE_MS;
  return {
    githubHost: "github.com",
    base: { ...SAMPLE_REPO, prNumber: item.prNumber },
    // No URL: a sample PR has nowhere to open.
    prUrl: null,
    state: item.state,
    liveness: "live",
    observedAt: updatedAt,
    isDraft: false,
    title: item.title,
    baseRefName: "main",
    headRefName: item.headRefName,
    additions: item.additions,
    deletions: item.deletions,
    checksRollup: item.checksRollup,
    reviewDecision: item.reviewDecision,
    commentCount: item.commentCount,
    updatedAt,
    repoIdentifier: SAMPLE_REPO,
    repoRole: "superproject",
    linkGroupKey: null,
    owners: [],
  };
}

/** The Pull requests panel's rows: the task's open change and a merged one. */
export const SAMPLE_PULL_REQUESTS: ReadonlyArray<PrLightItem> = [
  samplePullRequest({
    prNumber: 42,
    state: "open",
    title: "Group related tasks in the list",
    headRefName: "sample/group-tasks",
    additions: 128,
    deletions: 34,
    checksRollup: { success: 4, failure: 0, pending: 1, total: 5 },
    reviewDecision: "review_required",
    commentCount: 2,
    updatedMinutesAgo: 12,
  }),
  samplePullRequest({
    prNumber: 41,
    state: "merged",
    title: "Add an empty state to the task list",
    headRefName: "sample/empty-state",
    additions: 46,
    deletions: 8,
    checksRollup: { success: 5, failure: 0, pending: 0, total: 5 },
    reviewDecision: "approved",
    commentCount: 1,
    updatedMinutesAgo: 3 * 60,
  }),
];

function sampleCommentThread(thread: {
  readonly threadId: string;
  readonly quotedText: string;
  readonly minutesAgo: number;
  readonly comments: ReadonlyArray<{
    readonly handle: string;
    readonly text: string;
  }>;
}): CommentThreadWire {
  const createdAt = SAMPLE_EPOCH - thread.minutesAgo * MINUTE_MS;
  const first = thread.comments[0];
  return {
    threadId: thread.threadId,
    resolved: false,
    createdAt,
    data: {
      createdByUserId: `sample-user-${first.handle}`,
      createdByHandle: first.handle,
      quotedText: thread.quotedText,
    },
    comments: thread.comments.map((comment, index) => ({
      commentId: `${thread.threadId}-${index}`,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: comment.text }],
          },
        ],
      },
      createdAt: createdAt + index * MINUTE_MS,
      updatedAt: null,
      author: {
        userId: `sample-user-${comment.handle}`,
        fallbackHandle: comment.handle,
      },
    })),
  };
}

/** The Comments panel's threads, on the open artifact. */
export const SAMPLE_COMMENT_THREADS: ReadonlyArray<CommentThreadWire> = [
  sampleCommentThread({
    threadId: "sample-thread-1",
    quotedText: "Completed tasks move to the bottom of the list",
    minutesAgo: 40,
    comments: [
      {
        handle: "alex",
        text: "Should they stay in place until the list is refreshed?",
      },
      { handle: "sam", text: "Good call, moving them right away is jarring." },
    ],
  }),
  sampleCommentThread({
    threadId: "sample-thread-2",
    quotedText: "Show the empty state when no tasks match",
    minutesAgo: 25,
    comments: [
      { handle: "sam", text: "Let's add a shortcut to clear the filter here." },
    ],
  }),
];

/**
 * Whether the sample task has what each Auto panel waits for, read off the
 * fixtures themselves, so a panel is present exactly when it has rows to
 * show (C2, C3).
 */
export const SAMPLE_RAIL_PRESENCE: Omit<
  LeftPanelAvailabilityContext,
  "visibilityOverrideById"
> = {
  commentsPanelRevealed: SAMPLE_COMMENT_THREADS.length > 0,
  // `SAMPLE_OPEN_ARTIFACT_ID` is always the open artifact.
  hasActiveCommentableArtifact: true,
  hasPullRequests: SAMPLE_PULL_REQUESTS.length > 0,
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
/**
 * When each sample prompt was sent: today, a minute apart, ending at 10:42.
 * Today so the stamp reads as a clock time the way a fresh chat's does.
 */
export function sampleSentAt(turnIndex: number): number {
  const sent = new Date();
  sent.setHours(10, 42 - (SAMPLE_TURNS.length - 1 - turnIndex), 0, 0);
  return sent.getTime();
}

/** What a picture of a timestamp prints, matching the last sample prompt. */
export const SAMPLE_MESSAGE_TIME_LABEL = "10:42 AM";

/**
 * The agent's work inside two sample turns, drawn through the real activity
 * rows so Tool activity and Thinking each have a row on the canvas: a run of
 * reasoning alone before one reply, and a run of commands before the last.
 * The last two turns, because the conversation opens scrolled to its end.
 */
export const SAMPLE_TURN_ACTIVITY: Readonly<
  Partial<Record<number, ReadonlyArray<MessageSegment>>>
> = {
  [SAMPLE_TURNS.length - 2]: [
    {
      id: "sample-reasoning",
      kind: "reasoning",
      markdown:
        "The palette tokens already carry completion and focus in both themes, so nothing new is needed.",
      isStreaming: false,
      durationMs: 4000,
    },
  ],
  [SAMPLE_TURNS.length - 1]: [
    {
      id: "sample-command-search",
      kind: "command",
      command: "rg --files src/components/tasks",
      cwd: null,
      exitCode: 0,
      isStreaming: false,
      endState: null,
      progress: null,
      startedAt: 0,
      backgroundTask: false,
      stopped: false,
      parentId: null,
    },
    {
      id: "sample-command-test",
      kind: "command",
      command: "bun run vitest run src/components/tasks",
      cwd: null,
      exitCode: 0,
      isStreaming: false,
      endState: null,
      progress: null,
      startedAt: 0,
      backgroundTask: false,
      stopped: false,
      parentId: null,
    },
  ],
};

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
    text: `${SAMPLE_CHANGED_FILES.length}`,
    lineDeltas: SAMPLE_CHANGE_TOTALS,
    label: "Sample: three changed files, 47 additions and 9 deletions",
    detail: "3 files, +47 −9",
    pulseToken: null,
  },
  {
    section: "activeAgents",
    glyph: "activeAgents",
    working: true,
    text: `${1 + SAMPLE_AGENT_DESCENDANTS.length}`,
    lineDeltas: null,
    label: "Sample: two active agents",
    detail: "2 running",
    pulseToken: null,
  },
  {
    section: "background",
    glyph: "background",
    working: true,
    text: `${SAMPLE_BACKGROUND_ITEMS.length}`,
    lineDeltas: null,
    label: "Sample: two background shells",
    detail: "2 running",
    pulseToken: null,
  },
  {
    section: "todo",
    glyph: "todo",
    working: false,
    text: `${SAMPLE_TODO.items.filter((item) => item.status === "completed").length}/${SAMPLE_TODO.items.length}`,
    lineDeltas: null,
    label: "Sample: one of three tasks done",
    detail: "1 of 3 done",
    pulseToken: null,
  },
];
export function sampleNoop(): void {}

/**
 * The stop-action string every sample dock handler returns.
 *
 * The real handlers answer with an action id the caller tracks, and `null` is
 * their "handled, nothing to track" - which is exactly what a sample gesture
 * is, so the sample passes `null` rather than inventing an id no store holds.
 */
export function sampleNoopAction(): string | null {
  return null;
}

/** The sample composer records nothing, so it holds no microphone stream. */
function sampleNoStream(): MediaStream | null {
  return null;
}
