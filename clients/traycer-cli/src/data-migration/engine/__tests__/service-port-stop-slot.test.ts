import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { traycerDataRoot } from "@traycer/protocol/config/data-root";
import {
  updateAttemptLockPath,
  updateAttemptRecordPath,
} from "@traycer/protocol/config/host-update-attempt-paths";
import type { HostUpdateAttemptRecord } from "@traycer-clients/shared/host-update";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CompetingRegistrationRetirement,
  DesktopRegistrationTakeover,
  InstallServiceOptions,
  RestartStop,
  ServiceController,
  ServiceStatus,
  StopServiceOptions,
  UninstallServiceOptions,
} from "../../../service";
import type { ServiceLabel } from "../../../service/label";
import { DEV_DESKTOP_SLOT_ENV } from "../../../store/dev-desktop-slot";
import { cliLockPath } from "../../../store/paths";
import { labelHostHomeDir, posixServiceRelocationPort } from "../service-port";

/**
 * Review P1: stopping a host must use the LABEL's slot for every lock and
 * record it touches, never the slot of the coordinator process
 * (`DEV_DESKTOP_SLOT`). The coordinator here runs as slot "other" and stops
 * the unslotted dev host.
 */

const UNSLOTTED_DEV: ServiceLabel = {
  id: "ai.traycer.host.dev",
  displayName: "Traycer Host (Dev)",
  environment: "dev",
  devSlot: null,
};

const PRODUCTION: ServiceLabel = {
  id: "ai.traycer.host",
  displayName: "Traycer Host",
  environment: "production",
  devSlot: null,
};

const STAGING: ServiceLabel = {
  id: "ai.traycer.host.staging",
  displayName: "Traycer Host (Staging)",
  environment: "staging",
  devSlot: null,
};

const SLOT_S: ServiceLabel = {
  id: "ai.traycer.host.dev.s",
  displayName: "Traycer Host (Dev s)",
  environment: "dev",
  devSlot: "s",
};

const NOT_RUNNING: ServiceStatus = {
  state: "stopped",
  version: null,
  listenUrl: null,
  pid: null,
};

const RUNNING: ServiceStatus = {
  state: "running",
  version: null,
  listenUrl: null,
  pid: null,
};

interface StopObservation {
  readonly labelId: string;
  readonly force: boolean;
  readonly slotEnv: string | undefined;
  readonly hostDevLockExists: boolean;
  readonly hostOtherLockExists: boolean;
  readonly cliDevLockExists: boolean;
  readonly cliOtherLockExists: boolean;
}

function unexpectedCall(name: string): Promise<never> {
  return Promise.reject(new Error(`unexpected controller call: ${name}`));
}

/** Only `status` and `stop` are real; every other method rejects. */
class FakeServiceController implements ServiceController {
  readonly stops: StopObservation[] = [];

  constructor(
    private readonly observe: (
      label: ServiceLabel,
      options: StopServiceOptions,
    ) => StopObservation,
  ) {}

  status(label: ServiceLabel): Promise<ServiceStatus> {
    const unslottedDev = label.environment === "dev" && label.devSlot === null;
    return Promise.resolve(unslottedDev ? RUNNING : NOT_RUNNING);
  }

  stop(label: ServiceLabel, options: StopServiceOptions): Promise<void> {
    this.stops.push(this.observe(label, options));
    return Promise.resolve();
  }

  install(_options: InstallServiceOptions): Promise<void> {
    return unexpectedCall("install");
  }

  uninstall(_options: UninstallServiceOptions): Promise<void> {
    return unexpectedCall("uninstall");
  }

  start(_label: ServiceLabel): Promise<void> {
    return unexpectedCall("start");
  }

  restart(_label: ServiceLabel): Promise<void> {
    return unexpectedCall("restart");
  }

  hostStartAdoptionLabel(_label: ServiceLabel): Promise<string> {
    return unexpectedCall("hostStartAdoptionLabel");
  }

  stopForRestart(
    _label: ServiceLabel,
    _options: StopServiceOptions,
  ): Promise<RestartStop> {
    return unexpectedCall("stopForRestart");
  }

  relaunchAfterRestart(
    _label: ServiceLabel,
    _stop: RestartStop,
  ): Promise<void> {
    return unexpectedCall("relaunchAfterRestart");
  }

  takeoverDesktopRegistration(
    _label: ServiceLabel,
  ): Promise<DesktopRegistrationTakeover> {
    return unexpectedCall("takeoverDesktopRegistration");
  }

  retireCompetingRegistration(
    _label: ServiceLabel,
  ): Promise<CompetingRegistrationRetirement> {
    return unexpectedCall("retireCompetingRegistration");
  }
}

function setSlotEnv(slot: string | undefined): void {
  if (slot === undefined)
    Reflect.deleteProperty(process.env, DEV_DESKTOP_SLOT_ENV);
  else process.env[DEV_DESKTOP_SLOT_ENV] = slot;
}

/** Runs `read` as a process whose `DEV_DESKTOP_SLOT` is `slot`, then restores. */
function withSlotEnv<T>(slot: string | undefined, read: () => T): T {
  const prior = process.env[DEV_DESKTOP_SLOT_ENV];
  setSlotEnv(slot);
  try {
    return read();
  } finally {
    setSlotEnv(prior);
  }
}

function attemptRecord(): HostUpdateAttemptRecord {
  return {
    schemaVersion: 2,
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    trigger: "manual",
    targetVersion: "2.0.0",
    phase: "waiting-to-activate",
    execution: "parked",
    continuation: "activate",
    progress: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
  };
}

describe("posixServiceRelocationPort.stopRunningHosts slot handling", () => {
  let base = "";
  let root = "";
  let destinationRoot = "";
  let priorHome: string | undefined;
  let priorUserProfile: string | undefined;
  let priorSlot: string | undefined;

  let hostDevDir = "";
  let hostOtherDir = "";
  let cliDevLock = "";
  let cliOtherLock = "";

  beforeEach(async () => {
    priorHome = process.env.HOME;
    priorUserProfile = process.env.USERPROFILE;
    priorSlot = process.env[DEV_DESKTOP_SLOT_ENV];

    base = await realpath(await mkdtemp(join(tmpdir(), "traycer-stop-slot-")));
    process.env.HOME = base;
    process.env.USERPROFILE = base;
    setSlotEnv(undefined);

    root = traycerDataRoot();
    destinationRoot = join(base, "destination");
    hostDevDir = join(root, "host", "dev");
    hostOtherDir = join(root, "host", "dev-runs", "other");
    await mkdir(hostDevDir, { recursive: true });
    await mkdir(hostOtherDir, { recursive: true });
    await mkdir(destinationRoot, { recursive: true });

    // The CLI lock path follows DEV_DESKTOP_SLOT at call time.
    cliDevLock = withSlotEnv(undefined, () => cliLockPath("dev"));
    cliOtherLock = withSlotEnv("other", () => cliLockPath("dev"));
  });

  afterEach(async () => {
    if (priorHome === undefined) Reflect.deleteProperty(process.env, "HOME");
    else process.env.HOME = priorHome;
    if (priorUserProfile === undefined)
      Reflect.deleteProperty(process.env, "USERPROFILE");
    else process.env.USERPROFILE = priorUserProfile;
    setSlotEnv(priorSlot);
    await rm(base, { recursive: true, force: true });
  });

  function newController(): FakeServiceController {
    return new FakeServiceController((label, options) => ({
      labelId: label.id,
      force: options.force,
      slotEnv: process.env[DEV_DESKTOP_SLOT_ENV],
      hostDevLockExists: existsSync(updateAttemptLockPath(hostDevDir)),
      hostOtherLockExists: existsSync(updateAttemptLockPath(hostOtherDir)),
      cliDevLockExists: existsSync(cliDevLock),
      cliOtherLockExists: existsSync(cliOtherLock),
    }));
  }

  function portFor(controller: FakeServiceController) {
    return posixServiceRelocationPort({
      controller,
      manifestPathFor: () => "/nonexistent",
    });
  }

  it("stops the unslotted dev host under host/dev and cli/dev locks when the coordinator runs as slot 'other'", async () => {
    setSlotEnv("other");
    const controller = newController();

    const blockers = await portFor(controller).stopRunningHosts({
      sourceRoot: root,
      destinationRoot,
    });

    expect(blockers).toEqual([]);
    expect(controller.stops).toEqual([
      {
        labelId: UNSLOTTED_DEV.id,
        force: false,
        slotEnv: undefined,
        hostDevLockExists: true,
        hostOtherLockExists: false,
        cliDevLockExists: true,
        cliOtherLockExists: false,
      },
    ]);
    expect(process.env[DEV_DESKTOP_SLOT_ENV]).toBe("other");
  });

  it("reads the attempt record of the label's host home, not the coordinator's slot", async () => {
    setSlotEnv("other");

    // (a) A non-terminal record in host/dev refuses the stop of the dev host.
    const refused = newController();
    await writeFile(
      updateAttemptRecordPath(hostDevDir),
      JSON.stringify(attemptRecord()),
    );

    const refusals = await portFor(refused).stopRunningHosts({
      sourceRoot: root,
      destinationRoot,
    });

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      code: "host-stop-refused",
      object: UNSLOTTED_DEV.id,
    });
    expect(refused.stops).toEqual([]);
    expect(process.env[DEV_DESKTOP_SLOT_ENV]).toBe("other");

    // (b) The same record only under dev-runs/other is not the dev host's.
    await rm(updateAttemptRecordPath(hostDevDir), { force: true });
    await writeFile(
      updateAttemptRecordPath(hostOtherDir),
      JSON.stringify(attemptRecord()),
    );
    const admitted = newController();

    const admissions = await portFor(admitted).stopRunningHosts({
      sourceRoot: root,
      destinationRoot,
    });

    expect(admissions).toEqual([]);
    expect(admitted.stops).toHaveLength(1);
    expect(admitted.stops[0]).toMatchObject({
      labelId: UNSLOTTED_DEV.id,
      force: false,
    });
    expect(process.env[DEV_DESKTOP_SLOT_ENV]).toBe("other");
  });

  describe("labelHostHomeDir", () => {
    const cases: readonly {
      readonly name: string;
      readonly label: ServiceLabel;
      readonly segments: readonly string[];
    }[] = [
      { name: "production", label: PRODUCTION, segments: ["host"] },
      { name: "staging", label: STAGING, segments: ["host", "staging"] },
      {
        name: "dev with no slot",
        label: UNSLOTTED_DEV,
        segments: ["host", "dev"],
      },
      {
        name: "dev slot s",
        label: SLOT_S,
        segments: ["host", "dev-runs", "s"],
      },
    ];
    const coordinatorSlots: readonly (string | undefined)[] = [
      "other",
      undefined,
    ];

    for (const testCase of cases) {
      for (const slot of coordinatorSlots) {
        it(`${testCase.name} resolves the same with DEV_DESKTOP_SLOT ${slot === undefined ? "unset" : `'${slot}'`}`, () => {
          const resolved = withSlotEnv(slot, () =>
            labelHostHomeDir(testCase.label),
          );
          expect(resolved).toBe(join(root, ...testCase.segments));
        });
      }
    }
  });
});
