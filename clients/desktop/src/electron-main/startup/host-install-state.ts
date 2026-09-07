import { log } from "../app/logger";
import type { HostControllerStatus } from "../host/host-controller-types";

export interface HostInstallStateSurface {
  getStatus(): Promise<HostControllerStatus>;
}

// The one lifecycle method the boot seam drives here. Same narrow-interface
// pattern, so the wiring below is exercised against a fake rather than only
// through a full Electron boot.
export interface HostBootstrapSurface {
  bootstrap(options: { readonly hostInstalled: boolean }): Promise<void>;
}

/** Only the install record separates a missing host from an unavailable one; the lifecycle must not read it directly. */
export async function readHostInstalledForBootstrap(
  hostController: HostInstallStateSurface,
): Promise<boolean> {
  try {
    const status = await hostController.getStatus();
    return status.installedVersion !== null;
  } catch (err) {
    log.warn("[host] install-state read failed - keeping the readiness wait", {
      err,
    });
    return true;
  }
}

export async function bootstrapHostWithInstallState(
  host: HostBootstrapSurface,
  hostController: HostInstallStateSurface,
): Promise<void> {
  return host.bootstrap({
    hostInstalled: await readHostInstalledForBootstrap(hostController),
  });
}
