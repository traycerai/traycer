import { log } from "../app/logger";
import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import type { HostQuitDecision } from "../../ipc-contracts/host-quit-types";
import { parseRequestId } from "./ipc-parsers";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

/**
 * The quit transaction's round-trip with the host quit modal
 * (host-lifecycle-modes T06). `respond` is on the renderer surface
 * (`runnerHost.hostLifecycle.respondToQuitRequest`); `listening` and
 * `acknowledge` are preload-internal - the preload reports its window's
 * modal subscription and acknowledges each request that reached it, so main
 * never waits on a window that cannot answer. See `RendererDecisionRequests`.
 */
export function registerHostQuitIpc(
  bridge: Pick<
    RunnerIpcBridge,
    | "handleInvoke"
    | "resolveSenderWindowId"
    | "hostQuitListeningWindowIds"
    | "hostQuitDecisions"
  >,
): void {
  bridge.handleInvoke(
    RunnerHostInvoke.hostQuitListening,
    (event, listening: unknown) => {
      const windowId = bridge.resolveSenderWindowId(event);
      if (windowId === null) {
        log.warn("[runner-ipc] hostQuit listening from unknown window", {});
        return;
      }
      if (listening === true) {
        bridge.hostQuitListeningWindowIds.add(windowId);
        return;
      }
      if (listening === false) {
        bridge.hostQuitListeningWindowIds.delete(windowId);
        // The modal unmounted (sign-out, a route change): a request it had
        // acknowledged has nobody left to answer it.
        bridge.hostQuitDecisions.rejectWindow(
          windowId,
          new Error("Host quit modal stopped listening before resolving"),
        );
        return;
      }
      log.warn("[runner-ipc] hostQuit listening payload malformed", {
        windowId,
      });
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.hostQuitAcknowledge,
    (event, requestId: unknown) => {
      const windowId = bridge.resolveSenderWindowId(event);
      if (windowId === null) {
        log.warn("[runner-ipc] hostQuit acknowledge from unknown window", {});
        return;
      }
      const parsedRequestId = parseRequestId(requestId);
      if (parsedRequestId === null) {
        log.warn("[runner-ipc] hostQuit acknowledge payload malformed", {
          windowId,
        });
        return;
      }
      if (!bridge.hostQuitDecisions.acknowledge(windowId, parsedRequestId)) {
        log.warn("[runner-ipc] hostQuit acknowledge with no waiter", {
          requestId: parsedRequestId,
          windowId,
        });
      }
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.hostQuitRespond,
    (event, response: unknown) => {
      const windowId = bridge.resolveSenderWindowId(event);
      if (windowId === null) {
        log.warn("[runner-ipc] hostQuit respond from unknown window", {});
        return;
      }
      const record = isRecord(response) ? response : null;
      const requestId =
        record === null ? null : parseRequestId(record.requestId);
      if (requestId === null) {
        log.warn("[runner-ipc] hostQuit respond payload malformed", {
          windowId,
        });
        return;
      }
      const waiter = bridge.hostQuitDecisions.take(windowId, requestId, false);
      if (waiter === null) {
        // Unknown or stale (a superseded request, or one main already gave up
        // on): ignored, never applied to the quit in progress.
        log.warn("[runner-ipc] hostQuit respond with no waiter", {
          requestId,
          windowId,
        });
        return;
      }
      const decision =
        record === null ? null : parseHostQuitDecision(record.decision);
      if (decision === null) {
        // The request was acknowledged, so no timer would ever end the wait:
        // fail it, and the transaction asks natively instead.
        waiter.reject(new Error("Host quit decision malformed"));
        return;
      }
      waiter.resolve({ requestId, decision });
    },
  );
}

/** A `HostQuitDecision`, or `null` for anything that is not exactly one. */
export function parseHostQuitDecision(value: unknown): HostQuitDecision | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "keep":
      return typeof value.remember === "boolean"
        ? { kind: "keep", remember: value.remember }
        : null;
    case "stop":
      return typeof value.force === "boolean" &&
        typeof value.remember === "boolean"
        ? { kind: "stop", force: value.force, remember: value.remember }
        : null;
    case "cancel":
      return { kind: "cancel" };
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
