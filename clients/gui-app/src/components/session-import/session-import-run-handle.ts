import type { SessionImportSelection } from "@traycer/protocol/host/session-import/candidate";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import { appLogger } from "@/lib/logger";

// Module-scoped handle so any surface can start an import without the run stream being owned by - and
// therefore dying with - the component that asked for it.

export interface SessionImportRunRequest {
  readonly selections: ReadonlyArray<SessionImportSelection>;
  readonly titles: ReadonlyMap<string, string>;
}

/** The run's target, handed in by the surface that asked for it rather than read from the window's ambient
 * binding. */
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
    // Nothing here can recover the click, so the least this can do is not swallow it silently.
    appLogger.error(
      "[session-import] import requested with no run controller mounted",
      { selection_count: request.selections.length },
      new Error("session import start handle is not registered"),
    );
    return;
  }
  if (binding === null || binding.hostId === null) {
    // No stream, or one that cannot name its machine: there is nowhere to send the selections and nothing to file
    // the progress under.
    appLogger.error(
      "[session-import] import requested with no named host to run it on",
      { selection_count: request.selections.length },
      new Error("session import requested without a bound stream host"),
    );
    return;
  }
  handle.start(request, { binding, hostId: binding.hostId });
}
