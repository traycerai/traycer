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
  /**
   * The BROWSER TAB a `browser` prompt is waiting in, when this window has that
   * tab live. `null` for every other kind, and for a browser prompt whose task
   * is not open here.
   *
   * A browser hand-off names a session and a tab and nothing a reader knows, so
   * the row said "Needs you in the browser" and left them to guess which of
   * their pages it meant. The title only exists where the tab does - the same
   * mounted-only limit the whole browser plane carries - so it decorates the row
   * rather than replacing anything on it.
   */
  readonly browserTabTitle: string | null;
  readonly activation: MergedNotificationRow; // handed to useNotificationActivation
}
export interface FocusAgentRow {
  readonly agentId: string;
  readonly title: string | null; // null when the epic is not mounted here
  readonly surface: "chat" | "terminal-agent" | null;
  readonly tier: "turn" | "background";
  readonly parentId: string | null; // null when unknown
  readonly hostId: string | null; // the agent's host when known
  /**
   * Whether NOTHING could say which machine this agent runs on.
   *
   * `hostId === null` has two very different causes and only this tells them
   * apart. A chat this window RESOLVED that records no host is a legacy chat on
   * an epic we are already talking to, so the active host is where its stop
   * goes and where it belongs on the page (`false`). An agent no identity, no
   * cloud index entry and no local-plane slice could place is `true`, and it
   * groups under `Unknown host` rather than being guessed onto whichever
   * machine the user happens to be sitting at.
   */
  readonly hostUnattributed: boolean;
  /**
   * Whether a stop aimed at THIS agent would reach the machine it runs on.
   *
   * Per agent rather than only per task, because a task can be worked from
   * several hosts at once and a row that shows one host's share of it must
   * answer for that host alone - `FocusTaskRow.stoppable` is the fold of these,
   * not the other way round.
   */
  readonly stoppable: boolean;
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
  /** The machine this job runs on, carried so the section can group by it.
   * `null` for a session handle whose host the registry cannot name - which is
   * also exactly when the row is unstoppable. */
  readonly hostId: string | null;
  readonly label: string; // managed command description or background item title
  readonly kind: "managed-command" | "background-item";
  /** The background item's own kind, for the row's glyph. `null` for a managed
   * command, which is a durable shell rather than a node of a turn and has no
   * kind on that plane. Presentation only - nothing routes on it. */
  readonly itemKind: BackgroundItem["kind"] | null;
  readonly startedAtMs: number | null; // managed commands only
  readonly stoppable: boolean;
}
/**
 * What a browser tab is DOING, in the three states a reader acts on.
 *
 * The wire has six (`browserSessionStatusSchema`), and four of them -
 * `provisioning`, `ready`, `navigating`, `closing` - are moments in one tab's
 * ordinary life. A page that flickered between them would be reporting the
 * host's bookkeeping rather than anything the user can decide from, so they
 * collapse into `live`. The two that survive are the two that change what a
 * reader does next: a `crashed` tab needs reopening, and a `dormant` one is a
 * durable tab with no runtime attached, still addressable and costing nothing.
 */
export type FocusBrowserStatus = "live" | "dormant" | "crashed";

/**
 * One browser TAB, which is the unit a person thinks in.
 *
 * Sessions are the host's grouping - tabs sharing a browser profile - and they
 * are deliberately not a level on this page: a task with two browsers and four
 * pages is four rows with four titles, not two rows the reader has to expand.
 *
 * Browsers are their own plane, neither agents nor background items (the
 * background-item kinds carry no browser kind), and they reach this client only
 * through live coordinators - so the section covers tasks whose canvas is open
 * in this window, and says so.
 */
export interface FocusBrowserRow {
  readonly key: string;
  readonly epicId: string;
  readonly taskTitle: string | null;
  /** The session's own host. Never `null`: a browser session is host-local for
   * life and the inventory that produced this row names the machine. */
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
  /** The tab's document title, falling back to its url host and then to
   * `Browser` - the same chain every other browser-tab reference resolves
   * (`resolveTabTitle`), so a tab reads the same here as in the sidebar. */
  readonly title: string;
  /**
   * The url's host, as the row's muted second part - and `null` when it would
   * only repeat {@link FocusBrowserRow.title}, which is exactly the stale-title
   * case where the title already IS the host.
   */
  readonly urlHost: string | null;
  readonly url: string;
  readonly status: FocusBrowserStatus;
  /** The chat driving this tab right now, when one is. Attribution only - it
   * grants no lock, and the tab is the user's to touch either way. */
  readonly drivenByChatId: string | null;
  /** That chat's name, `null` when this window cannot resolve it. Same
   * mounted-only limit as every other name on this page. */
  readonly drivenByAgentName: string | null;
}
export interface FocusModel {
  readonly prompts: ReadonlyArray<FocusPromptRow>; // attention order (blocking first, newest first)
  readonly tasks: ReadonlyArray<FocusTaskRow>; // tasks with ≥1 running agent; needsYou first, then most agents in turn
  readonly background: ReadonlyArray<FocusBackgroundRow>;
  /** One row per browser tab of every task with a live coordinator in this
   * window, grouped by task and ordered session then tab. */
  readonly browsers: ReadonlyArray<FocusBrowserRow>;
  readonly coverage: {
    readonly activity: "live" | "reconnecting" | "disconnected" | "unknown";
    /**
     * The hosts whose OWN activity slice is degraded, sorted, for the sections
     * that group by host.
     *
     * `activity` above is the worst slice's verdict for the whole page; this is
     * the per-host breakdown behind it, so a section grouped by host can put
     * the notice on the one heading it belongs under instead of over the entire
     * page. Empty whenever nothing is degraded, which is also the single-host
     * install's steady state.
     */
    readonly degradedHostIds: ReadonlyArray<string>;
    readonly notifications: "local" | "cloud";
    readonly backgroundIsMountedOnly: true;
    /** The same literal-`true` shape, for the same reason: browser inventory
     * rides a live coordinator, so a task whose canvas no window has open
     * contributes no rows and cannot be made to. A source that ever covers
     * unmounted tasks fails to compile here rather than quietly outliving the
     * caption that declares this limit. */
    readonly browsersAreMountedOnly: true;
  };
  readonly badgeCount: number; // prompts.length
}
