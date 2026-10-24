import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_MIGRATION_PROTOCOL_VERSION } from "@traycer/protocol/config/data-migration-contracts";
import type { MaintenanceProgress } from "@traycer/protocol/config/data-maintenance-channel";
import type {
  ComponentHandshake,
  MaintenanceOperation,
  MaintenanceResponse,
  MigrationJournal,
} from "@traycer/protocol/config/data-migration-contracts";
import {
  createMaintenanceClient,
  fixedHostLocator,
  sourceRootHostLocator,
  type MaintenanceClient,
  type MaintenanceLimits,
} from "../maintenance-client";
import {
  captureStop,
  sampleJournal,
  scratchScope,
  stopCodes,
} from "./engine-fixtures";

/**
 * The coordinator's side of the offline `data-maintenance` channel against a
 * REAL child process: a generated host script (run by the same runtime as the
 * tests) that speaks the TRM1 frame protocol - 4-byte magic, 4-byte big-endian
 * length, UTF-8 JSON - implemented inline, independently of the production
 * encoder/decoder.
 */

type HostBehavior =
  | {
      readonly kind: "respond";
      readonly handshake: ComponentHandshake;
      readonly overrides: {
        readonly migrationId: string | null;
        readonly journalRevision: number | null;
        readonly operation: string | null;
      };
      readonly progress: boolean;
      readonly exitCode: number;
    }
  | { readonly kind: "fatal" }
  | { readonly kind: "silent-exit"; readonly exitCode: number }
  | { readonly kind: "hang" }
  | { readonly kind: "chatty" }
  | { readonly kind: "garbage" }
  | {
      /** Carries what the script's `responseFor` reads, so real bytes are written before the cut. */
      readonly kind: "truncated";
      readonly handshake: ComponentHandshake;
      readonly overrides: {
        readonly migrationId: null;
        readonly journalRevision: null;
        readonly operation: null;
      };
    }
  | { readonly kind: "unexpected-frame" };

const GOOD_HANDSHAKE: ComponentHandshake = {
  component: "maintenance",
  build: "test-host",
  dataMigrationProtocol: 1,
};
const NO_OVERRIDES = {
  migrationId: null,
  journalRevision: null,
  operation: null,
};

function respond(
  overrides: Partial<Extract<HostBehavior, { kind: "respond" }>>,
): HostBehavior {
  return {
    kind: "respond",
    handshake: GOOD_HANDSHAKE,
    overrides: NO_OVERRIDES,
    progress: false,
    exitCode: 0,
    ...overrides,
  };
}

function hostScript(behavior: HostBehavior): string {
  return `#!${process.execPath}
"use strict";
const BEHAVIOR = ${JSON.stringify(behavior)};
function frame(object) {
  const payload = Buffer.from(JSON.stringify(object), "utf8");
  const header = Buffer.alloc(8);
  header.write("TRM1", 0, "ascii");
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
function write(buffer, then) {
  process.stdout.write(buffer, then);
}
function responseFor(request) {
  return {
    version: 1,
    handshake: BEHAVIOR.handshake,
    migrationId: BEHAVIOR.overrides.migrationId === null ? request.migrationId : BEHAVIOR.overrides.migrationId,
    journalRevision: BEHAVIOR.overrides.journalRevision === null ? request.journalRevision : BEHAVIOR.overrides.journalRevision,
    operation: BEHAVIOR.overrides.operation === null ? request.operation : BEHAVIOR.overrides.operation,
    provisional: false,
    inventoryDigest: null,
    supportedAdapters: [],
    receipts: [],
    blockers: [],
    sessionImpacts: [],
    stores: [],
  };
}
function act(requestFrame) {
  const request = requestFrame.request;
  switch (BEHAVIOR.kind) {
    case "respond": {
      const progress = { kind: "progress", progress: { operation: request.operation, completedStores: 1, totalStores: 2 } };
      const out = BEHAVIOR.progress
        ? Buffer.concat([frame(progress), frame({ kind: "response", response: responseFor(request) })])
        : frame({ kind: "response", response: responseFor(request) });
      write(out, () => process.exit(BEHAVIOR.exitCode));
      return;
    }
    case "fatal":
      write(frame({ kind: "fatal", code: "bad-request", message: "refused" }), () => process.exit(0));
      return;
    case "silent-exit":
      process.exit(BEHAVIOR.exitCode);
      return;
    case "hang":
      setInterval(() => {}, 1000);
      return;
    case "chatty":
      setInterval(() => {
        write(frame({ kind: "progress", progress: { operation: request.operation, completedStores: 0, totalStores: 1 } }));
      }, 40);
      return;
    case "garbage":
      write(Buffer.from("NOPE-this-is-not-a-frame"), () => process.exit(0));
      return;
    case "truncated": {
      const full = frame({ kind: "response", response: responseFor(request) });
      write(full.subarray(0, 20), () => process.exit(0));
      return;
    }
    case "unexpected-frame":
      write(frame(requestFrame), () => process.exit(0));
      return;
  }
}
let buffered = Buffer.alloc(0);
let handled = false;
process.stdin.on("data", (chunk) => {
  if (handled) return;
  buffered = Buffer.concat([buffered, chunk]);
  if (buffered.length < 8) return;
  const length = buffered.readUInt32BE(4);
  if (buffered.length < 8 + length) return;
  handled = true;
  act(JSON.parse(buffered.subarray(8, 8 + length).toString("utf8")));
});
process.stdin.on("end", () => {
  if (!handled) process.exit(9);
});
`;
}

const PATIENT: MaintenanceLimits = { inactivityMs: 20_000, totalMs: 60_000 };

describe.skipIf(process.platform === "win32")("maintenance client", () => {
  const scratch = scratchScope();

  async function clientFor(
    behavior: HostBehavior,
    limits: MaintenanceLimits,
  ): Promise<{ readonly client: MaintenanceClient; readonly cwd: string }> {
    const dir = await scratch.create();
    const executable = join(dir, "fake-host");
    await writeFile(executable, hostScript(behavior));
    await chmod(executable, 0o755);
    return {
      client: createMaintenanceClient({
        locateHost: fixedHostLocator(executable),
        limits,
        cwd: dir,
      }),
      cwd: dir,
    };
  }

  function request(
    client: MaintenanceClient,
    journal: MigrationJournal,
    operation: MaintenanceOperation,
    signal: AbortSignal,
    progress: MaintenanceProgress[],
  ): Promise<MaintenanceResponse> {
    return client.run({
      journal,
      operation,
      inventoryDigest: null,
      signal,
      onProgress: (event) => progress.push(event),
    });
  }

  const never = (): AbortSignal => new AbortController().signal;

  describe("a valid exchange", () => {
    it("returns the response that echoes the request and forwards progress frames in order", async () => {
      const { client } = await clientFor(respond({ progress: true }), PATIENT);
      const journal = sampleJournal({ maintenanceBuild: null });
      const progress: MaintenanceProgress[] = [];
      const response = await request(
        client,
        journal,
        "inventory",
        never(),
        progress,
      );
      expect(response).toMatchObject({
        version: 1,
        migrationId: journal.id,
        journalRevision: journal.revision,
        operation: "inventory",
        handshake: GOOD_HANDSHAKE,
      });
      expect(progress).toEqual([
        { operation: "inventory", completedStores: 1, totalStores: 2 },
      ]);
    });

    it("accepts a response from the very build the journal pinned", async () => {
      const { client } = await clientFor(respond({}), PATIENT);
      const journal = sampleJournal({ maintenanceBuild: GOOD_HANDSHAKE });
      const response = await request(
        client,
        journal,
        "verify-copy",
        never(),
        [],
      );
      expect(response.operation).toBe("verify-copy");
    });
  });

  describe("a response that does not answer the request", () => {
    it.each([
      {
        name: "another migration id",
        overrides: {
          ...NO_OVERRIDES,
          migrationId: "m-ffffffff-0000-4000-8000-000000000000",
        },
      },
      {
        name: "another journal revision",
        overrides: { ...NO_OVERRIDES, journalRevision: 999 },
      },
      {
        name: "another operation",
        overrides: { ...NO_OVERRIDES, operation: "repair-copy" },
      },
    ])("fails with maintenance-mismatch for $name", async ({ overrides }) => {
      const { client } = await clientFor(respond({ overrides }), PATIENT);
      const stop = await captureStop(
        request(
          client,
          sampleJournal({ maintenanceBuild: null }),
          "inventory",
          never(),
          [],
        ),
      );
      expect(stop.reason).toBe("failed");
      expect(stopCodes(stop)).toEqual(["maintenance-mismatch"]);
    });
  });

  describe("an incompatible or changed host", () => {
    it("rejects a handshake from a newer data-migration protocol", async () => {
      const { client } = await clientFor(
        respond({
          handshake: {
            component: "maintenance",
            build: "future",
            dataMigrationProtocol: 2,
          },
        }),
        PATIENT,
      );
      const stop = await captureStop(
        request(
          client,
          sampleJournal({ maintenanceBuild: null }),
          "inventory",
          never(),
          [],
        ),
      );
      expect(stop.reason).toBe("failed");
      expect(stopCodes(stop)).toEqual(["maintenance-incompatible"]);
    });

    it("rejects a schema-invalid handshake (protocol 0) as maintenance-protocol", async () => {
      const invalid = await clientFor(
        respond({
          handshake: {
            component: "maintenance",
            build: "old",
            dataMigrationProtocol: 0,
          },
        }),
        PATIENT,
      );
      expect(
        stopCodes(
          await captureStop(
            request(
              invalid.client,
              sampleJournal({ maintenanceBuild: null }),
              "inventory",
              never(),
              [],
            ),
          ),
        ),
      ).toEqual(["maintenance-protocol"]);
    });

    it("rejects a handshake that is not the maintenance component", async () => {
      const wrongComponent = await clientFor(
        respond({
          handshake: {
            component: "host",
            build: "test-host",
            dataMigrationProtocol: 1,
          },
        }),
        PATIENT,
      );
      expect(
        stopCodes(
          await captureStop(
            request(
              wrongComponent.client,
              sampleJournal({ maintenanceBuild: null }),
              "inventory",
              never(),
              [],
            ),
          ),
        ),
      ).toEqual(["maintenance-incompatible"]);
    });

    it.skipIf(DATA_MIGRATION_PROTOCOL_VERSION === 1)(
      "rejects a valid but older protocol as maintenance-incompatible",
      async () => {
        const older = await clientFor(
          respond({
            handshake: {
              component: "maintenance",
              build: "old",
              dataMigrationProtocol: DATA_MIGRATION_PROTOCOL_VERSION - 1,
            },
          }),
          PATIENT,
        );
        expect(
          stopCodes(
            await captureStop(
              request(
                older.client,
                sampleJournal({ maintenanceBuild: null }),
                "inventory",
                never(),
                [],
              ),
            ),
          ),
        ).toEqual(["maintenance-incompatible"]);
      },
    );

    it("fails with maintenance-build-changed when the journal pinned another build", async () => {
      const { client } = await clientFor(respond({}), PATIENT);
      const pinned: ComponentHandshake = {
        component: "maintenance",
        build: "the-build-that-started-it",
        dataMigrationProtocol: 1,
      };
      const stop = await captureStop(
        request(
          client,
          sampleJournal({ maintenanceBuild: pinned }),
          "verify-copy",
          never(),
          [],
        ),
      );
      expect(stop.reason).toBe("failed");
      expect(stopCodes(stop)).toEqual(["maintenance-build-changed"]);
    });
  });

  describe("a broken child", () => {
    it("fails on a fatal frame, carrying its code", async () => {
      const { client } = await clientFor({ kind: "fatal" }, PATIENT);
      const stop = await captureStop(
        request(
          client,
          sampleJournal({ maintenanceBuild: null }),
          "inventory",
          never(),
          [],
        ),
      );
      expect(stop.reason).toBe("failed");
      expect(stopCodes(stop)).toEqual(["maintenance-bad-request"]);
    });

    it("fails with maintenance-crashed when the child exits without a response", async () => {
      const { client } = await clientFor(
        { kind: "silent-exit", exitCode: 3 },
        PATIENT,
      );
      const stop = await captureStop(
        request(
          client,
          sampleJournal({ maintenanceBuild: null }),
          "inventory",
          never(),
          [],
        ),
      );
      expect(stop.reason).toBe("failed");
      expect(stopCodes(stop)).toEqual(["maintenance-crashed"]);
    });

    it("fails with maintenance-crashed when the child answers and then exits non-zero", async () => {
      const { client } = await clientFor(respond({ exitCode: 3 }), PATIENT);
      const stop = await captureStop(
        request(
          client,
          sampleJournal({ maintenanceBuild: null }),
          "inventory",
          never(),
          [],
        ),
      );
      expect(stopCodes(stop)).toEqual(["maintenance-crashed"]);
    });

    it("fails with maintenance-protocol for bytes that are not a frame", async () => {
      const { client } = await clientFor({ kind: "garbage" }, PATIENT);
      const stop = await captureStop(
        request(
          client,
          sampleJournal({ maintenanceBuild: null }),
          "inventory",
          never(),
          [],
        ),
      );
      expect(stop.reason).toBe("failed");
      expect(stopCodes(stop)).toEqual(["maintenance-protocol"]);
    });

    it("fails with maintenance-protocol when the child ends inside a frame", async () => {
      const { client } = await clientFor(
        {
          kind: "truncated",
          handshake: GOOD_HANDSHAKE,
          overrides: NO_OVERRIDES,
        },
        PATIENT,
      );
      const stop = await captureStop(
        request(
          client,
          sampleJournal({ maintenanceBuild: null }),
          "inventory",
          never(),
          [],
        ),
      );
      expect(stopCodes(stop)).toEqual(["maintenance-protocol"]);
    });

    it("fails with maintenance-protocol for a frame kind the child must never send", async () => {
      const { client } = await clientFor({ kind: "unexpected-frame" }, PATIENT);
      const stop = await captureStop(
        request(
          client,
          sampleJournal({ maintenanceBuild: null }),
          "inventory",
          never(),
          [],
        ),
      );
      expect(stopCodes(stop)).toEqual(["maintenance-protocol"]);
    });

    it("fails with maintenance-unavailable when the executable cannot be started", async () => {
      const dir = await scratch.create();
      const client = createMaintenanceClient({
        locateHost: fixedHostLocator(join(dir, "does-not-exist")),
        limits: PATIENT,
        cwd: dir,
      });
      const stop = await captureStop(
        request(
          client,
          sampleJournal({ maintenanceBuild: null }),
          "inventory",
          never(),
          [],
        ),
      );
      expect(stop.reason).toBe("failed");
      expect(stopCodes(stop)).toEqual(["maintenance-unavailable"]);
    });
  });

  describe("bounds", () => {
    it("kills a silent child after the inactivity window (maintenance-timeout)", async () => {
      const { client } = await clientFor(
        { kind: "hang" },
        { inactivityMs: 300, totalMs: 60_000 },
      );
      const started = Date.now();
      const stop = await captureStop(
        request(
          client,
          sampleJournal({ maintenanceBuild: null }),
          "inventory",
          never(),
          [],
        ),
      );
      expect(stop.reason).toBe("failed");
      expect(stopCodes(stop)).toEqual(["maintenance-timeout"]);
      expect(Date.now() - started).toBeLessThan(15_000);
    });

    it("kills a child that keeps talking once the total budget is spent (maintenance-timeout)", async () => {
      const { client } = await clientFor(
        { kind: "chatty" },
        { inactivityMs: 20_000, totalMs: 600 },
      );
      const progress: MaintenanceProgress[] = [];
      const stop = await captureStop(
        request(
          client,
          sampleJournal({ maintenanceBuild: null }),
          "inventory",
          never(),
          progress,
        ),
      );
      expect(stopCodes(stop)).toEqual(["maintenance-timeout"]);
    });

    it("does not start the child when the signal is already aborted (cancelled)", async () => {
      const { client } = await clientFor(respond({}), PATIENT);
      const controller = new AbortController();
      controller.abort();
      const stop = await captureStop(
        request(
          client,
          sampleJournal({ maintenanceBuild: null }),
          "inventory",
          controller.signal,
          [],
        ),
      );
      expect(stop.reason).toBe("failed");
      expect(stopCodes(stop)).toEqual(["cancelled"]);
    });

    it("kills the child when the signal aborts mid-exchange (cancelled)", async () => {
      const { client } = await clientFor({ kind: "hang" }, PATIENT);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      const stop = await captureStop(
        request(
          client,
          sampleJournal({ maintenanceBuild: null }),
          "inventory",
          controller.signal,
          [],
        ),
      );
      expect(stopCodes(stop)).toEqual(["cancelled"]);
    });
  });

  describe("a coordinator that was never recorded", () => {
    it("is a programming error, not an operational stop", async () => {
      const { client } = await clientFor(respond({}), PATIENT);
      const journal: MigrationJournal = {
        ...sampleJournal({ maintenanceBuild: null }),
        coordinator: null,
      };
      await expect(
        request(client, journal, "inventory", never(), []),
      ).rejects.toThrow(/coordinator/u);
    });
  });

  describe("sourceRootHostLocator", () => {
    it("stops failed with maintenance-host-missing when no install record names a host in the source root", async () => {
      const dir = await scratch.create();
      await mkdir(join(dir, "empty"));
      const locate = sourceRootHostLocator({
        installRecordPathFor: (environment) =>
          join(dir, "empty", `${environment}.json`),
        platform: "posix",
      });
      const stop = await captureStop(
        locate(sampleJournal({ maintenanceBuild: null })),
      );
      expect(stop.reason).toBe("failed");
      expect(stopCodes(stop)).toEqual(["maintenance-host-missing"]);
    });
  });
});
