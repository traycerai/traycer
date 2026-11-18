import { createRequire } from "node:module";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  serviceLabelFor,
  smAppServiceAgentLabelId,
  windowsTaskName,
} from "../label";
import { cliHomeDir, hostHomeDir } from "../../store/paths";
import type { Environment } from "../../runner/environment";
import { withDevDesktopSlot } from "@traycer-clients/shared/test-fixtures/dev-desktop-slot";

describe("serviceLabelFor", () => {
  it("uses the production service label for production", () => {
    const label = serviceLabelFor("production");

    expect(label).toEqual({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment: "production",
      devSlot: null,
    });
    expect(windowsTaskName(label)).toBe("\\Traycer\\Host");
  });

  it("gives the dev environment its own service slot", () => {
    const label = serviceLabelFor("dev");

    expect(label).toEqual({
      id: "ai.traycer.host.dev",
      displayName: "Traycer Host (Dev)",
      environment: "dev",
      devSlot: null,
    });
    expect(windowsTaskName(label)).toBe("\\Traycer\\Host-Dev");
  });

  it("uses a slot-specific label for dev-desktop runs", () => {
    withDevDesktopSlot("Worktree Slot", () => {
      const label = serviceLabelFor("dev");

      expect(label).toEqual({
        id: "ai.traycer.host.dev.worktree-slot",
        displayName: "Traycer Host (Dev worktree-slot)",
        environment: "dev",
        devSlot: "worktree-slot",
      });
      expect(windowsTaskName(label)).toBe("\\Traycer\\Host-Dev-Worktree-slot");
    });
  });

  it("gives each non-production environment its own isolated slot", () => {
    const label = serviceLabelFor("staging");

    expect(label).toEqual({
      id: "ai.traycer.host.staging",
      displayName: "Traycer Host (Staging)",
      environment: "staging",
      devSlot: null,
    });
    expect(windowsTaskName(label)).toBe("\\Traycer\\Host-Staging");
  });
});

// The release stamp carries `serviceLabelId` / `windowsTaskName` so the
// packaging path can name the CLI's OS-service registration without importing
// this module - the NSIS uninstaller stops and deletes the task by that name.
// The CLI never reads them back: it derives its own from `config.environment`
// through the two functions above. So the stamp's copies are a DUPLICATE of
// this derivation, and a divergence is silent - the uninstaller acts on a task
// that was never registered while the real one keeps restarting the host.
//
// `release-target-stamp.cjs` pins the values rather than computing them,
// because it is CommonJS build tooling that cannot import this TypeScript.
// This is the one place both halves are reachable at once, so this is where
// the duplication is held to account: change either side alone and this
// reddens. Required by `createRequire` rather than imported, the same way
// `clients/desktop/scripts/__tests__/release-target-stamp.test.ts` reaches it,
// so no package dependency is implied by the assertion.
describe("the release stamp's install identity matches what the CLI registers", () => {
  const requireCjs = createRequire(import.meta.url);
  const { REQUIRED_INSTALL_IDENTITY, requiredLaunchAgentLabel } = requireCjs(
    "../../../../scripts/release-target-stamp.cjs",
  ) as {
    readonly REQUIRED_INSTALL_IDENTITY: Record<
      string,
      {
        readonly serviceLabelId: string;
        readonly windowsTaskName: string;
        readonly cliInstallRoot: string;
        readonly hostInstallRoot: string;
      }
    >;
    readonly requiredLaunchAgentLabel: (target: string) => string;
  };

  // The stamp stores install roots home-RELATIVE (`~/.traycer/...`) while the
  // CLI derives absolute ones; compare on the stamp's spelling rather than
  // reimplementing `environmentSubdir` here, which would pin this test to a
  // copy of the logic instead of to the logic.
  function asHomeRelative(absolute: string): string {
    return absolute.startsWith(homedir())
      ? `~${absolute.slice(homedir().length)}`
      : absolute;
  }

  // Driven off the table's own keys so a target added there without a
  // derivation check here cannot slip through as an untested row.
  const targets: readonly Environment[] = ["production", "staging"];

  it("covers exactly the shipped release targets", () => {
    expect(Object.keys(REQUIRED_INSTALL_IDENTITY).sort()).toEqual(
      [...targets].sort(),
    );
  });

  for (const target of targets) {
    it(`derives every ${target} install-identity field the stamp pins`, () => {
      const label = serviceLabelFor(target);

      // `toEqual` on the whole row, not field-by-field `toBe`: a pin ADDED to
      // the table without a derivation here would pass every individual
      // assertion and leave the new field unchecked.
      expect({
        serviceLabelId: label.id,
        windowsTaskName: windowsTaskName(label),
        cliInstallRoot: asHomeRelative(cliHomeDir(target)),
        hostInstallRoot: asHomeRelative(hostHomeDir(target)),
      }).toEqual(REQUIRED_INSTALL_IDENTITY[target]);
    });

    it(`derives the ${target} LaunchAgent label the desktop asks SMAppService for`, () => {
      // The desktop computes `smAppServiceAgentLabelId(labelForEnvironment(env).id)`
      // and SMAppService resolves the in-bundle plist by that exact filename;
      // the stamp validator derives the same string from its own table. Both
      // spell the `.agent` suffix in their own package, so this is the only
      // place the two can be compared.
      expect(smAppServiceAgentLabelId(serviceLabelFor(target))).toBe(
        requiredLaunchAgentLabel(target),
      );
    });
  }
});
