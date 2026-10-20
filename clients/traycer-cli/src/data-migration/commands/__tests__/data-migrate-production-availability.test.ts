import { describe, expect, it } from "vitest";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import type { MigrationEngineDeps } from "../../engine/engine-deps";
import {
  FakeProcessProbe,
  harnessScope,
  pathExists,
  snapshotIfPresent,
  type EngineHarness,
} from "../../engine/__tests__/engine-fixtures";
import {
  DATA_ROOT_AVAILABILITY,
  unavailableMessage,
} from "../data-availability";
import type { DataCommandDeps, DataCommandIo } from "../data-command-types";
import { dataMigrate } from "../data-migrate";

class SilentIo implements DataCommandIo {
  readonly json = false;
  readonly interactive = false;
  note(): void {
    return undefined;
  }
  progress(): void {
    return undefined;
  }
  confirm(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

type Counted = {
  readonly deps: DataCommandDeps;
  readonly engineCalls: () => number;
};

/** Deps carrying the PRODUCTION availability, counting every engine construction. */
function productionDeps(harness: EngineHarness): Counted {
  let calls = 0;
  const deps: DataCommandDeps = {
    homeDir: harness.home,
    platform: "posix",
    env: {},
    availability: DATA_ROOT_AVAILABILITY,
    probe: new FakeProcessProbe(),
    engine: (): MigrationEngineDeps => {
      calls += 1;
      return harness.makeDeps({});
    },
    signal: new AbortController().signal,
    io: new SilentIo(),
  };
  return { deps, engineCalls: () => calls };
}

describe.skipIf(process.platform === "win32")(
  "traycer data migrate under the production availability",
  { timeout: 120_000 },
  () => {
    const scope = harnessScope();

    it("--dry-run still reports, says the move is unavailable, and writes nothing", async () => {
      const harness = await scope.create();
      const { deps } = productionDeps(harness);
      const before = [
        await snapshotIfPresent(harness.home),
        await snapshotIfPresent(harness.destinationParent),
      ];

      const outcome = await dataMigrate(deps, {
        to: harness.destinationRoot,
        dryRun: true,
        yes: false,
        acceptSessionImpact: null,
      });

      // A clean fixture has no blockers, so the dry run is ok; a fixture with blockers
      // would fail with the blockers outcome, which carries the same data.
      const data = outcome.status === "ok" ? outcome.data : outcome.details;
      expect(data).not.toBeNull();
      expect(data?.available).toBe(false);
      expect(outcome.text.join("\n")).toContain(unavailableMessage("migrate"));
      expect([
        await snapshotIfPresent(harness.home),
        await snapshotIfPresent(harness.destinationParent),
      ]).toEqual(before);
      expect(await pathExists(harness.bootstrapDir)).toBe(false);
      expect(await pathExists(harness.destinationRoot)).toBe(false);
    });

    it("without --dry-run is E_DATA_OPERATION_UNAVAILABLE and never reaches the engine or maintenance", async () => {
      const harness = await scope.create();
      const { deps, engineCalls } = productionDeps(harness);

      const outcome = await dataMigrate(deps, {
        to: harness.destinationRoot,
        dryRun: false,
        yes: true,
        acceptSessionImpact: null,
      });

      expect(outcome.status).toBe("error");
      if (outcome.status !== "error")
        throw new Error("expected an error outcome");
      expect(outcome.code).toBe(CLI_ERROR_CODES.DATA_OPERATION_UNAVAILABLE);
      expect(outcome.message).toBe(unavailableMessage("migrate"));
      expect(engineCalls()).toBe(0);
      expect(harness.maintenance.calls).toEqual([]);
      expect(harness.services.stopCalls).toBe(0);
      expect(await pathExists(harness.bootstrapDir)).toBe(false);
      expect(await pathExists(harness.destinationRoot)).toBe(false);
    });
  },
);
