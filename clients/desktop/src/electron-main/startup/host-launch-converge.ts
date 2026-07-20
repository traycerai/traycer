import { log } from "../app/logger";
import type { HostRegistryUpdateState } from "../../ipc-contracts/host-management-types";
import { refreshRegistryUpdateState } from "../ipc/host-management-ipc";
import { isHostRemovedByUser } from "../host/host-removal-state";
import type { IpcHostController } from "../ipc/runner-ipc-bridge";

// Narrowed to the one method this module actually drives - declared here
// (not imported from `menu-controller.ts`) so tests can pass a lightweight
// double instead of constructing the real `MenuController`, the same "narrow
// interface for testability" pattern `IpcHostController` uses for
// `HostController`. The real `MenuController` satisfies this structurally.
export interface HostUpdateMenuSurface {
  setHostUpdateAvailableVersion(version: string | null): void;
}

// Reflects the host update availability into the app menu's "Update host"
// affordance. Shared by the launch probe, the periodic/resume refreshes, and
// the launch converge reconcile below so all of them keep the menu in
// lockstep with the cached registry state.
export function applyHostUpdateMenuState(
  menu: HostUpdateMenuSurface,
  state: HostRegistryUpdateState,
): void {
  if (state.updateAvailable && state.latestVersion !== null) {
    menu.setHostUpdateAvailableVersion(state.latestVersion);
  } else {
    menu.setHostUpdateAvailableVersion(null);
  }
}

// Shared by the launch probe, the periodic timer, the resume trigger, and the
// launch converge reconcile below. `refreshRegistryUpdateState` never throws
// and is internally serialized (`registryRefreshQueue`), so overlapping calls
// are safe. Narrow params (not `AppServices`) so callers can exercise this
// with lightweight fakes in a test.
export async function refreshHostRegistryIfNotRemoved(
  hostController: IpcHostController,
  menu: HostUpdateMenuSurface,
  opts: { readonly force: boolean; readonly maxAgeMs: number | null },
): Promise<void> {
  if (await isHostRemovedByUser()) return;
  const result = await refreshRegistryUpdateState(hostController, opts);
  applyHostUpdateMenuState(menu, result);
}

// Launch-time boot reconcile (Fixup B1 + B2): converges any pre-existing
// activation debt AND applies an eligible staged update, in the correct
// priority order. `applyStaged`'s own no-op fast path is broader than
// `activateInstalled`'s internal "ready update supersedes debt" branch (the
// former also short-circuits on `staged === null`), so the boot policy is
// decided explicitly here - apply when a stage is ready, activate when not -
// rather than delegating to `activateInstalled`'s narrower internal check.
// Exported (and kept in its own Electron-free module) so this can be
// exercised directly with `IpcHostController` / `HostUpdateMenuSurface`
// fakes, through the same path `runDeferred` calls - per the ticket, B1/B2
// must be proven through the production startup wiring, not by calling
// controller methods directly.
export async function runLaunchHostConvergeReconcile(
  hostController: IpcHostController,
  menu: HostUpdateMenuSurface,
): Promise<void> {
  const initialStatus = await hostController.getStatus();
  if (initialStatus.removedByUser) {
    log.info("[host-controller] launch converge skipped for removed host");
    return;
  }

  // Registry discovery stages asynchronously so a generic refresh never
  // blocks its caller on a WAN download. At launch that is insufficient: a
  // reconcile which samples status before staging finishes would leave the
  // new release dormant until a later launch. Join (or start) the same
  // controller-owned staging work, then make the apply/activate decision
  // from the post-stage status.
  await hostController.stageLatest();
  const status = await hostController.getStatus();
  if (status.removedByUser) {
    log.info("[host-controller] launch converge skipped after staging removal");
    return;
  }

  const outcome = status.updateReady
    ? await hostController.applyStaged("launch", false)
    : status.activation === "pendingActivation" ||
        status.activation === "activationUnknown"
      ? await hostController.activateInstalled(false)
      : null;

  if (outcome === null) {
    log.info("[host-controller] launch converge has no activation debt", {
      activation: status.activation,
    });
    return;
  }

  log.info("[host-controller] launch converge reconcile complete", {
    updateReady: status.updateReady,
    kind: outcome.kind,
  });
  // Fixup B1: a successful apply just moved `installedVersion` (and cleared
  // the stage), so the cache/menu built from the pre-apply registry snapshot
  // is now stale - force a re-probe so `updateAvailable` (now correctly
  // `updateReady`-derived) reflects the freshly applied version instead of
  // advertising the update we just installed. `activateInstalled` never moves
  // `installedVersion`, so there's nothing new to advertise on that branch.
  if (status.updateReady && outcome.kind === "ok") {
    await refreshHostRegistryIfNotRemoved(hostController, menu, {
      force: true,
      maxAgeMs: null,
    });
  }
}
