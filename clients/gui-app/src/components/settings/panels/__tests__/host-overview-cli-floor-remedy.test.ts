import { describe, expect, it } from "vitest";
import {
  CLI_NPM_PACKAGE_NAME,
  PACKAGE_MANAGER_UPGRADE_COMMAND,
  type CliInstallSource,
} from "@traycer/protocol/config/installation-records";
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
    currentVersion: "1.3.0",
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
        if (testCase.status === "error" || testCase.status === "unavailable") {
          expect(kinds).toEqual(["desktop-check", "help"]);
        } else {
          expect(kinds).toEqual([expectedDesktopKind(testCase.status)]);
        }
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
        const command =
          source === "npm"
            ? `npm install -g ${CLI_NPM_PACKAGE_NAME}@1.3.0`
            : PACKAGE_MANAGER_COMMANDS[source];
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
            command,
          },
        ]);
        expect(result.sentence).toContain(command);
      }
    }
  });

  it("pins the shared npm package constant and stable command table", () => {
    // Mutating CLI_NPM_PACKAGE_NAME or the generic npm @latest suffix would
    // make these shared literal pins RED before remedy-specific interpolation.
    expect(CLI_NPM_PACKAGE_NAME).toBe("@traycerai/cli");
    expect(PACKAGE_MANAGER_UPGRADE_COMMAND).toEqual({
      homebrew: "brew upgrade traycer",
      npm: "npm install -g @traycerai/cli@latest",
      winget: "winget upgrade Traycer.CLI",
      scoop: "scoop update traycer-cli",
      apt: "sudo apt update && sudo apt install --only-upgrade traycer-cli",
      rpm: "sudo dnf upgrade traycer-cli",
    });
  });

  it("uses exact package-manager floors and publisher-specific prerelease guidance", () => {
    const packageManagerRows = [
      {
        source: "homebrew" as const,
        stable: "brew upgrade traycer",
        prerelease: "brew upgrade traycer",
        rc: "brew upgrade traycer",
        missing: "brew upgrade traycer",
        build: "brew upgrade traycer",
      },
      {
        source: "npm" as const,
        stable: "npm install -g @traycerai/cli@1.3.0",
        prerelease: "npm install -g @traycerai/cli@1.3.0-beta.1",
        rc: "npm install -g @traycerai/cli@1.3.0-rc.4",
        missing: "npm install -g @traycerai/cli@latest",
        build: "npm install -g @traycerai/cli@1.3.0+build.7",
      },
      {
        source: "winget" as const,
        stable: "winget upgrade Traycer.CLI",
        prerelease: null,
        rc: null,
        missing: "winget upgrade Traycer.CLI",
        build: "winget upgrade Traycer.CLI",
      },
      {
        source: "scoop" as const,
        stable: "scoop update traycer-cli",
        prerelease: null,
        rc: null,
        missing: "scoop update traycer-cli",
        build: "scoop update traycer-cli",
      },
      {
        source: "apt" as const,
        stable:
          "sudo apt update && sudo apt install --only-upgrade traycer-cli",
        prerelease: null,
        rc: null,
        missing:
          "sudo apt update && sudo apt install --only-upgrade traycer-cli",
        build: "sudo apt update && sudo apt install --only-upgrade traycer-cli",
      },
      {
        source: "rpm" as const,
        stable: "sudo dnf upgrade traycer-cli",
        prerelease: null,
        rc: null,
        missing: "sudo dnf upgrade traycer-cli",
        build: "sudo dnf upgrade traycer-cli",
      },
    ] as const;
    const floorCases = [
      { key: "stable" as const, requiredVersion: "1.3.0" },
      { key: "prerelease" as const, requiredVersion: "1.3.0-beta.1" },
      { key: "rc" as const, requiredVersion: "1.3.0-rc.4" },
      { key: "missing" as const, requiredVersion: null },
      { key: "build" as const, requiredVersion: "1.3.0+build.7" },
    ] as const;
    const cases = [true, false].flatMap((isLocalMachine) =>
      packageManagerRows.flatMap((row) =>
        floorCases.map((floorCase) => ({
          isLocalMachine,
          requiredVersion: floorCase.requiredVersion,
          row,
          floorKey: floorCase.key,
        })),
      ),
    );

    for (const testCase of cases) {
      const command = testCase.row[testCase.floorKey];
      const result = describeCliFloorRemedy(
        input({
          source: testCase.row.source,
          platform: "darwin-arm64",
          isLocalMachine: testCase.isLocalMachine,
          desktopUpdate: null,
          overrides: { requiredCliVersion: testCase.requiredVersion },
        }),
      );
      if (command === null) {
        // Removing the publisher guard would offer a command for a feed that
        // does not publish prereleases; this help-only pin must turn RED.
        expect(result.sentence).toBe(
          `Traycer CLI prereleases aren't published through ${testCase.row.source}. Install Traycer CLI ${testCase.requiredVersion} another way, then select Check now.`,
        );
        expect(result.actions).toEqual([
          { kind: "help", label: "Show installation help" },
        ]);
      } else {
        // Replacing exact npm floors with the generic latest table, or
        // disabling the Homebrew/npm prerelease exemptions, makes these
        // concrete package-manager command pins RED.
        // The npm missing-floor row additionally turns RED if only the
        // requiredVersion !== null guard is removed and @null is interpolated.
        expect(result.actions).toEqual([
          { kind: "copy-command", label: "Copy command", command },
        ]);
        expect(result.sentence).toContain(command);
      }
    }

    for (const requiredVersion of [
      "1.3.0; rm -rf /",
      "1.3.0' && echo unsafe",
      "v1.3.0",
    ]) {
      const result = describeCliFloorRemedy(
        input({
          source: "npm",
          platform: "darwin-arm64",
          isLocalMachine: true,
          desktopUpdate: null,
          overrides: { requiredCliVersion: requiredVersion },
        }),
      );
      // Removing the isValidHostVersion guard would interpolate shell text
      // into the npm command; these malformed-floor help pins must turn RED.
      expect(result.sentence).toBe(
        "Traycer couldn't verify the required command-line tools version on build-host.",
      );
      expect(result.actions).toEqual([
        { kind: "help", label: "Show installation help" },
      ]);
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
    const windowsPathCases = [
      {
        binaryPath: "C:\\Users\\x\\AppData\\Local\\Traycer\\cli\\traycer.exe",
        invocation:
          "& 'C:\\Users\\x\\AppData\\Local\\Traycer\\cli\\traycer.exe'",
      },
      {
        binaryPath: "C:\\Users\\x\\O'Brien\\Traycer\\traycer.exe",
        invocation: "& 'C:\\Users\\x\\O''Brien\\Traycer\\traycer.exe'",
      },
      {
        binaryPath: "\\\\server\\share\\Traycer\\traycer.exe",
        invocation: "& '\\\\server\\share\\Traycer\\traycer.exe'",
      },
      {
        binaryPath: "D:/Users/x/Traycer/cli/traycer.exe",
        invocation: "& 'D:/Users/x/Traycer/cli/traycer.exe'",
      },
    ] as const;
    const windowsSources = ["manual", "desktop"] as const;
    const windowsCases = windowsSources.flatMap((source) =>
      windowsPathCases.map((pathCase) => ({ source, ...pathCase })),
    );
    for (const testCase of windowsCases) {
      const result = describeCliFloorRemedy(
        input({
          source: testCase.source,
          platform: "win32-x64",
          isLocalMachine: false,
          desktopUpdate: null,
          overrides: { cliBinaryPath: testCase.binaryPath },
        }),
      );
      // E01/E02/E03/E04/E08: removing drive/UNC recognition, apostrophe
      // doubling, PowerShell's `&`, or the second recorded invocation would
      // make this exact two-line command RED.
      expect(result.actions).toEqual([
        {
          kind: "copy-command",
          label: "Copy commands",
          command: `${testCase.invocation} cli upgrade\n${testCase.invocation} host restart`,
        },
      ]);
      expect(result.sentence).toBe(
        "Run the copied commands on build-host from a PowerShell window outside Traycer on that machine (a Windows Terminal tab there, or an SSH session that opens PowerShell). Restarting briefly disconnects this host. When it reconnects, select Check now, then Update now.",
      );
    }

    const bareWindowsCases = [
      null,
      "",
      "traycer",
      "C:Users\\x\\Traycer\\traycer.exe",
      "/home/u/bin/traycer",
    ] as const;
    const bareCases = windowsSources.flatMap((source) =>
      bareWindowsCases.map((binaryPath) => ({ source, binaryPath })),
    );
    for (const testCase of bareCases) {
      const result = describeCliFloorRemedy(
        input({
          source: testCase.source,
          platform: "win32-arm64",
          isLocalMachine: false,
          desktopUpdate: null,
          overrides: { cliBinaryPath: testCase.binaryPath },
        }),
      );
      // E05: allowing relative, empty, drive-relative, or POSIX-shaped paths
      // would guess a Windows executable instead of using bare traycer.
      expect(result.actions).toEqual([
        {
          kind: "copy-command",
          label: "Copy commands",
          command: "traycer cli upgrade\ntraycer host restart",
        },
      ]);
    }

    // Unknown platform: the RECORDED PATH is the evidence. A POSIX-rooted path
    // means a POSIX host, which has no PowerShell to open and DOES need the
    // absolute path (a manual/private-slot install is exactly what is not on
    // PATH). Falsification: restoring `platform === null` to the Windows arm
    // turns this into "& '/home/u/bin/traycer'" under a PowerShell sentence.
    const unknownPlatformPosixPath = describeCliFloorRemedy(
      input({
        source: "manual",
        platform: null,
        isLocalMachine: false,
        desktopUpdate: null,
        overrides: { cliBinaryPath: "/home/u/bin/traycer" },
      }),
    );
    expect(unknownPlatformPosixPath.actions).toEqual([
      {
        kind: "copy-command",
        label: "Copy command",
        command: "'/home/u/bin/traycer' cli upgrade",
      },
    ]);
    expect(unknownPlatformPosixPath.sentence).not.toContain("PowerShell");

    // ...and a drive-rooted path means Windows, with the full Windows route.
    const unknownPlatformWindowsPath = describeCliFloorRemedy(
      input({
        source: "manual",
        platform: null,
        isLocalMachine: false,
        desktopUpdate: null,
        overrides: { cliBinaryPath: "C:\\Traycer\\cli\\traycer.exe" },
      }),
    );
    expect(unknownPlatformWindowsPath.actions).toEqual([
      {
        kind: "copy-command",
        label: "Copy commands",
        command:
          "& 'C:\\Traycer\\cli\\traycer.exe' cli upgrade\n& 'C:\\Traycer\\cli\\traycer.exe' host restart",
      },
    ]);
    expect(unknownPlatformWindowsPath.sentence).toContain("PowerShell");

    // Neither platform nor a path shaped like either: bare commands, outside
    // Traycer, and no shell named.
    for (const binaryPath of [null, "traycer"] as const) {
      const unknownEverything = describeCliFloorRemedy(
        input({
          source: "manual",
          platform: null,
          isLocalMachine: false,
          desktopUpdate: null,
          overrides: { cliBinaryPath: binaryPath },
        }),
      );
      expect(unknownEverything.actions).toEqual([
        {
          kind: "copy-command",
          label: "Copy commands",
          command: "traycer cli upgrade\ntraycer host restart",
        },
      ]);
      expect(unknownEverything.sentence).toContain("terminal outside Traycer");
      expect(unknownEverything.sentence).not.toContain("PowerShell");
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

  it("falls back when Desktop candidates are below a known CLI floor", () => {
    const candidates = [
      { version: "1.2.0", belowFloor: true },
      { version: "1.3.0-rc.3", belowFloor: true },
      { version: "1.3.0-rc.4", belowFloor: false },
      { version: "1.3.0-rc.5", belowFloor: false },
      { version: "1.3.0", belowFloor: false },
    ] as const;
    for (const status of ["available", "downloading", "ready"] as const) {
      for (const candidate of candidates) {
        const result = describeCliFloorRemedy(
          input({
            source: "desktop",
            platform: "darwin-arm64",
            isLocalMachine: true,
            desktopUpdate: snapshot(status, {
              latestVersion: candidate.version,
            }),
            overrides: { requiredCliVersion: "1.3.0-rc.4" },
          }),
        );
        if (candidate.belowFloor) {
          // Bypassing describeDesktopFloorFallback would expose a normal
          // Desktop action for this refusal; these fallback pins must turn RED
          // under the concrete D01 ablation.
          expect(result.sentence).toBe(
            `Traycer v${candidate.version} is the latest on this update channel and its command-line tools are below 1.3.0-rc.4. Open a terminal on build-host and run the copied command, then select Check now.`,
          );
          expect(result.actions).toEqual([
            {
              kind: "copy-command",
              label: "Copy command",
              command: "'/home/u/.local/bin/traycer' cli upgrade",
            },
            { kind: "help", label: "Show installation help" },
          ]);
          continue;
        }
        // Removing the comparable equal/greater floor check would make these
        // clear candidates show repair guidance; this negative candidate pin
        // must turn RED under that concrete semver-ablation.
        expect(result.actions[0]?.kind).toBe(expectedDesktopKind(status));
      }
    }
  });

  it("uses help instead of guessing a Desktop CLI command when the floor fallback lacks a safe path", () => {
    const pathCases = [
      {
        platform: "darwin-arm64",
        cliBinaryPath: "/home/u/bin/traycer",
        copy: true,
      },
      { platform: "linux-x64", cliBinaryPath: null, copy: false },
      { platform: "linux-x64", cliBinaryPath: "traycer", copy: false },
      {
        platform: "win32-x64",
        cliBinaryPath: "/home/u/bin/traycer",
        copy: false,
      },
      // A null platform routes by the recorded path's shape, as the manual
      // arm does; only a path shaped like neither stays copy-less.
      { platform: null, cliBinaryPath: "/home/u/bin/traycer", copy: true },
      {
        platform: null,
        cliBinaryPath: "C:\\Traycer\\cli\\traycer.exe",
        copy: true,
      },
      { platform: null, cliBinaryPath: "traycer", copy: false },
      { platform: null, cliBinaryPath: null, copy: false },
    ] as const;
    for (const pathCase of pathCases) {
      const result = describeCliFloorRemedy(
        input({
          source: "desktop",
          platform: pathCase.platform,
          isLocalMachine: true,
          desktopUpdate: snapshot("available", { latestVersion: "1.2.0" }),
          overrides: {
            cliBinaryPath: pathCase.cliBinaryPath,
            requiredCliVersion: "1.3.0",
          },
        }),
      );
      // Removing the platform-specific absolute-path/no-PATH-guessing guard
      // would guess a command for an unsafe case; these D06 pins must RED.
      expect(
        result.actions.some((action) => action.kind === "copy-command"),
      ).toBe(pathCase.copy);
      expect(result.actions.at(-1)).toEqual({
        kind: "help",
        label: "Show installation help",
      });
    }

    const windowsFallbackCases = [
      {
        binaryPath: "C:\\Users\\x\\AppData\\Local\\Traycer\\cli\\traycer.exe",
        command:
          "& 'C:\\Users\\x\\AppData\\Local\\Traycer\\cli\\traycer.exe' cli upgrade\n& 'C:\\Users\\x\\AppData\\Local\\Traycer\\cli\\traycer.exe' host restart",
        copy: true,
      },
      { binaryPath: null, command: null, copy: false },
      { binaryPath: "", command: null, copy: false },
      { binaryPath: "traycer", command: null, copy: false },
      {
        binaryPath: "C:Users\\x\\Traycer\\traycer.exe",
        command: null,
        copy: false,
      },
      { binaryPath: "/home/u/bin/traycer", command: null, copy: false },
    ] as const;
    for (const pathCase of windowsFallbackCases) {
      const result = describeCliFloorRemedy(
        input({
          source: "desktop",
          platform: "win32-x64",
          isLocalMachine: true,
          desktopUpdate: snapshot("available", { latestVersion: "1.2.0" }),
          overrides: {
            cliBinaryPath: pathCase.binaryPath,
            requiredCliVersion: "1.3.0",
          },
        }),
      );
      if (pathCase.copy) {
        // E07: withholding all Windows fallback commands would lose the
        // usable recorded path and make this positive pin RED.
        expect(result.actions).toEqual([
          {
            kind: "copy-command",
            label: "Copy commands",
            command: pathCase.command,
          },
          { kind: "help", label: "Show installation help" },
        ]);
        // E09: removing the PowerShell/outside wording would lose the shell
        // guidance appended to the Desktop floor sentence.
        expect(result.sentence).toContain(
          "PowerShell window outside Traycer on that machine",
        );
      } else {
        // E06: bypassing the Windows no-path gate would guess PATH for an
        // absent or non-absolute recording; this exact help-only pin must RED.
        expect(result.actions).toEqual([
          { kind: "help", label: "Show installation help" },
        ]);
      }
    }

    const upToDate = describeCliFloorRemedy(
      input({
        source: "desktop",
        platform: "darwin-arm64",
        isLocalMachine: true,
        desktopUpdate: snapshot("up-to-date", {
          currentVersion: "1.2.0",
          latestVersion: null,
        }),
        overrides: {
          requiredCliVersion: "1.3.0",
        },
      }),
    );
    // Removing the up-to-date currentVersion fallback would lose a known
    // below-floor candidate; this negative fallback pin must turn RED.
    expect(upToDate.sentence).toContain("Traycer Desktop v1.2.0 is installed");

    const installedVersionAheadOfFeed = describeCliFloorRemedy(
      input({
        source: "desktop",
        platform: "darwin-arm64",
        isLocalMachine: true,
        desktopUpdate: snapshot("up-to-date", {
          currentVersion: "1.3.0-rc.4",
          latestVersion: "1.2.0",
        }),
        overrides: { requiredCliVersion: "1.3.0-rc.4" },
      }),
    );
    // Restoring the prior candidate expression
    // `snapshot.latestVersion ?? (snapshot.status === "up-to-date" ?
    // snapshot.currentVersion : null)` would select the older feed version
    // and expose floor fallback; this feed-behind pin must turn RED while the
    // below-floor/null-latest case above remains green.
    expect(installedVersionAheadOfFeed.actions).toEqual([
      { kind: "restart-desktop-hint" },
    ]);

    for (const latestVersion of [null, "not-a-version"] as const) {
      const unknown = describeCliFloorRemedy(
        input({
          source: "desktop",
          platform: "darwin-arm64",
          isLocalMachine: true,
          desktopUpdate: snapshot("available", { latestVersion }),
          overrides: { requiredCliVersion: "1.3.0" },
        }),
      );
      // Removing the unknown-candidate fallback would fabricate a normal
      // Desktop action; these negative missing/unparseable pins must RED.
      expect(unknown.sentence).toContain(
        "couldn't verify that this Desktop update includes Traycer CLI 1.3.0 or newer",
      );
      expect(unknown.actions.at(-1)).toEqual({
        kind: "help",
        label: "Show installation help",
      });
    }
  });

  it("shows retryable Desktop failures and only auto-checks an idle updater", () => {
    const failures = [
      {
        status: "error" as const,
        errorMessage: "  Desktop updater failed.  ",
        sentence: "Desktop updater failed.",
      },
      {
        status: "unavailable" as const,
        errorMessage: null,
        sentence: "Traycer Desktop couldn't check for updates.",
      },
    ] as const;
    for (const failure of failures) {
      const result = describeCliFloorRemedy(
        input({
          source: "desktop",
          platform: "darwin-arm64",
          isLocalMachine: true,
          desktopUpdate: snapshot(failure.status, {
            errorMessage: failure.errorMessage,
          }),
          overrides: {},
        }),
      );
      expect(result.sentence).toBe(failure.sentence);
      // Mapping failures back to Checking/null-label/checkOnMount true would
      // hide recovery; this negative retry/help pin must RED under that D02
      // ablation.
      expect(result.actions).toEqual([
        {
          kind: "desktop-check",
          label: "Check again",
          checkOnMount: false,
        },
        { kind: "help", label: "Show installation help" },
      ]);
    }

    const checking = describeCliFloorRemedy(
      input({
        source: "desktop",
        platform: "darwin-arm64",
        isLocalMachine: true,
        desktopUpdate: snapshot("checking", {}),
        overrides: {},
      }),
    );
    expect(checking.sentence).toBe("Checking for a Traycer Desktop update…");
    expect(checking.actions).toEqual([
      { kind: "desktop-check", label: null, checkOnMount: false },
    ]);
    const idle = describeCliFloorRemedy(
      input({
        source: "desktop",
        platform: "darwin-arm64",
        isLocalMachine: true,
        desktopUpdate: snapshot("idle", {}),
        overrides: {},
      }),
    );
    // Changing idle's sentence back to Checking would claim work is in
    // flight before the initial check starts; this copy pin must turn RED.
    expect(idle.sentence).toBe("Check for a Traycer Desktop update.");
    expect(idle.actions).toEqual([
      { kind: "desktop-check", label: null, checkOnMount: true },
    ]);
  });

  it("uses a restart hint only when Desktop is up to date and checks unknown states", () => {
    const current = describeCliFloorRemedy(
      input({
        source: "desktop",
        platform: "darwin-arm64",
        isLocalMachine: true,
        desktopUpdate: snapshot("up-to-date", {
          currentVersion: "1.3.0",
        }),
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
      if (status === "checking") {
        expect(result.actions).toEqual([
          { kind: "desktop-check", label: null, checkOnMount: false },
        ]);
      } else {
        expect(result.actions).toEqual([
          {
            kind: "desktop-check",
            label: "Check again",
            checkOnMount: false,
          },
          { kind: "help", label: "Show installation help" },
        ]);
      }
    }
    // Removing the explicit up-to-date arm would turn a healthy Desktop state
    // into a retrying check and this negative pin would turn RED.
    expect(current.sentence).toContain("up to date");
  });
});
