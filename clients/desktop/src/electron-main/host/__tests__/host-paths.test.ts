import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getHostFsLayout,
  labelForEnvironment,
  smAppServiceAgentLabelId,
} from "../host-paths";
import {
  serviceLabelFor,
  smAppServiceAgentLabelId as cliSmAppServiceAgentLabelId,
} from "../../../../../traycer-cli/src/service/label";
import { withDevDesktopSlot } from "@traycer-clients/shared/test-fixtures/dev-desktop-slot";

/** Pin the cross-workspace contract: the desktop runner MUST look for the host PID metadata at the environment-scoped path that the CLI supervisor and the host runtime agree on. */
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

  it("resolves the browser telemetry/trace files (+ .1 rotation siblings) beside host.log", () => {
    const layout = getHostFsLayout("production");
    const root = join(homedir(), ".traycer", "host");
    expect(layout.browserTelemetryFile).toBe(
      join(root, "browser-telemetry.jsonl"),
    );
    expect(layout.browserTelemetryRotatedFile).toBe(
      join(root, "browser-telemetry.jsonl.1"),
    );
    expect(layout.browserTraceFile).toBe(join(root, "browser-trace.jsonl"));
    expect(layout.browserTraceRotatedFile).toBe(
      join(root, "browser-trace.jsonl.1"),
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

  it("uses a per-run dev host root when DEV_DESKTOP_SLOT is set", () => {
    withDevDesktopSlot("Worktree Slot", () => {
      const layout = getHostFsLayout("dev");
      const root = join(
        homedir(),
        ".traycer",
        "host",
        "dev-runs",
        "worktree-slot",
      );
      expect(layout.environment).toBe("dev");
      expect(layout.rootDir).toBe(root);
      expect(layout.pidMetadataFile).toBe(join(root, "pid.json"));
      expect(layout.logFile).toBe(join(root, "host.log"));
      expect(layout.installRecordFile).toBe(
        join(root, "install", "install.json"),
      );
    });
  });
});

/** It MUST agree with the in-bundle plist the installer ships (`scripts/desktop-install-cloud.js` `hostAgentLabel`) and the CLI's `serviceLabelFor`: production keeps the bare. */
describe("labelForEnvironment", () => {
  it("keeps the bare ai.traycer.host id for production", () => {
    const label = labelForEnvironment("production");
    expect(label.id).toBe("ai.traycer.host");
    expect(label.appSupportDirName).toBe("Traycer");
  });

  it("nests the dev slot under ai.traycer.host.dev", () => {
    const label = labelForEnvironment("dev");
    expect(label.id).toBe("ai.traycer.host.dev");
    expect(label.appSupportDirName).toBe("Traycer-Dev");
  });

  it("uses a per-run dev service label when DEV_DESKTOP_SLOT is set", () => {
    withDevDesktopSlot("Worktree Slot", () => {
      const label = labelForEnvironment("dev");
      expect(label.id).toBe("ai.traycer.host.dev.worktree-slot");
      expect(label.displayName).toBe("Traycer Host (Dev worktree-slot)");
      expect(label.appSupportDirName).toBe("Traycer-Dev-worktree-slot");
    });
  });

  it("gives the internal staging slot its OWN ai.traycer.host.staging id (never the dev slot's)", () => {
    const label = labelForEnvironment("staging");
    expect(label.id).toBe("ai.traycer.host.staging");
    expect(label.displayName).toBe("Traycer Host (Staging)");
    expect(label.appSupportDirName).toBe("Traycer-Staging");
  });
});

describe("smAppServiceAgentLabelId", () => {
  it("derives `<cli-label>.agent`", () => {
    expect(smAppServiceAgentLabelId("ai.traycer.host")).toBe(
      "ai.traycer.host.agent",
    );
    expect(smAppServiceAgentLabelId("ai.traycer.host.staging")).toBe(
      "ai.traycer.host.staging.agent",
    );
  });

  it("stays in lockstep with the CLI's derivation for every environment", () => {
    for (const environment of ["production", "staging", "dev"]) {
      expect(
        smAppServiceAgentLabelId(labelForEnvironment(environment).id),
      ).toBe(cliSmAppServiceAgentLabelId(serviceLabelFor(environment)));
    }
  });
});
