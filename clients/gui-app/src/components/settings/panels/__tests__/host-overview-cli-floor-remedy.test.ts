import { describe, expect, it } from "vitest";
import type { CliInstallSource } from "@traycer/protocol/config/installation-records";
import {
  CLI_FLOOR_REMEDY_ACTION_KINDS,
  describeCliFloorRemedy,
  type CliFloorRemedyAction,
  type CliFloorRemedyInput,
} from "@/components/settings/panels/host-overview-cli-floor-remedy";
import type {
  DesktopAppUpdateSnapshot,
  DesktopAppUpdateStatus,
} from "@/lib/windows/types";

const PACKAGE_MANAGER_COMMANDS: Readonly<
  Record<Exclude<CliInstallSource, "desktop" | "manual">, string>
> = {
  homebrew: "brew upgrade traycer",
  npm: "npm install -g @traycerai/cli@latest",
  winget: "winget upgrade Traycer.CLI",
  scoop: "scoop update traycer-cli",
  apt: "sudo apt update && sudo apt install --only-upgrade traycer-cli",
  rpm: "sudo dnf upgrade traycer-cli",
};

const platforms: readonly (string | null)[] = [
  "linux-x64",
  "darwin-arm64",
  "win32-x64",
  null,
];

const sources: readonly (CliInstallSource | null)[] = [
  "desktop",
  "homebrew",
  "npm",
  "winget",
  "scoop",
  "apt",
  "rpm",
  "manual",
  null,
];

function expectedDesktopKind(
  status: DesktopAppUpdateStatus,
): CliFloorRemedyAction["kind"] {
  switch (status) {
    case "available":
      return "desktop-download";
    case "downloading":
      return "desktop-progress";
    case "ready":
      return "desktop-install";
    case "up-to-date":
      return "restart-desktop-hint";
    default:
      return "desktop-check";
  }
}

function snapshot(
  status: DesktopAppUpdateStatus,
  overrides: Partial<DesktopAppUpdateSnapshot>,
): DesktopAppUpdateSnapshot {
  return {
    sequence: 1,
    status,
    currentVersion: "1.2.0",
    allowPrerelease: false,
    latestVersion: "1.3.0",
    latestCompatibilityEpoch: 1,
    downloadProgress: status === "downloading" ? 42 : null,
    installBlockedReason: null,
    installGuidance: null,
    installInFlight: false,
    errorMessage: null,
    lastCheckedAt: "2026-09-06T00:00:00Z",
    lastCheckIntent: "automatic",
    ...overrides,
  };
}

function input(options: {
  source: CliInstallSource | null;
  platform: string | null;
  isLocalMachine: boolean;
  desktopUpdate: DesktopAppUpdateSnapshot | null;
  overrides: Partial<CliFloorRemedyInput>;
}): CliFloorRemedyInput {
  return {
    isLocalMachine: options.isLocalMachine,
    platform: options.platform,
    cliSource: options.source,
    cliBinaryPath: "/home/u/.local/bin/traycer",
    cliVersion: "1.2.0",
    requiredCliVersion: "1.3.0",
    desktopUpdate: options.desktopUpdate,
    hostName: "build-host",
    ...options.overrides,
  };
}

describe("describeCliFloorRemedy", () => {
  it("covers every locality/platform/source/bridge/status combination without inventing a terminal action", () => {
    const desktopStatuses: readonly DesktopAppUpdateStatus[] = [
      "available",
      "downloading",
      "ready",
      "up-to-date",
      "checking",
      "error",
      "unavailable",
      "idle",
    ];

    const cases = [true, false].flatMap((isLocalMachine) =>
      platforms.flatMap((platform) =>
        sources.flatMap((source) =>
          [false, true].flatMap((bridge) =>
            desktopStatuses.map((status) => ({
              bridge,
              isLocalMachine,
              platform,
              source,
              status,
            })),
          ),
        ),
      ),
    );

    for (const testCase of cases) {
      const result = describeCliFloorRemedy(
        input({
          source: testCase.source,
          platform: testCase.platform,
          isLocalMachine: testCase.isLocalMachine,
          desktopUpdate: testCase.bridge ? snapshot(testCase.status, {}) : null,
          overrides: {},
        }),
      );
      const kinds = result.actions.map((action) => action.kind);
      // Removing the copy-only action union and restoring an
      // open-terminal kind would violate the 1.2.0-host boundary;
      // this negative union pin must turn RED under that ablation.
      expect(kinds).not.toContain("open-terminal");

      if (testCase.source === null) {
        expect(kinds).toEqual(["help"]);
        continue;
      }
      if (
        testCase.source === "desktop" &&
        testCase.isLocalMachine &&
        testCase.bridge
      ) {
        expect(kinds).toEqual([expectedDesktopKind(testCase.status)]);
        continue;
      }
      expect(kinds).toEqual(["copy-command"]);
    }
  });

  it("has no terminal action in the public action union", () => {
    // expectTypeOf was rejected: plain Vitest erases it, so an addition could
    // stay green without a typecheck. The tuple now owns the union; adding a
    // kind must fail this runtime assertion on every normal CI test run.
    expect(CLI_FLOOR_REMEDY_ACTION_KINDS).toEqual([
      "desktop-download",
      "desktop-progress",
      "desktop-install",
      "desktop-check",
      "restart-desktop-hint",
      "copy-command",
      "help",
    ]);
    expect(CLI_FLOOR_REMEDY_ACTION_KINDS).not.toContain("open-terminal");
  });

  it("renders each package-manager command as a copy payload for local and remote hosts", () => {
    for (const source of Object.keys(PACKAGE_MANAGER_COMMANDS) as Exclude<
      CliInstallSource,
      "desktop" | "manual"
    >[]) {
      for (const isLocalMachine of [true, false]) {
        const result = describeCliFloorRemedy(
          input({
            source,
            platform: "darwin-arm64",
            isLocalMachine,
            desktopUpdate: null,
            overrides: {},
          }),
        );
        expect(result.actions).toEqual([
          {
            kind: "copy-command",
            label: "Copy command",
            command: PACKAGE_MANAGER_COMMANDS[source],
          },
        ]);
        expect(result.sentence).toContain(PACKAGE_MANAGER_COMMANDS[source]);
      }
    }
  });

  it("uses the POSIX absolute path and protects spaces, apostrophes, dollars, and backticks", () => {
    const paths = [
      ["/home/u/bin/traycer", "'/home/u/bin/traycer' cli upgrade"],
      ["/home/u/My Tools/traycer", "'/home/u/My Tools/traycer' cli upgrade"],
      [
        "/home/u/O'Reilly/$traycer`bin`/traycer",
        "'/home/u/O'\\''Reilly/$traycer`bin`/traycer' cli upgrade",
      ],
    ] as const;
    for (const [cliBinaryPath, command] of paths) {
      const result = describeCliFloorRemedy(
        input({
          source: "manual",
          platform: "darwin-arm64",
          isLocalMachine: false,
          desktopUpdate: null,
          overrides: { cliBinaryPath },
        }),
      );
      expect(result.actions[0]).toMatchObject({
        kind: "copy-command",
        command,
      });
    }
  });

  it("falls back to the bare POSIX command for relative and empty paths", () => {
    for (const cliBinaryPath of ["traycer", "", null]) {
      const result = describeCliFloorRemedy(
        input({
          source: "manual",
          platform: "linux-x64",
          isLocalMachine: false,
          desktopUpdate: null,
          overrides: { cliBinaryPath },
        }),
      );
      expect(result.actions[0]).toMatchObject({
        kind: "copy-command",
        command: "traycer cli upgrade",
      });
    }
  });

  it("uses both outside-Traycer commands for Windows and unknown platforms", () => {
    for (const platform of ["win32-x64", "win32-arm64", null]) {
      const result = describeCliFloorRemedy(
        input({
          source: "manual",
          platform,
          isLocalMachine: false,
          desktopUpdate: null,
          overrides: {},
        }),
      );
      expect(result.actions[0]).toMatchObject({
        kind: "copy-command",
        label: "Copy commands",
        command: "traycer cli upgrade\ntraycer host restart",
      });
    }
  });

  it("falls back to copy-only guidance for a local Desktop host without a bridge", () => {
    const result = describeCliFloorRemedy(
      input({
        source: "desktop",
        platform: "darwin-arm64",
        isLocalMachine: true,
        desktopUpdate: null,
        overrides: {},
      }),
    );
    expect(result.actions[0]).toMatchObject({
      kind: "copy-command",
      command: "'" + "/home/u/.local/bin/traycer" + "' cli upgrade",
    });
  });

  it("keeps the older-copy sentence when the stored CLI version already clears the floor", () => {
    const result = describeCliFloorRemedy(
      input({
        source: "manual",
        platform: "darwin-arm64",
        isLocalMachine: false,
        desktopUpdate: null,
        overrides: { cliVersion: "1.3.0" },
      }),
    );
    expect(result.sentence).toContain(
      "were updated, but the host is still using an older copy",
    );
    expect(result.sentence).toContain("Run the command again:");
  });

  it("never fabricates a missing required version in copy guidance", () => {
    const available = describeCliFloorRemedy(
      input({
        source: "desktop",
        platform: "darwin-arm64",
        isLocalMachine: true,
        desktopUpdate: snapshot("available", { latestVersion: null }),
        overrides: { requiredCliVersion: null },
      }),
    );
    // Removing describeDesktopRemedy's null-version guards would expose
    // "null"/"undefined" in these natural versionless sentences; these
    // negative text pins must turn RED under that concrete ablation.
    expect(available.sentence).toBe(
      "Update Traycer Desktop to install this host update.",
    );
    expect(available.sentence).not.toContain("undefined");
    expect(available.sentence).not.toContain("null");

    const ready = describeCliFloorRemedy(
      input({
        source: "desktop",
        platform: "darwin-arm64",
        isLocalMachine: true,
        desktopUpdate: snapshot("ready", { latestVersion: null }),
        overrides: { requiredCliVersion: null },
      }),
    );
    expect(ready.sentence).toBe(
      "Traycer Desktop is ready. Restart Traycer to finish, then this host update can install.",
    );
    expect(ready.sentence).not.toContain("undefined");
    expect(ready.sentence).not.toContain("null");
  });

  it("reports an unreadable CLI manifest through installation help", () => {
    const result = describeCliFloorRemedy(
      input({
        source: null,
        platform: "darwin-arm64",
        isLocalMachine: false,
        desktopUpdate: null,
        overrides: {},
      }),
    );
    expect(result).toEqual({
      sentence:
        "Traycer couldn't determine how its command-line tools were installed on build-host.",
      actions: [{ kind: "help", label: "Show installation help" }],
    });
  });

  it("only offers download for available Desktop updates", () => {
    const result = describeCliFloorRemedy(
      input({
        source: "desktop",
        platform: "darwin-arm64",
        isLocalMachine: true,
        desktopUpdate: snapshot("available", {}),
        overrides: {},
      }),
    );
    expect(result.actions[0]).toMatchObject({
      kind: "desktop-download",
      label: "Download update",
    });
    // Removing the status === available predicate would make a ready Desktop
    // incorrectly expose Download update and this negative pin would turn RED.
    const ready = describeCliFloorRemedy(
      input({
        source: "desktop",
        platform: "darwin-arm64",
        isLocalMachine: true,
        desktopUpdate: snapshot("ready", {}),
        overrides: {},
      }),
    );
    expect(ready.actions[0]?.kind).toBe("desktop-install");
  });

  it("only offers install for ready Desktop updates and carries blocked/guidance state", () => {
    const blocked = describeCliFloorRemedy(
      input({
        source: "desktop",
        platform: "darwin-arm64",
        isLocalMachine: true,
        desktopUpdate: snapshot("ready", {
          installBlockedReason: "Not in Applications",
        }),
        overrides: {},
      }),
    );
    expect(blocked.actions[0]).toMatchObject({
      kind: "desktop-install",
      disabled: true,
      tooltip: "Not in Applications",
      showGuidance: false,
    });
    const guided = describeCliFloorRemedy(
      input({
        source: "desktop",
        platform: "linux-x64",
        isLocalMachine: true,
        desktopUpdate: snapshot("ready", {
          installGuidance: {
            summary: "Use the package manager",
            steps: ["step"],
            command: "sudo dpkg -i traycer.deb",
            releaseUrl: "https://example.invalid/release",
          },
        }),
        overrides: {},
      }),
    );
    expect(guided.actions[0]).toMatchObject({
      kind: "desktop-install",
      label: "Finish update",
      showGuidance: true,
    });
    // Removing the status === ready predicate would make an available Desktop
    // incorrectly expose install, so this negative status pin must turn RED.
    const available = describeCliFloorRemedy(
      input({
        source: "desktop",
        platform: "linux-x64",
        isLocalMachine: true,
        desktopUpdate: snapshot("available", {}),
        overrides: {},
      }),
    );
    expect(available.actions[0]?.kind).toBe("desktop-download");

    const inFlight = describeCliFloorRemedy(
      input({
        source: "desktop",
        platform: "darwin-arm64",
        isLocalMachine: true,
        desktopUpdate: snapshot("ready", { installInFlight: true }),
        overrides: {},
      }),
    );
    expect(inFlight.actions[0]).toMatchObject({
      kind: "desktop-install",
      disabled: true,
      installInFlight: true,
    });
  });

  it("uses a restart hint only when Desktop is up to date and checks unknown states", () => {
    const current = describeCliFloorRemedy(
      input({
        source: "desktop",
        platform: "darwin-arm64",
        isLocalMachine: true,
        desktopUpdate: snapshot("up-to-date", {}),
        overrides: {},
      }),
    );
    expect(current.actions).toEqual([{ kind: "restart-desktop-hint" }]);
    for (const status of ["checking", "error", "unavailable"] as const) {
      const result = describeCliFloorRemedy(
        input({
          source: "desktop",
          platform: "darwin-arm64",
          isLocalMachine: true,
          desktopUpdate: snapshot(status, {}),
          overrides: {},
        }),
      );
      expect(result.actions).toEqual([{ kind: "desktop-check" }]);
    }
    // Removing the explicit up-to-date arm would turn a healthy Desktop state
    // into a retrying check and this negative pin would turn RED.
    expect(current.sentence).toContain("up to date");
  });
});
