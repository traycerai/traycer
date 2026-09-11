import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";

export type FocusPromptKind = "approval" | "interview" | "browser";
export interface FocusPromptRow {
  readonly key: string; // notification feedId
  readonly kind: FocusPromptKind;
  readonly epicId: string | null;
  readonly chatId: string | null;
  readonly taskTitle: string | null; // from history query or mounted epic; null if unknown
  readonly title: string; // notification title
  readonly body: string;
  readonly createdAt: number;
  readonly originHostId: string | null;
  readonly activation: MergedNotificationRow; // handed to useNotificationActivation
}
export interface FocusAgentRow {
  readonly agentId: string;
  readonly title: string | null; // null when the epic is not mounted here
  readonly surface: "chat" | "terminal-agent" | null;
  readonly tier: "turn" | "background";
  readonly parentId: string | null; // null when unknown
  readonly hostId: string | null; // the agent's host when known
}
export interface FocusTaskRow {
  readonly epicId: string;
  readonly taskTitle: string | null;
  readonly mountedHere: boolean; // agent names + background available
  readonly agents: ReadonlyArray<FocusAgentRow>; // running only, turn first
  readonly needsYou: boolean; // indicator flags or a prompt row for this epic
  readonly stoppable: boolean; // every running agent's host is active or reachable
}
export interface FocusBackgroundRow {
  readonly key: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly taskTitle: string | null;
  /**
   * The name of the CHAT this job runs in, when this window knows it.
   *
   * A job's row names three things that are not the same - the job, the
   * conversation hosting it, and the task that conversation belongs to - and
   * the chat is the one a reader needs to find it again. `null` for a chat
   * whose epic has no live projection here, which is the same window-local
   * limit the whole section carries.
   */
  readonly chatTitle: string | null;
  readonly label: string; // managed command description or background item title
  readonly kind: "managed-command" | "background-item";
  /** The background item's own kind, for the row's glyph. `null` for a managed
   * command, which is a durable shell rather than a node of a turn and has no
   * kind on that plane. Presentation only - nothing routes on it. */
  readonly itemKind: BackgroundItem["kind"] | null;
  readonly startedAtMs: number | null; // managed commands only
  readonly stoppable: boolean;
}
export interface FocusModel {
  readonly prompts: ReadonlyArray<FocusPromptRow>; // attention order (blocking first, newest first)
  readonly tasks: ReadonlyArray<FocusTaskRow>; // tasks with ≥1 running agent; needsYou first, then most agents in turn
  readonly background: ReadonlyArray<FocusBackgroundRow>;
  readonly coverage: {
    readonly activity: "live" | "reconnecting" | "disconnected" | "unknown";
    readonly notifications: "local" | "cloud";
    readonly backgroundIsMountedOnly: true;
  };
  readonly badgeCount: number; // prompts.length
}
