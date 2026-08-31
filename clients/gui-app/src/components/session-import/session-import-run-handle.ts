import type { SessionImportSelection } from "@traycer/protocol/host/session-import/candidate";
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

interface SessionImportStartHandle {
  readonly start: (request: SessionImportRunRequest) => void;
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

export function startSessionImportRun(request: SessionImportRunRequest): void {
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
  handle.start(request);
}
