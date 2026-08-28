/**
 * Structural double for `IpcHostController`, shared by every IPC suite that
 * needs a bridge but is not testing the controller itself (see
 * `host-controller.test.ts` for that) - so each method just resolves a
 * plausible "ok" outcome.
 *
 * It lives here rather than in each suite because `HostControllerStatus` and
 * the mutation outcomes keep growing: a per-suite copy compiles until the day
 * a field is added, and then only the copies whose authors are in the room get
 * updated. One implementation means one compile error, in the file the person
 * adding the field is already looking at.
 */
import type {
  ActivateInstalledOk,
  ApplyStagedOk,
  ApplyStagedTrigger,
  ConvergeReadyOk,
  HostControllerStatus,
  InstallVersionOk,
  LifecycleAdmissionBlock,
  MutationOutcome,
  MutationProgress,
  RemoveTraycerOk,
  ServiceRegistrationOk,
  UninstallOk,
} from "../../host/host-controller-types";
import type { IpcHostController } from "../runner-ipc-bridge";

export const FAKE_HOST_CONTROLLER_STATUS: HostControllerStatus = {
  download: null,
  mutation: null,
  installedVersion: "1.0.0",
  latestVersion: "1.0.0",
  stagedVersion: null,
  installedRuntimeVersion: "1.0.0",
  runningRuntimeVersion: "1.0.0",
  updateReady: false,
  activation: "activated",
  reachable: true,
  localAttempt: null,
  removedByUser: false,
  checkedAt: "2026-01-01T00:00:00.000Z",
};

export class FakeHostController implements IpcHostController {
  /** Lets the one suite that cares (`requestHostRespawn`) assert without a
   * real controller instance. */
  respawnCalls = 0;

  readonly lifecycleAdmissionBlock: LifecycleAdmissionBlock | null = null;
  async getStatus(): Promise<HostControllerStatus> {
    return FAKE_HOST_CONTROLLER_STATUS;
  }
  async convergeReady(
    _force: boolean,
  ): Promise<MutationOutcome<ConvergeReadyOk>> {
    return { kind: "ok", value: { running: true, version: "1.0.0" } };
  }
  async stageLatest(): Promise<void> {}
  async applyStaged(
    _trigger: ApplyStagedTrigger,
    _force: boolean,
  ): Promise<MutationOutcome<ApplyStagedOk>> {
    return {
      kind: "ok",
      value: { appliedVersion: "1.0.0", runningActivated: true },
    };
  }
  async activateInstalled(
    _force: boolean,
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    return { kind: "ok", value: { activated: true } };
  }
  async installVersion(
    pin: string,
    _force: boolean,
  ): Promise<MutationOutcome<InstallVersionOk>> {
    return {
      kind: "ok",
      value: { installedVersion: pin, runningActivated: true },
    };
  }
  async registerService(): Promise<MutationOutcome<ServiceRegistrationOk>> {
    return { kind: "ok", value: { registered: true } };
  }
  async deregisterService(): Promise<MutationOutcome<ServiceRegistrationOk>> {
    return { kind: "ok", value: { registered: false } };
  }
  async respawn(): Promise<MutationOutcome<ActivateInstalledOk>> {
    this.respawnCalls += 1;
    return { kind: "ok", value: { activated: true } };
  }
  async recoverIfDown(): Promise<
    MutationOutcome<ActivateInstalledOk> | { readonly kind: "suppressed" }
  > {
    return { kind: "suppressed" };
  }
  async freePortAndRestart(
    _pid: number | null,
    _port: number | null,
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    return { kind: "ok", value: { activated: true } };
  }
  async uninstallHost(_all: boolean): Promise<MutationOutcome<UninstallOk>> {
    return {
      kind: "ok",
      value: {
        removedInstallDir: true,
        deregisteredService: true,
        serviceRegistrationRetained: null,
      },
    };
  }
  async removeTraycer(): Promise<MutationOutcome<RemoveTraycerOk>> {
    return {
      kind: "ok",
      value: {
        removedHost: true,
        deregisteredService: true,
        serviceRegistrationRetained: null,
        removedLoginItem: false,
      },
    };
  }
  isPendingRevisionRefreshQuarantined(): boolean {
    return false;
  }
  onMutationProgress(
    _listener: (progress: MutationProgress) => void,
  ): () => void {
    return () => undefined;
  }
}
