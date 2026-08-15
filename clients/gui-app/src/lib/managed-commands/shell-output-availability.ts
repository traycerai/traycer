import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { HostReachability } from "@/hooks/agent/use-host-reachability";

/**
 * Everything the output window can be, other than a shell's log scrolling by.
 *
 * ONE union drives the panel, and one component renders it, because the states
 * used to be scattered across four call sites with four vocabularies - and
 * drifted: every fatal stream close read as "This shell was deleted", a host
 * that was merely old could be blamed for a deletion, and an opened-but-empty
 * log was indistinguishable from a dead connection.
 *
 * The split that matters is TERMINAL versus RECOVERABLE. A terminal state
 * (`gone`, `unauthorized`) replaces the whole panel with one sentence and a way
 * out: whatever this window had read is not the log - the host destroyed or
 * withdrew that - and keeping a ghost of it on screen contradicted the deleted-
 * shell model everywhere else (deletion destroys the history; the start card's
 * door is disabled). A recoverable state (`stale`, `stream-error`) keeps the
 * cached content in view under a banner, because the same lines will still be
 * there when the stream comes back.
 */
export type ShellOutputAvailability =
  | {
      readonly kind: "bootstrapping";
      readonly phase: "checking-host" | "starting-host" | "opening-stream";
    }
  | { readonly kind: "unsupported-host" }
  | { readonly kind: "unreachable-host"; readonly hostLabel: string }
  /**
   * TERMINAL. `deleted` is the host telling this open window it just destroyed
   * the shell; `not-found` is the host refusing to open one it does not have -
   * deleted while the app was shut, or an id it never held. The refusal is
   * deliberately oracle-free on the wire, so the copy must not claim more.
   */
  | { readonly kind: "gone"; readonly cause: "deleted" | "not-found" }
  /** TERMINAL. The viewer's role on the epic went away, at open or mid-stream. */
  | { readonly kind: "unauthorized" }
  /**
   * RECOVERABLE. Any other fatal close - the host's opening read threw, the
   * mirror check failed. Not a statement about the shell, so the shell's own
   * controls stay usable and the stream can be reopened.
   */
  | { readonly kind: "stream-error"; readonly message: string }
  /** RECOVERABLE. Keyed on whether a snapshot ever landed, not on line count. */
  | { readonly kind: "stale"; readonly phase: "connecting" | "reconnecting" }
  /** Open, snapshot landed, nothing in the log yet. */
  | { readonly kind: "empty" }
  | { readonly kind: "available" };

/**
 * The states that take the whole panel: nothing else - no timeline, no
 * floating chrome - renders under them.
 */
export type ShellOutputPanelAvailability = Extract<
  ShellOutputAvailability,
  {
    kind:
      | "bootstrapping"
      | "unsupported-host"
      | "unreachable-host"
      | "gone"
      | "unauthorized";
  }
>;

/** The states that sit as a strip above a timeline that stays readable. */
export type ShellOutputBannerAvailability = Extract<
  ShellOutputAvailability,
  { kind: "stale" | "stream-error" }
>;

export function isShellOutputPanelReplacement(
  availability: ShellOutputAvailability,
): availability is ShellOutputPanelAvailability {
  switch (availability.kind) {
    case "bootstrapping":
    case "unsupported-host":
    case "unreachable-host":
    case "gone":
    case "unauthorized":
      return true;
    case "stream-error":
    case "stale":
    case "empty":
    case "available":
      return false;
  }
}

export function isShellOutputBanner(
  availability: ShellOutputAvailability,
): availability is ShellOutputBannerAvailability {
  return availability.kind === "stale" || availability.kind === "stream-error";
}

/**
 * What the window can say before it has a stream: the host-directory gate.
 * `null` means the host is reachable and the stream should be opened.
 */
export function shellOutputHostAvailability(
  reachability: HostReachability,
): ShellOutputPanelAvailability | null {
  switch (reachability.status) {
    case "checking":
      return { kind: "bootstrapping", phase: "checking-host" };
    case "host-starting":
      return { kind: "bootstrapping", phase: "starting-host" };
    case "unreachable":
      return { kind: "unreachable-host", hostLabel: reachability.hostLabel };
    case "reachable":
      return null;
  }
}

/** The signals an open stream session gives the window, in one place. */
export interface ShellOutputStreamSignals {
  /**
   * The BOUND host's negotiated support for the output method - read from the
   * client this window's own subscription rides on, never the app's default
   * host, which may be a different machine on a different version.
   */
  readonly streamSupport: StreamMethodSupport | null;
  readonly connectionStatus: StreamConnectionStatus;
  /** Whether the opening snapshot has ever landed on this session. */
  readonly snapshotArrived: boolean;
  readonly hasLines: boolean;
  /** The host announced the deletion to this open window. */
  readonly deleted: boolean;
  /** The host closed the stream for good, and said why. */
  readonly fatalClose: FatalErrorDetails | null;
}

/**
 * Priority, top to bottom: capability, then what the host proved about the
 * shell, then how the stream itself is doing, then whether there is anything
 * to read.
 *
 * `deleted` outranks a fatal close because it is the stronger claim: a
 * `deleted` frame is the host saying so, a `NOT_FOUND` after it is only the
 * reconnect discovering the same thing. Every fatal close that is not one of
 * the two named codes stays a stream failure - the old collapse of "any fatal
 * close" into "gone" is exactly the bug this replaces.
 */
export function shellOutputStreamAvailability(
  signals: ShellOutputStreamSignals,
): ShellOutputAvailability {
  if (signals.streamSupport === "unsupported") {
    return { kind: "unsupported-host" };
  }
  if (signals.deleted) return { kind: "gone", cause: "deleted" };
  if (signals.fatalClose !== null) {
    return classifyFatalClose(signals.fatalClose);
  }
  // Until the opening tail lands the window is still connecting, whatever the
  // transport says: the socket declares itself open the moment the subscribe
  // is acknowledged, but the host serves the snapshot only after its first
  // log read, and a blank surface with no word on it reads as broken.
  if (!signals.snapshotArrived) return { kind: "stale", phase: "connecting" };
  if (signals.connectionStatus !== "open") {
    return { kind: "stale", phase: "reconnecting" };
  }
  if (!signals.hasLines) return { kind: "empty" };
  return { kind: "available" };
}

/**
 * The host closes an output stream for good under three names, and only one
 * of them means the shell is gone. `UNAUTHORIZED` is about the viewer;
 * anything else (`MANAGED_COMMAND_OUTPUT_FAILED`, an `INCOMPATIBLE` mirror
 * verdict) is about the stream. Routed by the code the host actually sent,
 * never by whether a snapshot happened to arrive first.
 */
function classifyFatalClose(
  details: FatalErrorDetails,
): ShellOutputAvailability {
  switch (details.code) {
    case "MANAGED_COMMAND_NOT_FOUND":
      return { kind: "gone", cause: "not-found" };
    case "UNAUTHORIZED":
      return { kind: "unauthorized" };
    default:
      return { kind: "stream-error", message: details.reason };
  }
}
