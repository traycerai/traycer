import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import { appLogger } from "@/lib/logger";

// Module-scoped handle so non-React callers (e.g. settings-panel button) can
// trigger a migration run without prop-drilling. Lives in its own file
// because TanStack Router fast-refresh requires `migration-run-controller.tsx`
// to export only components.

/**
 * The run's TARGET, handed in by the surface that asked for it rather than
 * read from the window's ambient binding: a migration moves ONE machine's
 * local data, so the transport, the host name and the transport lease travel
 * together as one value.
 */
export interface MigrationRunTarget {
  readonly binding: StreamRuntimeBinding;
  readonly hostId: string;
}

interface MigrationStartHandle {
  readonly start: (target: MigrationRunTarget) => void;
}

const ref: { current: MigrationStartHandle | null } = { current: null };

export function setMigrationStartHandle(
  handle: MigrationStartHandle | null,
): void {
  ref.current = handle;
}

export function getMigrationStartHandle(): MigrationStartHandle | null {
  return ref.current;
}

export function startMigrationRun(binding: StreamRuntimeBinding | null): void {
  const handle = ref.current;
  if (handle === null) return;
  if (binding === null || binding.hostId === null) {
    // No stream, or one that cannot name its machine: there is nowhere to run
    // the migration and nothing to file its progress under. The button that
    // asked stays enabled, so the click is lost - do not lose it silently.
    appLogger.error(
      "[migration] migration requested with no named host to run it on",
      {},
      new Error("migration requested without a bound stream host"),
    );
    return;
  }
  handle.start({ binding, hostId: binding.hostId });
}

export function isMigrationRunStartReady(): boolean {
  return ref.current !== null;
}
