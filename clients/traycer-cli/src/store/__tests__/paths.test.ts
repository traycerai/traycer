import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bootstrapLogPath,
  cliHomeDir,
  cliInstallHomeDir,
  cliLockPath,
  cliLogPath,
  cliManifestPath,
  cliPostFinalizeMarkerPath,
  cliSharedHomeDir,
  hostHomeDir,
  hostInstallDir,
  hostInstallRecordPath,
  hostLogPath,
  hostPidMetadataPath,
  hostStagingRoot,
  hostUpdateProgressMarkerPath,
  hostVersionsDir,
  traycerHomeDir,
} from "../paths";
import { withDevDesktopSlot } from "@traycer-clients/shared/test-fixtures/dev-desktop-slot";

const TRAYCER_HOME = join(homedir(), ".traycer");
const CLI_HOME = join(TRAYCER_HOME, "cli");
const HOST_HOME = join(TRAYCER_HOME, "host");

describe("store/paths host helpers", () => {
  it("anchors all paths under the single ~/.traycer root", () => {
    expect(traycerHomeDir()).toBe(TRAYCER_HOME);
    expect(cliSharedHomeDir()).toBe(CLI_HOME);
    expect(hostHomeDir(undefined)).toBe(HOST_HOME);
    expect(hostHomeDir("production")).toBe(HOST_HOME);
    expect(hostHomeDir("dev")).toBe(join(HOST_HOME, "dev"));
  });

  it("uses a per-run host root for dev-desktop slots", () => {
    withDevDesktopSlot("My Slot", () => {
      expect(hostHomeDir("production")).toBe(HOST_HOME);
      expect(hostHomeDir("dev")).toBe(join(HOST_HOME, "dev-runs", "my-slot"));
      expect(hostPidMetadataPath("dev")).toBe(
        join(HOST_HOME, "dev-runs", "my-slot", "pid.json"),
      );
      expect(hostLogPath("dev")).toBe(
        join(HOST_HOME, "dev-runs", "my-slot", "host.log"),
      );
    });
  });

  it("resolves host runtime files to the environment root", () => {
    expect(hostPidMetadataPath("production")).toBe(join(HOST_HOME, "pid.json"));
    expect(hostPidMetadataPath("dev")).toBe(join(HOST_HOME, "dev", "pid.json"));
    expect(hostLogPath("production")).toBe(join(HOST_HOME, "host.log"));
    expect(hostLogPath("dev")).toBe(join(HOST_HOME, "dev", "host.log"));
    // bootstrap markers share the host log file by design.
    expect(bootstrapLogPath("production")).toBe(hostLogPath("production"));
    expect(bootstrapLogPath("dev")).toBe(hostLogPath("dev"));
    // Legacy non-environment callers (bootstrap-log, pid-metadata) resolve
    // to the prod root.
    expect(bootstrapLogPath(undefined)).toBe(hostLogPath("production"));
    expect(hostPidMetadataPath(undefined)).toBe(
      hostPidMetadataPath("production"),
    );
    expect(hostLogPath(undefined)).toBe(hostLogPath("production"));
  });

  it("resolves host install/staging dirs per environment", () => {
    expect(hostInstallDir("production")).toBe(join(HOST_HOME, "install"));
    expect(hostInstallDir("dev")).toBe(join(HOST_HOME, "dev", "install"));
    // "install-staging" is the host install temp/extract area, kept distinct
    // from the host root.
    expect(hostStagingRoot("production")).toBe(
      join(HOST_HOME, "install-staging"),
    );
    expect(hostStagingRoot("dev")).toBe(
      join(HOST_HOME, "dev", "install-staging"),
    );
  });

  it("constructs the install-record path under the environment install dir", () => {
    expect(hostInstallRecordPath("production")).toBe(
      join(HOST_HOME, "install", "install.json"),
    );
    expect(hostInstallRecordPath("dev")).toBe(
      join(HOST_HOME, "dev", "install", "install.json"),
    );
    // The record always sits directly inside the environment install dir.
    expect(hostInstallRecordPath("production")).toBe(
      join(hostInstallDir("production"), "install.json"),
    );
    expect(hostInstallRecordPath("dev")).toBe(
      join(hostInstallDir("dev"), "install.json"),
    );
  });

  it("resolves the versioned-installs root as a sibling of install/, not nested under it", () => {
    expect(hostVersionsDir("production")).toBe(join(HOST_HOME, "versions"));
    expect(hostVersionsDir("dev")).toBe(join(HOST_HOME, "dev", "versions"));
    expect(hostVersionsDir("production")).not.toBe(
      hostInstallDir("production"),
    );
    expect(
      hostVersionsDir("production").startsWith(
        hostInstallDir("production") + "/",
      ),
    ).toBe(false);
  });

  it("resolves the update-progress marker directly under the environment host root", () => {
    expect(hostUpdateProgressMarkerPath("production")).toBe(
      join(HOST_HOME, "update-progress.json"),
    );
    expect(hostUpdateProgressMarkerPath("dev")).toBe(
      join(HOST_HOME, "dev", "update-progress.json"),
    );
  });

  it("keeps prod and dev host trees disjoint under the shared root", () => {
    const prod = hostInstallRecordPath("production");
    const dev = hostInstallRecordPath("dev");
    expect(prod).not.toBe(dev);
    // Dev paths always nest under prod-root/dev - never a sibling like
    // ~/.traycer-dev/ - so a single ~/.traycer/ rm purges both.
    expect(dev.startsWith(HOST_HOME + "/")).toBe(true);
    expect(prod.startsWith(HOST_HOME + "/")).toBe(true);
  });
});

describe("store/paths CLI helpers", () => {
  it("treats the CLI home as shared without a environment and per-environment with one", () => {
    expect(cliHomeDir(undefined)).toBe(CLI_HOME);
    expect(cliHomeDir("production")).toBe(CLI_HOME);
    expect(cliHomeDir("dev")).toBe(join(CLI_HOME, "dev"));
    expect(cliInstallHomeDir("dev")).toBe(join(CLI_HOME, "dev"));
  });

  it("places per-environment manifest/lock/post-finalize markers under the environment CLI dir", () => {
    expect(cliManifestPath("production")).toBe(join(CLI_HOME, "manifest.json"));
    expect(cliManifestPath("dev")).toBe(join(CLI_HOME, "dev", "manifest.json"));
    expect(cliLockPath("production")).toBe(join(CLI_HOME, ".lock"));
    expect(cliLockPath("dev")).toBe(join(CLI_HOME, "dev", ".lock"));
    expect(cliPostFinalizeMarkerPath("production")).toBe(
      join(CLI_HOME, "post-finalize.json"),
    );
    expect(cliPostFinalizeMarkerPath("dev")).toBe(
      join(CLI_HOME, "dev", "post-finalize.json"),
    );
  });

  it("moves only dev CLI install surfaces into the dev-desktop run slot", () => {
    withDevDesktopSlot("Example Slot", () => {
      const slotRoot = join(CLI_HOME, "dev-runs", "example-slot");
      expect(cliHomeDir("dev")).toBe(join(CLI_HOME, "dev"));
      expect(cliInstallHomeDir("dev")).toBe(slotRoot);
      expect(cliManifestPath("dev")).toBe(join(slotRoot, "manifest.json"));
      expect(cliLockPath("dev")).toBe(join(slotRoot, ".lock"));
      expect(cliLogPath("dev")).toBe(join(slotRoot, "cli.log"));
      expect(cliPostFinalizeMarkerPath("dev")).toBe(
        join(slotRoot, "post-finalize.json"),
      );
    });
  });
});
