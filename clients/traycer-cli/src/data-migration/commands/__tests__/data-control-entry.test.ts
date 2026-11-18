import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommanderError } from "commander";
import { dataRootPlatformOf } from "@traycer/protocol/config/data-root";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import type { MigrationEngineDeps } from "../../engine/engine-deps";
import {
  FakeProcessProbe,
  harnessScope,
  pathExists,
  type EngineHarness,
} from "../../engine/__tests__/engine-fixtures";
import type { DataRootAvailability } from "../data-availability";
import type {
  DataCommandDeps,
  DataCommandIo,
  DataCommandOutcome,
} from "../data-command-types";
import {
  buildDataProgram,
  selectsDataControlCommand,
} from "../data-control-entry";

const ENABLED: DataRootAvailability = {
  win32: { init: true, migrate: true },
  posix: { init: true, migrate: true },
};

class SilentIo implements DataCommandIo {
  // json true keeps Commander's own output off the real stdout/stderr.
  readonly json = true;
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

type Harnessed = {
  readonly deps: DataCommandDeps;
  readonly engineCalls: () => number;
};

function depsFor(harness: EngineHarness): Harnessed {
  let calls = 0;
  const deps: DataCommandDeps = {
    homeDir: harness.home,
    platform: dataRootPlatformOf(process.platform),
    env: {},
    availability: ENABLED,
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

async function run(
  harness: EngineHarness,
  args: readonly string[],
): Promise<{ outcomes: DataCommandOutcome[]; engineCalls: number }> {
  const { deps, engineCalls } = depsFor(harness);
  const outcomes: DataCommandOutcome[] = [];
  const program = buildDataProgram(
    deps,
    (outcome) => {
      outcomes.push(outcome);
    },
    () => undefined,
  );
  await program.parseAsync(["node", "traycer", "data", ...args]);
  return { outcomes, engineCalls: engineCalls() };
}

function errorCode(outcome: DataCommandOutcome | undefined): string {
  if (outcome === undefined) throw new Error("the command settled nothing");
  if (outcome.status !== "error") throw new Error("expected an error outcome");
  return outcome.code;
}

describe("selectsDataControlCommand", () => {
  it("selects argv whose command is data", () => {
    expect(
      selectsDataControlCommand(["node", "traycer", "data", "status"]),
    ).toBe(true);
  });

  it("skips leading no-op flags before data", () => {
    expect(
      selectsDataControlCommand([
        "node",
        "traycer",
        "--json",
        "data",
        "status",
      ]),
    ).toBe(true);
    expect(
      selectsDataControlCommand([
        "node",
        "traycer",
        "--quiet",
        "--no-progress",
        "data",
      ]),
    ).toBe(true);
  });

  it("does not select other commands or flags", () => {
    expect(
      selectsDataControlCommand(["node", "traycer", "host", "status"]),
    ).toBe(false);
    expect(selectsDataControlCommand(["node", "traycer", "--version"])).toBe(
      false,
    );
    expect(selectsDataControlCommand(["node", "traycer"])).toBe(false);
  });

  it("does not select data when it is not the command", () => {
    expect(
      selectsDataControlCommand(["node", "traycer", "agent", "data"]),
    ).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")(
  "buildDataProgram",
  { timeout: 120_000 },
  () => {
    const scope = harnessScope();
    let savedSurface: string | undefined;

    beforeEach(() => {
      savedSurface = process.env.TRAYCER_AGENT_CLI_SURFACE;
      delete process.env.TRAYCER_AGENT_CLI_SURFACE;
    });

    afterEach(() => {
      if (savedSurface === undefined)
        delete process.env.TRAYCER_AGENT_CLI_SURFACE;
      else process.env.TRAYCER_AGENT_CLI_SURFACE = savedSurface;
    });

    it("refuses an unknown data subcommand with a CommanderError and settles nothing", async () => {
      const harness = await scope.create();
      const { deps, engineCalls } = depsFor(harness);
      const outcomes: DataCommandOutcome[] = [];
      const program = buildDataProgram(
        deps,
        (outcome) => {
          outcomes.push(outcome);
        },
        () => undefined,
      );
      await expect(
        program.parseAsync(["node", "traycer", "data", "foo"]),
      ).rejects.toBeInstanceOf(CommanderError);
      expect(outcomes).toEqual([]);
      expect(engineCalls()).toBe(0);
    });

    it("gives E_INVALID_ARGUMENT for a malformed --accept-session-impact value", async () => {
      const harness = await scope.create();
      const migrate = await run(harness, [
        "migrate",
        "--to",
        harness.destinationRoot,
        "--yes",
        "--accept-session-impact",
        "not-a-digest",
      ]);
      expect(migrate.outcomes).toHaveLength(1);
      expect(errorCode(migrate.outcomes[0])).toBe(
        CLI_ERROR_CODES.INVALID_ARGUMENT,
      );
      expect(migrate.engineCalls).toBe(0);

      const recover = await run(harness, [
        "recover",
        "--yes",
        "--accept-session-impact",
        "sha256:short",
      ]);
      expect(errorCode(recover.outcomes[0])).toBe(
        CLI_ERROR_CODES.INVALID_ARGUMENT,
      );
      expect(recover.engineCalls).toBe(0);
    });

    describe("read-only agent surface", () => {
      beforeEach(() => {
        process.env.TRAYCER_AGENT_CLI_SURFACE = "readonly";
      });

      it("settles E_FORBIDDEN for init, migrate, recover and cleanup without calling the engine", async () => {
        const harness = await scope.create();
        const invocations: readonly (readonly string[])[] = [
          ["init", "--to", harness.destinationRoot, "--yes"],
          ["migrate", "--to", harness.destinationRoot, "--yes"],
          ["recover", "--yes"],
          ["recover", "--rollback", "--yes"],
          ["cleanup", "m-00000000-0000-4000-8000-0000000000aa", "--yes"],
        ];
        for (const args of invocations) {
          const result = await run(harness, args);
          expect(result.outcomes, args.join(" ")).toHaveLength(1);
          expect(errorCode(result.outcomes[0]), args.join(" ")).toBe(
            CLI_ERROR_CODES.FORBIDDEN,
          );
          expect(result.engineCalls, args.join(" ")).toBe(0);
        }
        expect(await pathExists(harness.destinationRoot)).toBe(false);
        expect(await pathExists(harness.bootstrapDir)).toBe(false);
      });

      it("still runs data status", async () => {
        const harness = await scope.create();
        const result = await run(harness, ["status"]);
        expect(result.outcomes).toHaveLength(1);
        expect(result.outcomes[0]?.status).toBe("ok");
      });

      it("still runs migrate --dry-run", async () => {
        const harness = await scope.create();
        const result = await run(harness, [
          "migrate",
          "--dry-run",
          "--to",
          harness.destinationRoot,
        ]);
        expect(result.outcomes).toHaveLength(1);
        expect(result.outcomes[0]?.status).toBe("ok");
        expect(result.engineCalls).toBe(1);
        expect(await pathExists(harness.destinationRoot)).toBe(false);
      });
    });
  },
);
