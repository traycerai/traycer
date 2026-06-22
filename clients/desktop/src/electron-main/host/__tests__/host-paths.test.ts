import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { getHostFsLayout } from "../host-paths";

/**
 * Pin the cross-workspace contract: the desktop runner MUST look for the
 * host PID metadata at the environment-scoped path that the CLI supervisor
 * and the host runtime agree on. Prod = `~/.traycer/host/pid.json`;
 * dev = `~/.traycer/host/dev/pid.json`. Changing these without also
 * updating the host (the external Traycer Host) helper
 * `getDefaultHostPidMetadataPath` AND the CLI's
 * `clients/traycer-cli/src/store/paths.ts` breaks local host
 * discovery.
 */
describe("getHostFsLayout", () => {
  it("resolves the prod ~/.traycer/host/pid.json metadata path", () => {
    const layout = getHostFsLayout("production");
    expect(layout.environment).toBe("production");
    expect(layout.rootDir).toBe(join(homedir(), ".traycer", "host"));
    expect(layout.pidMetadataFile).toBe(
      join(homedir(), ".traycer", "host", "pid.json"),
    );
    expect(layout.logFile).toBe(
      join(homedir(), ".traycer", "host", "host.log"),
    );
  });

  it("resolves the prod path when environment='production' is passed explicitly", () => {
    const layout = getHostFsLayout("production");
    expect(layout.environment).toBe("production");
    expect(layout.rootDir).toBe(join(homedir(), ".traycer", "host"));
    expect(layout.pidMetadataFile).toBe(
      join(homedir(), ".traycer", "host", "pid.json"),
    );
    expect(layout.logFile).toBe(
      join(homedir(), ".traycer", "host", "host.log"),
    );
  });

  it("nests the dev environment one level deeper under ~/.traycer/host/dev/", () => {
    const layout = getHostFsLayout("dev");
    expect(layout.environment).toBe("dev");
    expect(layout.rootDir).toBe(join(homedir(), ".traycer", "host", "dev"));
    expect(layout.pidMetadataFile).toBe(
      join(homedir(), ".traycer", "host", "dev", "pid.json"),
    );
    expect(layout.logFile).toBe(
      join(homedir(), ".traycer", "host", "dev", "host.log"),
    );
  });

  // Channel-aware install record paths (Ticket 29cf341f). The host-
  // management IPC reads the install record from `installRecordFile`;
  // dev Desktop must point at `~/.traycer/host/dev/install/install.json`
  // so a `make dev-desktop` session never reads the production install
  // record (and never mutates prod via host-install/uninstall).
  it("exposes the prod install dir + install record at ~/.traycer/host/install/install.json", () => {
    const layout = getHostFsLayout("production");
    expect(layout.installDir).toBe(
      join(homedir(), ".traycer", "host", "install"),
    );
    expect(layout.installRecordFile).toBe(
      join(homedir(), ".traycer", "host", "install", "install.json"),
    );
  });

  it("exposes the dev install dir + install record at ~/.traycer/host/dev/install/install.json", () => {
    const layout = getHostFsLayout("dev");
    expect(layout.installDir).toBe(
      join(homedir(), ".traycer", "host", "dev", "install"),
    );
    expect(layout.installRecordFile).toBe(
      join(homedir(), ".traycer", "host", "dev", "install", "install.json"),
    );
  });
});
