// Module-scoped handle so non-React callers (e.g. settings-panel button) can
// trigger a migration run without prop-drilling. Lives in its own file
// because TanStack Router fast-refresh requires `migration-run-controller.tsx`
// to export only components.

interface MigrationStartHandle {
  readonly start: () => void;
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

export function startMigrationRun(): void {
  ref.current?.start();
}

export function isMigrationRunStartReady(): boolean {
  return ref.current !== null;
}
