import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATION_COORDINATOR_LOCK_FILENAME } from "@traycer/protocol/config/data-migration-admission";
import { currentComponentHandshake } from "@traycer/protocol/config/data-migration-contracts";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import {
  FakeProcessProbe,
  harnessScope,
  pathExists,
  readLocation,
  snapshotIfPresent,
  type EngineHarness,
} from "../../engine/__tests__/engine-fixtures";
import {
  DATA_ROOT_AVAILABILITY,
  type DataRootAvailability,
} from "../data-availability";
import type {
  DataCommandDeps,
  DataCommandIo,
  DataCommandOutcome,
} from "../data-command-types";
import { dataInit } from "../data-init";

const ENABLED: DataRootAvailability = {
  win32: { init: true, migrate: true },
  posix: { init: true, migrate: true },
};

class ScriptedIo implements DataCommandIo {
  readonly json = false;
  readonly notes: string[] = [];
  readonly questions: string[] = [];
  constructor(
    readonly interactive: boolean,
    private readonly answers: boolean[],
  ) {}
  note(text: string): void {
    this.notes.push(text);
  }
  progress(): void {
    return undefined;
  }
  confirm(question: string): Promise<boolean> {
    this.questions.push(question);
    return Promise.resolve(this.answers.shift() ?? false);
  }
}

type Overrides = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly availability: DataRootAvailability;
  readonly probe: FakeProcessProbe;
  readonly io: ScriptedIo;
};

function depsFor(
  harness: EngineHarness,
  overrides: Overrides,
): DataCommandDeps {
  return {
    homeDir: harness.home,
    platform: "posix",
    env: overrides.env,
    availability: overrides.availability,
    probe: overrides.probe,
    engine: () => harness.makeDeps({ probe: overrides.probe }),
    signal: new AbortController().signal,
    io: overrides.io,
  };
}

function enabled(
  harness: EngineHarness,
  env: Readonly<Record<string, string | undefined>>,
): DataCommandDeps {
  return depsFor(harness, {
    env,
    availability: ENABLED,
    probe: harness.probe,
    io: new ScriptedIo(false, []),
  });
}

/** A fresh installation: no default data folder yet. */
async function emptyHome(harness: EngineHarness): Promise<void> {
  await rm(harness.sourceRoot, { recursive: true, force: true });
}

function errorOf(
  outcome: DataCommandOutcome,
): Extract<DataCommandOutcome, { status: "error" }> {
  if (outcome.status !== "error") throw new Error("expected an error outcome");
  return outcome;
}

function okDataOf(outcome: DataCommandOutcome): Record<string, unknown> {
  if (outcome.status !== "ok")
    throw new Error(`expected ok, got ${outcome.code}: ${outcome.message}`);
  return outcome.data;
}

describe.skipIf(process.platform === "win32")(
  "traycer data init",
  { timeout: 120_000 },
  () => {
    const scope = harnessScope();

    describe("lock refusals", () => {
      class NoIdentityProbe extends FakeProcessProbe {
        override ownStartIdentity(): Promise<string | null> {
          return Promise.resolve(null);
        }
      }

      it("data init names each lock refusal reason", async () => {
        const corrupt = await scope.create();
        await emptyHome(corrupt);
        await mkdir(corrupt.bootstrapDir, { recursive: true, mode: 0o700 });
        await writeFile(
          join(corrupt.bootstrapDir, MIGRATION_COORDINATOR_LOCK_FILENAME),
          "{ torn",
          { mode: 0o600 },
        );
        const corruptOutcome = errorOf(
          await dataInit(
            enabled(corrupt, { TRAYCER_DATA_DIR: corrupt.destinationRoot }),
            { to: null, yes: true },
          ),
        );
        expect(corruptOutcome.message).toContain(
          "never taken over automatically",
        );
        expect(corruptOutcome.details?.lock).toBe("corrupt");
        expect(await pathExists(corrupt.destinationRoot)).toBe(false);

        const unreadable = await scope.create();
        await emptyHome(unreadable);
        const identityOutcome = errorOf(
          await dataInit(
            depsFor(unreadable, {
              env: { TRAYCER_DATA_DIR: unreadable.destinationRoot },
              availability: ENABLED,
              probe: new NoIdentityProbe(),
              io: new ScriptedIo(false, []),
            }),
            { to: null, yes: true },
          ),
        );
        expect(identityOutcome.message).toContain(
          "cannot read its own process identity",
        );
        expect(identityOutcome.details?.lock).toBe("identity-unavailable");
        expect(await pathExists(unreadable.destinationRoot)).toBe(false);
      });
    });

    describe("choosing the folder", () => {
      it("--to wins over TRAYCER_DATA_DIR", async () => {
        const harness = await scope.create();
        await emptyHome(harness);
        const other = join(harness.destinationParent, "from-env");
        const outcome = await dataInit(
          enabled(harness, { TRAYCER_DATA_DIR: other }),
          { to: harness.destinationRoot, yes: true },
        );
        const data = okDataOf(outcome);
        expect(data.root).toBe(harness.destinationRoot);
        expect(data.source).toBe("flag");
        expect(readLocation(harness.bootstrapDir)?.root).toBe(
          harness.destinationRoot,
        );
        expect(await pathExists(other)).toBe(false);
      });

      it("uses TRAYCER_DATA_DIR when there is no --to", async () => {
        const harness = await scope.create();
        await emptyHome(harness);
        const outcome = await dataInit(
          enabled(harness, { TRAYCER_DATA_DIR: harness.destinationRoot }),
          { to: null, yes: true },
        );
        const data = okDataOf(outcome);
        expect(data.root).toBe(harness.destinationRoot);
        expect(data.source).toBe("environment");
        expect(readLocation(harness.bootstrapDir)?.root).toBe(
          harness.destinationRoot,
        );
      });

      it("gives E_INVALID_ARGUMENT when neither names a folder", async () => {
        const harness = await scope.create();
        await emptyHome(harness);
        const outcome = errorOf(
          await dataInit(enabled(harness, {}), { to: null, yes: true }),
        );
        expect(outcome.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
        expect(await pathExists(harness.bootstrapDir)).toBe(false);
        expect(await pathExists(harness.destinationRoot)).toBe(false);
      });
    });

    it("is unavailable under the production availability and creates nothing", async () => {
      const harness = await scope.create();
      await emptyHome(harness);
      const deps = depsFor(harness, {
        env: {},
        availability: DATA_ROOT_AVAILABILITY,
        probe: harness.probe,
        io: new ScriptedIo(false, []),
      });
      const outcome = errorOf(
        await dataInit(deps, { to: harness.destinationRoot, yes: true }),
      );
      expect(outcome.code).toBe(CLI_ERROR_CODES.DATA_OPERATION_UNAVAILABLE);
      expect(await pathExists(harness.bootstrapDir)).toBe(false);
      expect(await pathExists(harness.destinationRoot)).toBe(false);
    });

    it("with --yes on an empty home writes location generation 1 with no migration id and creates the destination", async () => {
      const harness = await scope.create();
      await emptyHome(harness);
      const outcome = await dataInit(enabled(harness, {}), {
        to: harness.destinationRoot,
        yes: true,
      });
      expect(okDataOf(outcome)).toMatchObject({
        root: harness.destinationRoot,
        created: true,
      });
      expect(readLocation(harness.bootstrapDir)).toEqual({
        version: 1,
        generation: 1,
        root: harness.destinationRoot,
        migrationId: null,
      });
      expect(await pathExists(harness.destinationRoot)).toBe(true);
      expect(harness.gate().kind).toBe("open");
    });

    it("asks at the prompt when interactive without --yes, and a no changes nothing", async () => {
      const harness = await scope.create();
      await emptyHome(harness);
      const declined = new ScriptedIo(true, [false]);
      const refusal = errorOf(
        await dataInit(
          depsFor(harness, {
            env: {},
            availability: ENABLED,
            probe: harness.probe,
            io: declined,
          }),
          {
            to: harness.destinationRoot,
            yes: false,
          },
        ),
      );
      expect(refusal.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
      expect(declined.questions).toHaveLength(1);
      expect(declined.questions[0]).toContain(harness.destinationRoot);
      expect(readLocation(harness.bootstrapDir)).toBeNull();
      expect(await pathExists(harness.destinationRoot)).toBe(false);

      const accepted = new ScriptedIo(true, [true]);
      const outcome = await dataInit(
        depsFor(harness, {
          env: {},
          availability: ENABLED,
          probe: harness.probe,
          io: accepted,
        }),
        {
          to: harness.destinationRoot,
          yes: false,
        },
      );
      expect(okDataOf(outcome).root).toBe(harness.destinationRoot);
      expect(readLocation(harness.bootstrapDir)?.generation).toBe(1);
    });

    describe("refusals write nothing", () => {
      it("refuses a populated default ~/.traycer", async () => {
        const harness = await scope.create();
        const homeBefore = await snapshotIfPresent(harness.home);
        const outcome = errorOf(
          await dataInit(enabled(harness, {}), {
            to: harness.destinationRoot,
            yes: true,
          }),
        );
        expect(outcome.code).toBe(CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED);
        expect(outcome.message).toContain("already installed");
        expect(await pathExists(harness.bootstrapDir)).toBe(false);
        expect(await pathExists(harness.destinationRoot)).toBe(false);
        expect(await snapshotIfPresent(harness.home)).toEqual(homeBefore);
      });

      it("refuses when a location record already exists", async () => {
        const harness = await scope.create();
        await emptyHome(harness);
        okDataOf(
          await dataInit(enabled(harness, {}), {
            to: harness.destinationRoot,
            yes: true,
          }),
        );
        const locationBefore = readLocation(harness.bootstrapDir);
        const second = join(harness.destinationParent, "second");

        const outcome = errorOf(
          await dataInit(enabled(harness, {}), { to: second, yes: true }),
        );

        expect(outcome.code).toBe(CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED);
        expect(outcome.message).toContain("already set");
        expect(readLocation(harness.bootstrapDir)).toEqual(locationBefore);
        expect(await pathExists(second)).toBe(false);
      });

      it("refuses while a live Traycer process is admitted", async () => {
        const harness = await scope.create();
        await emptyHome(harness);
        const probe = new FakeProcessProbe();
        const pid = process.pid + 1;
        probe.alive.add(pid);
        await harness.writeAdmissionEntry({
          pid,
          dataMigrationProtocol: currentComponentHandshake("desktop", "test")
            .dataMigrationProtocol,
        });

        const deps = depsFor(harness, {
          env: {},
          availability: ENABLED,
          probe,
          io: new ScriptedIo(false, []),
        });
        const outcome = errorOf(
          await dataInit(deps, { to: harness.destinationRoot, yes: true }),
        );

        expect(outcome.code).toBe(CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED);
        expect(outcome.message).toContain("Traycer is running");
        expect(readLocation(harness.bootstrapDir)).toBeNull();
        expect(await pathExists(harness.destinationRoot)).toBe(false);
      });

      it("refuses without --yes when there is no prompt", async () => {
        const harness = await scope.create();
        await emptyHome(harness);
        const outcome = errorOf(
          await dataInit(enabled(harness, {}), {
            to: harness.destinationRoot,
            yes: false,
          }),
        );
        expect(outcome.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
        expect(outcome.message).toContain("--yes");
        expect(await pathExists(harness.bootstrapDir)).toBe(false);
        expect(await pathExists(harness.destinationRoot)).toBe(false);
      });
    });
  },
);
