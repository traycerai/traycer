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
