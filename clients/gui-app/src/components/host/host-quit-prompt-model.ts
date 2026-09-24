import type { HostBusyBreakdownV2 } from "@traycer/protocol/host/status/index";
import type {
  HostQuitDecision,
  HostQuitDecisionRequest,
} from "@traycer-clients/shared/platform/runner-host";
import type { HostQuitVerdict } from "@/components/host/use-local-host-quit-status";
import type { HostQuitDecisionVerdict } from "@/hooks/runner/use-runner-host-quit-respond-mutation";
import {
  HOST_QUIT_DESCRIPTION_BUSY,
  HOST_QUIT_DESCRIPTION_BUSY_RETRY,
  HOST_QUIT_DESCRIPTION_CHECKING,
  HOST_QUIT_DESCRIPTION_IDLE,
  HOST_QUIT_STOP_LABEL,
  HOST_QUIT_STOP_UNKNOWN_LABEL,
  HOST_QUIT_TITLE_BUSY,
  HOST_QUIT_TITLE_CHECKING,
  HOST_QUIT_TITLE_IDLE,
  HOST_QUIT_TITLE_UNKNOWN,
  hostQuitCountsLine,
  hostQuitUnknownDescription,
} from "@/lib/host/host-lifecycle-copy";

/*
 * The host quit modal's state table and its automatic answers, as pure data
 * so the table can be read (and tested) without rendering the dialog.
 */

/** One answer this modal can send, with what it displayed when it was chosen. */
export interface HostQuitPromptModel {
  readonly stateKind: string;
  readonly title: string;
  readonly description: string;
  readonly detail: string | null;
  readonly countsLine: string | null;
  readonly sessionsHostId: string | null;
  readonly stopLabel: string;
  readonly stopDisabled: boolean;
  /** `force` of the stop this state offers - true only after disclosure. */
  readonly stopForce: boolean;
  /** The list state displayed, for `host_quit_decision`. */
  readonly analyticsVerdict: HostQuitDecisionVerdict;
  readonly breakdown: HostBusyBreakdownV2 | null;
}

/**
 * The modal's state table, as data:
 *
 * | verdict       | title                               | Stop                              |
 * | ------------- | ----------------------------------- | --------------------------------- |
 * | checking      | Checking the host…                  | disabled                          |
 * | busy          | The host is still working           | "Stop host and quit", force       |
 * | idle          | Keep the host running?              | "Stop host and quit", if-idle     |
 * | unknown       | Can't tell what's running on the host | "Stop host anyway and quit", force |
 * | busy (round)  | The host is still working           | "Stop host and quit", force       |
 * | busy-retry    | The host is still working           | "Stop host and quit", force       |
 *
 * Both busy rounds are busy whatever the fresh list says: the host has just
 * refused an idle-only stop, and its refusal is the disclosure. They differ
 * only in why: a `busy` round is Stop-if-idle's FIRST ask (its silent stop
 * was refused, nothing was shown before it), so it reads as the plain busy
 * state; only `busy-retry` - the person had chosen Stop over an idle list -
 * says something started meanwhile.
 */
export function describeHostQuitPrompt(
  request: HostQuitDecisionRequest,
  verdict: HostQuitVerdict,
  localHostId: string | null,
): HostQuitPromptModel {
  const facts =
    verdict.kind === "busy" || verdict.kind === "idle" ? verdict : null;
  const countsLine =
    facts === null
      ? null
      : hostQuitCountsLine({
          busy: facts.kind === "busy",
          busySessionCount: facts.busySessionCount,
          breakdown: facts.breakdown,
          statusMinor: facts.statusMinor,
        });
  const breakdown = facts === null ? null : facts.breakdown;
  if (request.round !== "initial") {
    const retry = request.round === "busy-retry";
    const stateKind = retry ? "busy-retry" : "busy-round";
    return {
      stateKind:
        verdict.kind === "checking" ? `${stateKind}-checking` : stateKind,
      title: HOST_QUIT_TITLE_BUSY,
      description: retry
        ? HOST_QUIT_DESCRIPTION_BUSY_RETRY
        : HOST_QUIT_DESCRIPTION_BUSY,
      detail:
        verdict.kind === "unknown"
          ? hostQuitUnknownDescription(verdict.reason)
          : null,
      countsLine,
      sessionsHostId: localHostId,
      stopLabel: HOST_QUIT_STOP_LABEL,
      stopDisabled: verdict.kind === "checking",
      stopForce: true,
      analyticsVerdict: "busy",
      breakdown,
    };
  }
  switch (verdict.kind) {
    case "busy":
      return {
        stateKind: "busy",
        title: HOST_QUIT_TITLE_BUSY,
        description: HOST_QUIT_DESCRIPTION_BUSY,
        detail: null,
        countsLine,
        sessionsHostId: localHostId,
        stopLabel: HOST_QUIT_STOP_LABEL,
        stopDisabled: false,
        stopForce: true,
        analyticsVerdict: "busy",
        breakdown,
      };
    case "idle":
      return {
        stateKind: "idle",
        title: HOST_QUIT_TITLE_IDLE,
        description: HOST_QUIT_DESCRIPTION_IDLE,
        detail: null,
        countsLine,
        sessionsHostId: null,
        stopLabel: HOST_QUIT_STOP_LABEL,
        stopDisabled: false,
        stopForce: false,
        analyticsVerdict: "idle",
        breakdown,
      };
    case "unknown":
      return {
        stateKind: "unknown",
        title: HOST_QUIT_TITLE_UNKNOWN,
        description: hostQuitUnknownDescription(verdict.reason),
        detail: null,
        countsLine: null,
        sessionsHostId: null,
        stopLabel: HOST_QUIT_STOP_UNKNOWN_LABEL,
        stopDisabled: false,
        stopForce: true,
        analyticsVerdict: "unknown",
        breakdown: null,
      };
    case "checking":
    case "no-local-host":
      return {
        stateKind: verdict.kind,
        title: HOST_QUIT_TITLE_CHECKING,
        description: HOST_QUIT_DESCRIPTION_CHECKING,
        detail: null,
        countsLine: null,
        sessionsHostId: null,
        stopLabel: HOST_QUIT_STOP_LABEL,
        stopDisabled: true,
        stopForce: false,
        analyticsVerdict: "unknown",
        breakdown: null,
      };
  }
}

/**
 * The answer this modal gives WITHOUT asking, or `null` to ask.
 *
 * - No host entry on this machine: nothing to keep or stop. Ask keeps (the
 *   choice that can never lose work); Stop-if-idle asks main to stop if idle,
 *   which is what that mode promised.
 * - Stop-if-idle's first round with an idle list: that mode's promise is an
 *   instant quit when nothing is running, so it answers Stop (if-idle) and
 *   never shows the list. A busy race comes back as a busy-retry round.
 *
 * Never on a busy or busy-retry round: the host has just refused an
 * idle-only stop, so an automatic answer there is either a second idle-only
 * stop main would refuse again, or a force nobody chose. That round is always
 * the person's.
 */
export function automaticHostQuitDecision(
  request: HostQuitDecisionRequest,
  verdict: HostQuitVerdict,
): HostQuitDecision | null {
  if (request.round !== "initial") return null;
  if (verdict.kind === "no-local-host") {
    return request.mode === "ask"
      ? { kind: "keep", remember: false }
      : { kind: "stop", force: false, remember: false };
  }
  if (request.mode === "stop-if-idle" && verdict.kind === "idle") {
    return { kind: "stop", force: false, remember: false };
  }
  return null;
}

/**
 * Stop-if-idle's first round stays hidden while the host is being asked: a
 * mode that promises an instant quit when idle must not flash a dialog on the
 * way to that quit. It shows once the list is busy or unreadable. A busy
 * round always shows: the host's refusal already said it is working.
 */
export function hostQuitPromptVisible(
  request: HostQuitDecisionRequest,
  verdict: HostQuitVerdict,
): boolean {
  if (request.round !== "initial") return true;
  if (verdict.kind === "no-local-host") return false;
  if (request.mode === "stop-if-idle") {
    return verdict.kind === "busy" || verdict.kind === "unknown";
  }
  return true;
}
