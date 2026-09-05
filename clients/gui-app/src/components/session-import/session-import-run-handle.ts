import type { SessionImportSelection } from "@traycer/protocol/host/session-import/candidate";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import { appLogger } from "@/lib/logger";

// Module-scoped handle so any surface can start an import without the run
// stream being owned by - and therefore dying with - the component that asked
// for it. Lives in its own file because TanStack Router fast-refresh requires
// `session-import-run-controller.tsx` to export only components.

export interface SessionImportRunRequest {
  readonly selections: ReadonlyArray<SessionImportSelection>;
  /** Display titles by selection key, for the progress and summary views. */
  readonly titles: ReadonlyMap<string, string>;
}

/**
 * The run's TARGET, handed in by the surface that asked for it rather than
 * read from the window's ambient binding: transport, host name and transport
 * lease as one value, so an import started from a host-scoped panel runs on
 * the host that panel is showing.
 */
export interface SessionImportRunTarget {
  readonly binding: StreamRuntimeBinding;
  readonly hostId: string;
}

interface SessionImportStartHandle {
  readonly start: (
    request: SessionImportRunRequest,
    target: SessionImportRunTarget,
  ) => void;
  /**
   * Asks the target host whether an import is already running and, if so,
   * attaches to it so its slice fills in. A no-op for a host this window is
   * already running or asking.
   */
  readonly probe: (target: SessionImportRunTarget) => void;
  /** Withdraws a surface's still-unanswered probe; see `cancelSessionImportProbe`. */
  readonly cancelProbe: (target: SessionImportRunTarget) => void;
}

const ref: { current: SessionImportStartHandle | null } = { current: null };

export function setSessionImportStartHandle(
  handle: SessionImportStartHandle | null,
): void {
  ref.current = handle;
}

export function getSessionImportStartHandle(): SessionImportStartHandle | null {
  return ref.current;
}

export function startSessionImportRun(
  request: SessionImportRunRequest,
  binding: StreamRuntimeBinding | null,
): void {
  const handle = ref.current;
  if (handle === null) {
    // The controller is mounted app-wide, so a missing handle means the surface
    // that asked renders outside it - the shape of the bug where onboarding's
    // Import button did nothing at all. Nothing here can recover the click, so
    // the least this can do is not swallow it silently.
    appLogger.error(
      "[session-import] import requested with no run controller mounted",
      { selection_count: request.selections.length },
      new Error("session import start handle is not registered"),
    );
    return;
  }
  if (binding === null || binding.hostId === null) {
    // No stream, or one that cannot name its machine: there is nowhere to send
    // the selections and nothing to file the progress under. Same reasoning as
    // above - the click is lost either way, so say so.
    appLogger.error(
      "[session-import] import requested with no named host to run it on",
      { selection_count: request.selections.length },
      new Error("session import requested without a bound stream host"),
    );
    return;
  }
  handle.start(request, { binding, hostId: binding.hostId });
}

/**
 * A surface that is about to offer selections for `binding`'s host asks this
 * first. The app-wide controller only ever probes the window's own host on
 * its own, so a host that is already importing - started from another window,
 * or before a reload - looks idle to a wizard opened for it, and a submission
 * would subscribe with new selections that the host silently folds into the
 * run in flight. Probing attaches to that run instead, so the wizard shows
 * its progress and offers nothing. A question rather than a click, so a
 * missing controller or an unnamed host is simply nothing to ask.
 */
export function probeSessionImportRun(
  binding: StreamRuntimeBinding | null,
): void {
  const handle = ref.current;
  if (handle === null) return;
  if (binding === null || binding.hostId === null) return;
  handle.probe({ binding, hostId: binding.hostId });
}

/**
 * The surface's question withdrawn, for the wizard's effect cleanup: a probe
 * still waiting when the wizard closes is closed and its transport lease
 * returned. One that already attached is the run's subscription and stays; the
 * wizard's own effect asks again on its next open.
 */
export function cancelSessionImportProbe(
  binding: StreamRuntimeBinding | null,
): void {
  const handle = ref.current;
  if (handle === null) return;
  if (binding === null || binding.hostId === null) return;
  handle.cancelProbe({ binding, hostId: binding.hostId });
}
