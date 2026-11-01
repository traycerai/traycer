import type { ReactNode } from "react";
import type { ChatCatchingUpReason } from "@traycer/protocol/host/chat-serving/index";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { cn } from "@/lib/utils";
import {
  hostLabelAtSentenceStart,
  quotedHostReference,
  UNNAMED_HOST_LABEL,
} from "@/hooks/agent/use-host-reachability";
import { tileHostName } from "./tile-host-load-copy";

/**
 * Dead-tile banners surface the per-tile host binding (CLAUDE.md):
 *
 * - **Terminal banners** replace the tile body. PTYs are
 *   host-pinned state - a terminal whose host is unreachable is
 *   permanently closed. The Close action drops the canvas tab.
 * - **Chat banners** sit above the chat history. The history can still
 *   render from cache; the banner offers to clone the chat onto the
 *   currently active host (clone-not-migrate per CLAUDE.md).
 * - **Workspace-file/git-diff banners** replace the tile body. Their
 *   content is read over the bound host's stream/RPC clients; the
 *   renderer addresses only the active host's client, so a tab bound
 *   to a different (or offline) host cannot fetch content. Unlike a
 *   terminal it is not permanently dead - switching the active host
 *   back makes it readable again - so the banner is informational, with
 *   no Close action (the tab strip already offers close).
 */

/**
 * Which entity owns the dead tile. The two have opposite durability semantics
 * and this banner is shared by both, so the copy has to vary by owner:
 *
 *   - `terminal` — a raw PTY. It really is gone; nothing returns when the Host
 *     does.
 *   - `agent` — an Agent using the Terminal interface. The Agent and its
 *     transcript are durable and come back with the Host. Only the tab goes
 *     away when it is closed.
 *
 * Telling an Agent's owner the session is "permanently closed" would say the
 * opposite of the Edge-state contract, so this is a prop rather than one
 * shared string.
 */
export type DeadTileOwnerKind = "terminal" | "agent";

/**
 * WHY this tile cannot show a live session.
 *
 * `host-unreachable` - the bound host cannot be reached from here at all.
 *
 * `not-running-remotely` - the host IS reachable and simply has no PTY for
 * this agent. It is a separate reason because the honest remedy is different
 * and this client has none of it: the tile may not start one. A cross-host
 * REPLICA carries no `harnessSessionId` (that never leaves the owning
 * machine), so creating a session here would not resume the conversation - it
 * would mint a SECOND provider session under the same agent id, on top of
 * whatever the owner may still be driving. Access to a remote agent is
 * live-only by construction; the owner's machine is the only place it can be
 * started.
 *
 * `sandbox-stopped` - the bound host is a sandbox someone stopped. Its PTYs
 * ended with it, and Start is the remedy, so a terminal or a terminal
 * agent says that instead of calling the host unreachable.
 *
 * `sandbox-destroyed` - a member destroyed the sandbox: the banner says who
 * and when (`destroyedLine`), not a fault.
 */
export type DeadTileReason =
  | "host-unreachable"
  | "not-running-remotely"
  | "sandbox-stopped"
  | "sandbox-destroyed";

function terminalDeadTileMessage(
  reason: DeadTileReason,
  ownerKind: DeadTileOwnerKind,
  hostLabel: string,
  destroyedLine: string | null,
): string {
  if (reason === "sandbox-destroyed" && destroyedLine !== null) {
    return destroyedLine;
  }
  if (reason === "not-running-remotely") {
    const named = tileHostName(
      hostLabel === UNNAMED_HOST_LABEL ? null : hostLabel,
    );
    return `This agent is not running on ${named} right now, and it can only be started on that computer. The agent and its transcript are kept there — closing this tab only removes it from the canvas.`;
  }
  if (reason === "sandbox-stopped") {
    return `${hostLabelAtSentenceStart(hostLabel)} is stopped. Start it to use this terminal again.`;
  }
  return ownerKind === "agent"
    ? `${quotedHostReference(hostLabel, true)} is unreachable, so this agent is unavailable until that host is back. The agent and its transcript are kept — closing this tab only removes it from the canvas.`
    : `${quotedHostReference(hostLabel, true)} is unreachable. This terminal is permanently closed.`;
}

export interface TerminalDeadTileBannerProps {
  readonly hostLabel: string;
  readonly ownerKind: DeadTileOwnerKind;
  /**
   * Which end state this is. REQUIRED rather than defaulted: the two read
   * differently to a person and name different remedies, and a default would
   * silently pick one for a call site that had not thought about it.
   */
  readonly reason: DeadTileReason;
  /** Who destroyed the sandbox and when, for `sandbox-destroyed`; else `null`. */
  readonly destroyedLine: string | null;
  readonly onClose: () => void;
  readonly testId: string;
}

export function TerminalDeadTileBanner(
  props: TerminalDeadTileBannerProps,
): ReactNode {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-ui-sm text-muted-foreground"
      data-testid={props.testId}
    >
      <p className="max-w-md">
        {terminalDeadTileMessage(
          props.reason,
          props.ownerKind,
          props.hostLabel,
          props.destroyedLine,
        )}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onClose}
        >
          Close tab
        </Button>
        <ReportIssueAction
          context={createReportIssueContext(
            props.ownerKind === "agent"
              ? {
                  title:
                    props.reason === "not-running-remotely"
                      ? "Agent is not running on its host"
                      : "Agent host is unreachable",
                  message:
                    props.reason === "not-running-remotely"
                      ? "The agent has no running session on the host it is bound to."
                      : "The agent's bound host is unreachable.",
                  code: null,
                  source: "Agent",
                }
              : {
                  title: "Terminal host is unreachable",
                  message: "The terminal's bound host is unreachable.",
                  code: null,
                  source: "Terminal",
                },
          )}
          presentation="text"
          className={undefined}
        />
      </div>
    </div>
  );
}

export interface WorkspaceFileDeadTileBannerProps {
  readonly hostLabel: string;
  /** The bound host is not in the directory / not available. */
  readonly reason: "offline";
  readonly testId: string;
}

export function WorkspaceFileDeadTileBanner(
  props: WorkspaceFileDeadTileBannerProps,
): ReactNode {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-ui-sm text-muted-foreground"
      data-testid={props.testId}
      data-reason={props.reason}
    >
      <p className="max-w-md">
        This file is on {quotedHostReference(props.hostLabel, false)}, which is
        currently unreachable. The preview will load once that host is back.
      </p>
      <ReportIssueAction
        context={createReportIssueContext({
          title: "Workspace file is unavailable",
          message: "The workspace file's bound host is unavailable.",
          code: null,
          source: "Workspace file",
        })}
        presentation="text"
        className={undefined}
      />
    </div>
  );
}

export interface GitDiffDeadTileBannerProps {
  readonly hostLabel: string;
  readonly reason: "offline";
  readonly testId: string;
}

export function GitDiffDeadTileBanner(
  props: GitDiffDeadTileBannerProps,
): ReactNode {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-ui-sm text-muted-foreground"
      data-testid={props.testId}
      data-reason={props.reason}
    >
      <p className="max-w-md">
        This diff is on {quotedHostReference(props.hostLabel, false)}, which is
        currently unreachable. The diff will load once that host is back.
      </p>
      <ReportIssueAction
        context={createReportIssueContext({
          title: "Git diff is unavailable",
          message: "The Git diff's bound host is unavailable.",
          code: null,
          source: "Git changes",
        })}
        presentation="text"
        className={undefined}
      />
    </div>
  );
}

/**
 * PR detail tiles subscribe through their OWN bound host's client
 * (`useHostStreamClientFor`), never the app's active host — same as
 * `GitDiffDeadTileBanner`, which only has an "offline" reason. The heavy
 * PR cache lives on that host, so nothing can render until it returns.
 */
export interface PrDetailDeadTileBannerProps {
  readonly hostLabel: string;
  readonly testId: string;
}

export function PrDetailDeadTileBanner(
  props: PrDetailDeadTileBannerProps,
): ReactNode {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-ui-sm text-muted-foreground"
      data-testid={props.testId}
    >
      <p className="max-w-md">
        This pull request is on {quotedHostReference(props.hostLabel, false)},
        which is currently unreachable. It will load once that host is back.
      </p>
      <ReportIssueAction
        context={createReportIssueContext({
          title: "Pull request is unavailable",
          message: "The PR tile's bound host is unavailable.",
          code: null,
          source: "Pull request",
        })}
        presentation="text"
        className={undefined}
      />
    </div>
  );
}

/**
 * Snapshot diff tiles re-read their before/after content live from a chat
 * session. When that source is gone - the chat was deleted, the edit's blocks
 * were pruned/edited away, or the file dropped out of the cumulative set - the
 * tile can no longer resolve content. Unlike the offline/inactive banners this
 * is terminal for the tile's payload (the referenced edit no longer exists),
 * so the copy reflects that rather than promising a later load.
 */
export interface SnapshotDiffSourceUnavailableBannerProps {
  readonly testId: string;
}

export function SnapshotDiffSourceUnavailableBanner(
  props: SnapshotDiffSourceUnavailableBannerProps,
): ReactNode {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-ui-sm text-muted-foreground"
      data-testid={props.testId}
    >
      <p className="max-w-md">
        This change is no longer available. The agent edit it came from was
        reverted, removed, or is no longer loaded.
      </p>
      <ReportIssueAction
        context={createReportIssueContext({
          title: "Change is no longer available",
          message: "The source agent edit could not be resolved.",
          code: null,
          source: "Snapshot diff",
        })}
        presentation="text"
        className={undefined}
      />
    </div>
  );
}

export interface ChatHostStartingBannerProps {
  readonly className: string | undefined;
  readonly testId: string;
}

/**
 * Non-destructive counterpart to `ChatDeadTileBanner` for the
 * `"host-starting"` reachability state: this machine's own host has not
 * published yet (boot, ensure/respawn, post-wake re-probe), or the bound
 * host's lease vouches for a restart it announced, remote hosts
 * included. No bound host's fate is knowable in that window, so offering
 * "Clone chat" would invite users to fork healthy threads - the banner is
 * purely informational and clears on its own once the host is back.
 */
export function ChatHostStartingBanner(
  props: ChatHostStartingBannerProps,
): ReactNode {
  return (
    <div
      role="status"
      data-testid={props.testId}
      className={cn(
        // muted-fill-ok: banner carries its own border-b border-border, so a
        // collapse loses the wash and not the band
        "flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2 text-ui-sm text-muted-foreground",
        props.className,
      )}
    >
      <AgentSpinningDots
        className="shrink-0"
        testId={undefined}
        variant={undefined}
      />
      <span className="min-w-0 flex-1">
        Waiting for the host to start&hellip;
      </span>
    </div>
  );
}

export interface ChatCatchingUpBannerProps {
  readonly reason: ChatCatchingUpReason;
  readonly testId: string;
}

const CATCHING_UP_LINES: Readonly<Record<ChatCatchingUpReason, string>> = {
  transfer: "Moving this agent to its sandbox. It goes live here when ready.",
  "final-publication": "Saving this agent's latest messages.",
  indexing: "The latest messages appear here in a moment.",
};

/**
 * The server's `catching-up` state for a team sandbox's chat: a host is awake
 * for it, or has just left it, and the copy on screen may be behind. Shown
 * over whatever the tile is serving, so a chat whose newest turns are still
 * on their way never reads as a finished at-rest page.
 */
export function ChatCatchingUpBanner(
  props: ChatCatchingUpBannerProps,
): ReactNode {
  return (
    <div
      role="status"
      data-testid={props.testId}
      data-reason={props.reason}
      // muted-fill-ok: banner carries its own border-b border-border, so a
      // collapse loses the wash and not the band
      className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2 text-ui-sm text-muted-foreground"
    >
      <AgentSpinningDots
        className="shrink-0"
        testId={undefined}
        variant={undefined}
      />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-foreground">Catching up.</span>{" "}
        {CATCHING_UP_LINES[props.reason]}
      </span>
    </div>
  );
}

/**
 * Four distinct causes land on this ONE banner, and no two of them are the
 * same sentence (chat-sync-v2):
 *
 * - `host-offline` - the bound host is genuinely unreachable. Nothing was
 *   asked and nothing answered, so the host is what has to come back.
 * - `chat-not-visible` - a reachable host that is NOT this device answered,
 *   and answered that it has nothing for this chat (`chat.subscribe`
 *   terminated `CHAT_NOT_VISIBLE`). "is offline" would be false here.
 * - `chat-not-on-this-host` - the same answer, from the host this device is
 *   connected to (a leased-identity twin, a store this identity never
 *   adopted). Naming that host as a place the history "isn't available"
 *   reads as "your own machine is unreachable" - the lie that sent two live
 *   debugging sessions after a healthy host on 2026-08-11. The host
 *   ANSWERED; the chat is what is missing. The clone it offers also lands on
 *   this same machine, so the "stays bound to <label>" disclosure the other
 *   two carry has nothing left to disclose.
 * - `chat-no-longer-shared` - the record plane RETRACTED this chat from this
 *   viewer (`remove` with reason `revoked`: unshared, flipped back to private,
 *   or epic-membership loss). The one member of this taxonomy that is not about
 *   a host at all - the chat exists, its host is fine, and it is the VIEWER's
 *   entitlement that changed. It is also the only one with nothing to offer:
 *   the other three all end in "clone it and carry on", which needs read access
 *   to a transcript this viewer no longer has.
 * - `sandbox-removed` - the agent's team sandbox is gone and the person's own
 *   host is a sandbox of a team: the action continues the SAME agent there
 *   (`chat.continueHere`) instead of cloning it. Every admitted member of the
 *   environment may continue its agents, so the sentence is the same whoever
 *   created the agent.
 */
export type ChatDeadTileBannerReason =
  | "host-offline"
  | "chat-not-visible"
  | "chat-not-on-this-host"
  | "chat-no-longer-shared"
  | "sandbox-removed";

export interface ChatDeadTileBannerProps {
  /**
   * The bound host's label, or `null` when nothing names it - the copy then
   * says "the host" (a removed sandbox, "This agent's sandbox").
   */
  readonly hostLabel: string | null;
  readonly reason: ChatDeadTileBannerReason;
  /**
   * Whether the source chat belongs to the signed-in viewer. `false` is a
   * collaborator's shared chat, and every host-naming sentence in the copy
   * table turns false there: the owner's machine can never appear in this
   * account's host directory, so "unreachable" is a fact about THIS viewer's
   * fleet - not evidence the machine is off - and `hostLabel` names nothing
   * the reader can act on. Those reasons
   * swap to the foreign-owner sentence instead. `true` when the owner is
   * unknown: a local chat ref is the viewer's own by construction, so only a
   * positive mismatch may flip the copy.
   */
  readonly ownedByViewer: boolean;
  /**
   * Whether the source chat's owner is one of the viewer's team environments:
   * a team sandbox's chat. Outranks `ownedByViewer` on the same reasons: the
   * foreign-owner sentence would call a team chat another collaborator's, and
   * the own-chat ones name a machine. Those reasons swap to the environment
   * sentence instead.
   */
  readonly environmentOwned: boolean;
  /**
   * Whether the viewer's epic role can create agents (editor/owner - the same
   * gate `epic.createChat` enforces host-side). `false` withholds the Clone
   * button that role's refusal would otherwise turn into a bare
   * "You don't have permission" toast, and says why instead. Pass `true`
   * while the role is still unknown - the host gate is the backstop, and
   * withholding the way out of a dead tile needs evidence, not doubt.
   */
  readonly cloneAllowed: boolean;
  /**
   * Whether a readable copy (published or doc-synced) is actually mounted
   * under this banner. The live tile mounts it above a load state or a cached
   * live session, where "showing the last published copy" would describe
   * content that is not on screen - so the foreign-owner copy claims it only
   * when the mounting surface says so, rather than inferring its own
   * presentation. The own-chat sentences carry their presentation facts in
   * the reason copy and do not read this.
   */
  readonly showsPublishedCopy: boolean;
  /**
   * The sandbox a removed sandbox's agent continues on (`sandbox-removed`),
   * by name, or `null` when there is none. Only the `sandbox-removed` copy
   * reads it.
   */
  readonly continueTargetLabel: string | null;
  readonly onClone: () => void;
  readonly cloning: boolean;
  readonly className: string | undefined;
  readonly testId: string;
}

/**
 * A reason's copy, keyed on whether it ends in an action the reader can take.
 *
 * Four of the five do: the transcript is readable (as a published copy or from
 * the owner host) and cloning carries it onto a live host. `revoked` does not -
 * the clone would have to read bytes the server just stopped serving this
 * viewer, so offering the button would be an invitation to a failure. Same
 * reasoning `ChatHostStartingBanner` withholds it under.
 *
 * A clone-offering reason must supply `messageWithoutClone` as well, and the
 * union is what forces it: every one of those sentences carries the clone
 * promise ("clone this agent to continue", "cloning creates a new agent from
 * it"), so a viewer who cannot clone must be told the fact WITHOUT that
 * promise rather than be handed it and have it taken back a sentence later.
 * Adding a fifth clone-offering reason cannot silently skip the variant.
 *
 * Each sentence takes the host as `bannerHostName` names it: quoted, or "the
 * host" while no label has resolved; and the sandbox a removed sandbox's agent
 * continues on, which only that reason names.
 */
type ChatDeadTileBannerCopy =
  | {
      readonly message: (host: string, target: string) => ReactNode;
      readonly reportTitle: string;
      readonly reportMessage: string;
      readonly offersClone: false;
    }
  | {
      readonly message: (host: string, target: string) => ReactNode;
      /** The same fact, stated without the clone promise. */
      readonly messageWithoutClone: (host: string) => ReactNode;
      readonly reportTitle: string;
      readonly reportMessage: string;
      readonly offersClone: true;
      /** The button: "Clone agent", or where a removed sandbox's agent goes. */
      readonly actionLabel: (target: string) => string;
    };

const CHAT_DEAD_TILE_BANNER_COPY: Record<
  ChatDeadTileBannerReason,
  ChatDeadTileBannerCopy
> = {
  // Leads with what the reader can do, beside the button that does it, and
  // keeps the cause: over a loaded transcript there is no body below to say
  // the host is offline, so this sentence is the only one that does.
  "host-offline": {
    message: (host) => (
      <>
        Clone this agent to continue while {host} is offline; the original stays
        there.
      </>
    ),
    // No button for this reader, so no action to lead with: what is true for
    // them, and why there is nothing to press.
    messageWithoutClone: (host) => (
      <>
        This agent can&apos;t continue here while {host} is offline. You have
        view-only access to this task, so it can&apos;t be cloned.
      </>
    ),
    reportTitle: "Agent host is offline",
    reportMessage: "The agent's bound host is offline.",
    offersClone: true,
    actionLabel: () => "Clone agent",
  },
  "chat-not-visible": {
    message: (host) => (
      <>
        This agent&apos;s history isn&apos;t available on {host}. Continuing
        here creates a new agent on the active host; this one stays bound to{" "}
        {host}.
      </>
    ),
    messageWithoutClone: (host) => (
      <>
        This agent&apos;s history isn&apos;t available on {host}. You have
        view-only access to this task, so it can&apos;t be cloned onto another
        host.
      </>
    ),
    reportTitle: "Agent history unavailable",
    reportMessage: "The agent's history could not be found on its bound host.",
    offersClone: true,
    actionLabel: () => "Clone agent",
  },
  // Deliberately names no host: the one it would name is the machine the
  // reader is looking at, and every label this device could print for it
  // ("mac-mini", the raw id) reads as somewhere else. Nor does it offer to
  // wait - the host already answered, so there is nothing to come back.
  "chat-not-on-this-host": {
    message: () => (
      <>
        This agent&apos;s history is no longer on this host. Showing the last
        published copy; cloning creates a new agent from it.
      </>
    ),
    // Drops the published-copy clause rather than restating it: this variant
    // is reachable from mounts that do not show one, and the base sentence
    // only gets away with the claim because it is paired with the offer.
    messageWithoutClone: () => (
      <>
        This agent&apos;s history is no longer on this host. You have view-only
        access to this task, so it can&apos;t be cloned onto another host.
      </>
    ),
    reportTitle: "Agent history missing on this host",
    reportMessage:
      "The connected host answered that it no longer has this agent's history.",
    offersClone: true,
    actionLabel: () => "Clone agent",
  },
  // Names no host on purpose, like the arm above it, but for the opposite
  // reason: there is nothing wrong with any host here. Saying "on <label>"
  // would invite the reader to go looking at a machine that is working
  // perfectly. Nor does it say WHICH revocation happened (unshared vs
  // shared->private vs removed from the epic) - the feed does not tell this
  // client, and guessing would be worse than the fact itself.
  "chat-no-longer-shared": {
    message: () => (
      <>
        This agent is no longer shared with you. Its transcript is no longer
        available here.
      </>
    ),
    reportTitle: "Agent is no longer shared",
    reportMessage: "Access to this agent was revoked while its tab was open.",
    offersClone: false,
  },
  "sandbox-removed": {
    message: (host, target) => (
      <>
        {host} was removed. Continue this agent on {target}, with its history.
      </>
    ),
    messageWithoutClone: (host) => (
      <>
        {host} was removed. You have view-only access to this task, so this
        agent can&apos;t be continued.
      </>
    ),
    reportTitle: "Agent sandbox was removed",
    reportMessage: "The agent's sandbox was removed.",
    offersClone: true,
    actionLabel: (target) => `Continue on ${target}`,
  },
};

/**
 * Whether a reachable host ANSWERED for this reason.
 *
 * Both are selected only after a host replied (`tab-group-view` picks them off
 * a live response), so nothing downstream may describe them as a connectivity
 * failure - that would invert the evidence of a host that just spoke.
 *
 * Shared by the foreign-owner sentence and its report metadata deliberately:
 * they were split before, and the report went on claiming a disconnected host
 * under a sentence that said the opposite.
 * One predicate means the two cannot disagree again.
 */
function hostAnsweredForReason(reason: ChatDeadTileBannerReason): boolean {
  return reason === "chat-not-visible" || reason === "chat-not-on-this-host";
}

/**
 * The sentence for a collaborator's chat, composed from three independently
 * true clauses rather than one blanket claim (the first
 * cut collapsed presentation state and failure reason into a sentence that
 * could describe content not on screen, or contradict a host that answered).
 *
 * - The FACT varies by reason: the host-unreachable reasons say the owner's
 *   machine "isn't connected here" - deliberately not "is offline", which is
 *   unknowable from this account (see `ownedByViewer`) - while the two
 *   answered-host reasons (`chat-not-visible` / `chat-not-on-this-host`) keep
 *   their missing-history fact, because "isn't connected" would invert the
 *   evidence of a host that just spoke. Neither names a host: the label for a
 *   foreign machine is a raw id.
 * - The COPY clause appears only when the mounting surface actually shows one
 *   (`showsPublishedCopy`).
 * - The CLONE clause matches the sharing panel's promise ("Collaborators can
 *   view and clone your agent chats"); the view-only arm says why that
 *   promise does not extend to this reader instead of dangling a button the
 *   host's editor gate would refuse.
 */
function foreignOwnerMessage(input: {
  readonly reason: ChatDeadTileBannerReason;
  readonly showsPublishedCopy: boolean;
  readonly cloneAllowed: boolean;
}): string {
  const fact = hostAnsweredForReason(input.reason)
    ? "This agent belongs to another collaborator, and its history isn't available here."
    : "This agent belongs to another collaborator and lives on their computer, which isn't connected here.";
  return `${fact}${copyClauses(input)}`;
}

/**
 * A team environment's chat: what is out is its sandbox, whichever reason
 * brought the banner up, and whether this is the last published copy. Nothing
 * else: the clone clause's "your own agent" may be false when the active host
 * is itself a team's.
 */
function environmentOwnerMessage(input: {
  readonly showsPublishedCopy: boolean;
}): string {
  const copyClause = input.showsPublishedCopy
    ? " Showing the last published copy."
    : "";
  return `This chat's sandbox isn't available.${copyClause}`;
}

/** The published-copy and clone clauses both non-own sentences end with. */
function copyClauses(input: {
  readonly showsPublishedCopy: boolean;
  readonly cloneAllowed: boolean;
}): string {
  const copyClause = input.showsPublishedCopy
    ? " Showing the last published copy."
    : "";
  const cloneClause = input.cloneAllowed
    ? " Cloning creates your own agent on the active host."
    : " You have view-only access to this task, so it can't be cloned.";
  return `${copyClause}${cloneClause}`;
}

const ENVIRONMENT_OWNER_REPORT = {
  reportTitle: "Chat sandbox isn't available",
  reportMessage: "The chat's team sandbox isn't available.",
};

const FOREIGN_OWNER_UNREACHABLE_REPORT = {
  reportTitle: "Shared agent isn't available live",
  reportMessage:
    "The agent belongs to another collaborator and its host isn't connected here.",
};

const FOREIGN_OWNER_HISTORY_REPORT = {
  reportTitle: "Shared agent history unavailable",
  reportMessage:
    "The agent belongs to another collaborator and its history could not be read here.",
};

/** The report a support ticket carries, matched to the sentence on screen. */
function foreignOwnerReport(reason: ChatDeadTileBannerReason): {
  readonly reportTitle: string;
  readonly reportMessage: string;
} {
  return hostAnsweredForReason(reason)
    ? FOREIGN_OWNER_HISTORY_REPORT
    : FOREIGN_OWNER_UNREACHABLE_REPORT;
}

/**
 * The own-chat sentence, which drops the clone promise for a viewer who
 * cannot act on it (a creator downgraded to `viewer` after opening the chat).
 */
function ownChatMessage(
  copy: ChatDeadTileBannerCopy,
  host: string,
  target: string,
  cloneAllowed: boolean,
): ReactNode {
  if (copy.offersClone && !cloneAllowed) {
    return copy.messageWithoutClone(host);
  }
  return copy.message(host, target);
}

/**
 * The host as the own-chat sentence names it. A removed sandbox opens its
 * sentence, and "the host was removed" names no machine a person can find,
 * so an unresolved label reads as the agent's sandbox there.
 */
function bannerHostName(
  reason: ChatDeadTileBannerReason,
  hostLabel: string | null,
): string {
  if (reason === "sandbox-removed" && hostLabel === null) {
    return "This agent's sandbox";
  }
  return tileHostName(hostLabel);
}

/**
 * Where a removed sandbox's agent continues, by name. The tile offers the
 * continue only once it has a target, so the fallback is never shown in
 * practice; it keeps the sentence true if the name has not resolved.
 */
function continueTargetName(label: string | null): string {
  return label ?? "another sandbox of the team";
}

/**
 * The sentence and report for a chat that is not the viewer's own - a team
 * environment's, then a collaborator's - or `null` for the own-chat copy.
 *
 * The revoked and removed-sandbox reasons keep their own copy for either
 * owner: the first is already about this viewer's entitlement, not about any
 * host, and the second is the same sentence whoever created the agent.
 */
function ownerSwappedCopy(props: ChatDeadTileBannerProps): {
  readonly message: string;
  readonly report: {
    readonly reportTitle: string;
    readonly reportMessage: string;
  };
} | null {
  if (
    props.reason === "chat-no-longer-shared" ||
    props.reason === "sandbox-removed"
  ) {
    return null;
  }
  if (props.environmentOwned) {
    return {
      message: environmentOwnerMessage(props),
      report: ENVIRONMENT_OWNER_REPORT,
    };
  }
  if (!props.ownedByViewer) {
    return {
      message: foreignOwnerMessage(props),
      report: foreignOwnerReport(props.reason),
    };
  }
  return null;
}

export function ChatDeadTileBanner(props: ChatDeadTileBannerProps): ReactNode {
  const copy = CHAT_DEAD_TILE_BANNER_COPY[props.reason];
  const swapped = ownerSwappedCopy(props);
  const report = swapped === null ? copy : swapped.report;
  const target = continueTargetName(props.continueTargetLabel);
  return (
    // A live region, like the other two chat banners: which of the three
    // truths above is on screen is carried ONLY by this sentence, and the
    // banner appears (and swaps between reasons) mid-session without any
    // focus move - unannounced, a screen-reader user is told nothing about
    // why the composer beneath it locked. Polite `status` rather than
    // `alert`: nothing here is urgent and the transcript stays readable.
    <div
      role="status"
      data-reason={props.reason}
      data-testid={props.testId}
      className={cn(
        "flex items-center gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-ui-sm text-warning-foreground",
        props.className,
      )}
    >
      <span className="min-w-0 flex-1">
        {swapped === null
          ? ownChatMessage(
              copy,
              bannerHostName(props.reason, props.hostLabel),
              target,
              props.cloneAllowed,
            )
          : swapped.message}
      </span>
      {copy.offersClone && props.cloneAllowed ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.cloning}
          onClick={props.onClone}
        >
          {copy.actionLabel(target)}
        </Button>
      ) : null}
      <ReportIssueAction
        context={createReportIssueContext({
          title: report.reportTitle,
          message: report.reportMessage,
          code: null,
          source: "Agent",
        })}
        presentation="icon"
        variant="warning-ghost"
        className="shrink-0"
      />
    </div>
  );
}
