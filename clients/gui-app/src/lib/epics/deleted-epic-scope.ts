import { getEpicSessionController } from "@/lib/registries/epic-session-controller";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";

/** A Task delete's successes, by the scope each deletion had. */
export interface DeletedEpicScopes {
  /** Deleted from the account: gone on every host. */
  readonly accountWideIds: ReadonlyArray<string>;
  /**
   * Deleted on `deletingHostId` alone (a local-homed Task). Another host may
   * still serve the same id.
   */
  readonly hostScopedIds: ReadonlyArray<string>;
  /** The host that enacted the delete; `null` when none is known. */
  readonly deletingHostId: string | null;
}

/**
 * The deleted Tasks this window has lost, for its tab teardown, its
 * announcement and the navigation away. Every account-wide deletion; a
 * host-scoped one only where this window holds that Task on the host that
 * deleted it (`readEpicHostId`: every tab of an epic in a window shares one
 * session host), or, when no tab holds it, where the window's own host
 * (`windowHostId`) is that host. A same-id Task this window holds on another
 * host is still there, and keeps its tabs.
 */
export function epicIdsLostInWindow(
  scopes: DeletedEpicScopes,
  windowHostId: string | null,
): string[] {
  const deletingHostId = scopes.deletingHostId;
  const lostHostScoped =
    deletingHostId === null
      ? []
      : scopes.hostScopedIds.filter(
          (epicId) =>
            (getEpicSessionController().readEpicHostId(epicId) ??
              windowHostId) === deletingHostId,
        );
  return [...new Set([...scopes.accountWideIds, ...lostHostScoped])];
}

/**
 * Drop the deleted Tasks' composer settings in the scope each deletion had:
 * on every host for an account-wide deletion, on the deleting host alone for
 * a host-scoped one.
 */
export function clearDeletedEpicRunSettings(scopes: DeletedEpicScopes): void {
  const store = useComposerRunSettingsStore.getState();
  store.clearEpicRunSettings(scopes.accountWideIds);
  if (scopes.deletingHostId !== null) {
    store.clearEpicRunSettingsForHost(
      scopes.hostScopedIds,
      scopes.deletingHostId,
    );
  }
}
