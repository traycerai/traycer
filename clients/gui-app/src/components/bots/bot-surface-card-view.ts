import type {
  BotSurfaceReference,
  BotSurfaceResolution,
} from "@traycer/protocol/persistence/epic/messages";
import type {
  BotInputNeeded,
  BotSurfaceActionRefusalCode,
  BotSurfaceActionState,
} from "@traycer/protocol/host/bot/schemas";
import type { BotSurfaceAction } from "@traycer/protocol/host/bot/surface-schemas";
import type { BotSurfaceActionEntry } from "@/stores/bots/bot-surface-actions-store";

/**
 * What the card under a bot's surface post shows (Tracy Bots T89): a
 * one-line title for what the post points at, where it stands, and what the
 * person can do about it. Pure: the card component draws it.
 *
 * Where it stands, first match wins:
 *  1. the post's resolution, written once the task's machine reported the
 *     surface settled: who settled it and how, and no action;
 *  2. the person's own action from this window: sending, recorded here, or
 *     refused and why; with none here, their action on the post the serving
 *     host holds (from another window, or from this one before a reload);
 *  3. the surface among the task's open surfaces: it waits, with its action;
 *  4. otherwise unknown, and only Open.
 */
export interface BotSurfaceCardView {
  readonly title: string;
  readonly state: BotSurfaceCardState;
  /** Which inline action the card offers; `null` for Open alone. */
  readonly actions: "question" | "approval" | null;
  /** The actions are drawn but cannot be used: an action is on its way. */
  readonly actionsBusy: boolean;
}

export type BotSurfaceCardState =
  | { readonly kind: "resolved"; readonly line: string }
  | { readonly kind: "open"; readonly line: string }
  | { readonly kind: "sending" }
  | { readonly kind: "refused"; readonly line: string }
  | { readonly kind: "unknown" };

/** A member's name as the channel shows it, and whether it is the viewer's. */
export type SurfaceMemberName = (userId: string) => string;

export interface BotSurfaceCardInput {
  readonly surface: BotSurfaceReference;
  /** The post's own text, for a title the task's report does not give. */
  readonly postText: string;
  /**
   * The task's open surfaces as the bot's host holds them; `null` where the
   * serving host cannot say (it predates them, or cannot read the room).
   */
  readonly openSurfaces: ReadonlyArray<BotInputNeeded> | null;
  /** This window's own action on the post; `null` for none. */
  readonly entry: BotSurfaceActionEntry | null;
  /** The serving host's state of that action, from the subscription. */
  readonly hostAction: BotSurfaceActionState | null;
  /** The viewer's actions on the post the serving host holds, oldest first. */
  readonly postActions: ReadonlyArray<BotSurfaceActionState>;
  readonly viewerUserId: string | null;
  readonly memberName: SurfaceMemberName;
  /** Whether the tab's host takes an answer or a decision from the card. */
  readonly canAct: boolean;
}

/** The open surface this post points at, among its task's; `null` when not open or not known. */
export function openSurfaceOf(
  surface: BotSurfaceReference,
  openSurfaces: ReadonlyArray<BotInputNeeded> | null,
): BotInputNeeded | null {
  if (openSurfaces === null) return null;
  return (
    openSurfaces.find((item) => {
      const open = item.surface;
      if (item.hostId !== surface.hostId) return false;
      switch (surface.kind) {
        case "question":
          return open.kind === "question" && open.blockId === surface.blockId;
        case "approval":
          return (
            open.kind === "approval" && open.approvalId === surface.approvalId
          );
        case "browser":
          return (
            open.kind === "browser" &&
            open.sessionId === surface.sessionId &&
            open.parkId === surface.parkId
          );
        case "artifact":
          return false;
      }
    }) ?? null
  );
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/** The last segment of an artifact's path that names it, past an entry file. */
function artifactTitle(artifactPath: string): string {
  const segments = artifactPath.split(/[\\/]+/u).filter((s) => s.length > 0);
  const last = segments.at(-1) ?? artifactPath;
  if (/^index\.[a-z]+$/iu.test(last) && segments.length > 1) {
    return segments.at(-2) ?? last;
  }
  return last;
}

function titleOf(
  surface: BotSurfaceReference,
  open: BotInputNeeded | null,
  postText: string,
): string {
  if (surface.kind === "artifact") return artifactTitle(surface.artifactPath);
  const reported = open === null ? "" : openTitle(open.surface);
  return reported || firstLine(postText);
}

/** What the task's report names an open surface by; empty when it names nothing. */
function openTitle(item: BotInputNeeded["surface"]): string {
  switch (item.kind) {
    case "question":
      return firstLine(item.questions[0]?.text ?? "");
    case "approval": {
      const summary = firstLine(item.summary);
      return summary.length > 0
        ? `Wants to use ${item.tool}: ${summary}`
        : `Wants to use ${item.tool}`;
    }
    case "browser":
      return firstLine(item.title ?? "") || (item.url ?? "");
  }
}

/** The resolution as the card says it: who settled it, and how. */
function resolutionLine(
  resolution: BotSurfaceResolution,
  viewerUserId: string | null,
  memberName: SurfaceMemberName,
): string {
  const verb = RESOLUTION_VERBS[resolution.state];
  if (verb === null) {
    return resolution.state === "resumed" ? "Resumed" : "Ended";
  }
  if (resolution.by === null) return verb;
  const by =
    resolution.by.userId === viewerUserId
      ? "you"
      : memberName(resolution.by.userId);
  return `${verb} by ${by}`;
}

const RESOLUTION_VERBS: Readonly<
  Record<BotSurfaceResolution["state"], string | null>
> = {
  answered: "Answered",
  skipped: "Skipped",
  allowed: "Allowed",
  denied: "Denied",
  resumed: null,
  ended: null,
};

/** What the person's own action settled, said as its resolution, before the post shows it. */
function ownSettlementLine(action: BotSurfaceAction): string {
  switch (action.kind) {
    case "answer":
      return "Answered by you";
    case "skip":
      return "Skipped by you";
    case "decide":
      return action.decision.approved ? "Allowed by you" : "Denied by you";
  }
}

function openLine(surface: BotSurfaceReference): string {
  switch (surface.kind) {
    case "question":
      return "Needs your answer";
    case "approval":
      return "Needs your decision";
    case "browser":
      return "Waiting for you to sign in";
    case "artifact":
      return "";
  }
}

function refusedLine(
  code: BotSurfaceActionRefusalCode,
  surface: BotSurfaceReference,
): string {
  switch (code) {
    case "ALREADY_SETTLED":
      return surface.kind === "approval"
        ? "Already decided"
        : "Already answered";
    case "ACCESS_DENIED":
      return "You don't have access to this task.";
    case "NOT_SUPPORTED":
      return "Answer this in the task.";
    case "NOT_FOUND":
      return "This is no longer waiting.";
    case "NOT_REACHABLE":
      return surface.kind === "approval"
        ? "Couldn't reach the task."
        : "Couldn't reach the task. Your answer is kept.";
  }
}

function inlineActionOf(
  surface: BotSurfaceReference,
): "question" | "approval" | null {
  return surface.kind === "question" || surface.kind === "approval"
    ? surface.kind
    : null;
}

/**
 * Why the person's action was refused, `null` when it was not. The serving
 * host's word on a forwarded action outranks this window's: a refusal there
 * is the task's machine answering. With no action of this window's own, the
 * one the serving host holds for the post says.
 */
function refusalOf(
  entry: BotSurfaceActionEntry | null,
  hostAction: BotSurfaceActionState | null,
  held: BotSurfaceActionState | null,
): BotSurfaceActionRefusalCode | null {
  if (entry === null) return held?.state === "refused" ? held.code : null;
  if (
    hostAction !== null &&
    hostAction.actionId === entry.actionId &&
    hostAction.state === "refused"
  ) {
    return hostAction.code;
  }
  if (entry.phase === "unconfirmed") {
    // The serving host holds it on its way: the call's answer was lost.
    return hostAction?.state === "sending" ? null : "NOT_REACHABLE";
  }
  return entry.phase === "refused" ? entry.code : null;
}

/**
 * The viewer's action on the post the serving host holds, for a window with
 * none of its own: one on its way, else the latest refused.
 */
function heldAction(
  postActions: ReadonlyArray<BotSurfaceActionState>,
): BotSurfaceActionState | null {
  return (
    postActions.find((action) => action.state === "sending") ??
    postActions.at(-1) ??
    null
  );
}

/** An action of the person's on the post is on its way, from any window. */
function anyOnItsWay(
  postActions: ReadonlyArray<BotSurfaceActionState>,
): boolean {
  return postActions.some((action) => action.state === "sending");
}

/**
 * The person's action is on its way: from this window (sent, or unanswered
 * while the serving host holds it on its way), or from another the serving
 * host holds.
 */
function isOnItsWay(
  entry: BotSurfaceActionEntry | null,
  hostAction: BotSurfaceActionState | null,
  held: BotSurfaceActionState | null,
): boolean {
  if (entry === null) return held?.state === "sending";
  if (entry.phase === "unconfirmed") return hostAction?.state === "sending";
  return entry.phase === "sending" || entry.phase === "forwarded";
}

/** The card's title, state and actions, from the post, the task's open surfaces and the person's own action. */
export function botSurfaceCardView(
  input: BotSurfaceCardInput,
): BotSurfaceCardView {
  const { surface, entry, hostAction } = input;
  const open = openSurfaceOf(surface, input.openSurfaces);
  const title = titleOf(surface, open, input.postText);
  const quiet = { title, actions: null, actionsBusy: false } as const;
  if (surface.resolution !== null) {
    return {
      ...quiet,
      state: {
        kind: "resolved",
        line: resolutionLine(
          surface.resolution,
          input.viewerUserId,
          input.memberName,
        ),
      },
    };
  }
  if (surface.kind === "artifact") {
    return { ...quiet, state: { kind: "unknown" } };
  }
  const inline = input.canAct ? inlineActionOf(surface) : null;
  const held = entry === null ? heldAction(input.postActions) : null;
  const refusedCode = refusalOf(entry, hostAction, held);
  if (refusedCode !== null) {
    const line = refusedLine(refusedCode, surface);
    // Unreachable: the answer is kept and can be sent again, once no other
    // action of the person's on the post is on its way. Every other refusal
    // leaves Open alone.
    const again = refusedCode === "NOT_REACHABLE" && open !== null;
    return {
      title,
      state: { kind: "refused", line },
      actions: again ? inline : null,
      actionsBusy: again && anyOnItsWay(input.postActions),
    };
  }
  if (entry !== null && entry.phase === "settled") {
    return {
      ...quiet,
      state: { kind: "resolved", line: ownSettlementLine(entry.action) },
    };
  }
  if (isOnItsWay(entry, hostAction, held)) {
    return {
      title,
      state: { kind: "sending" },
      actions: inline,
      actionsBusy: true,
    };
  }
  if (open === null) return { ...quiet, state: { kind: "unknown" } };
  return {
    title,
    state: { kind: "open", line: openLine(surface) },
    actions: inline,
    actionsBusy: false,
  };
}
