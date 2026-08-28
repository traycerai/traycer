import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import * as barrel from "../index";
import {
  __resetHeldInProcessForTest,
  acquireUpdateAttemptLock,
  type UpdateAttemptLockHandle,
} from "../lock";
import { updateAttemptLockPath, updateAttemptRecordPath } from "../paths";
import type { HostUpdateAttemptIdentity } from "../record";
import { TERMINAL_ATTEMPT_RETENTION_MS } from "../record";
import {
  __sameRecordFileIdentityForTest,
  __setBeforeRecordOpenHookForTest,
  __setBeforeRecordRemoveHookForTest,
  __setBeforeRecordRenameHookForTest,
  __setDirectorySyncHookForTest,
  __setRecordOpenPlatformForTest,
  commitAttemptMutation,
  commitExecutorOnlyAttemptMutation,
  pruneTerminalAttemptRecord,
  readUpdateAttemptRecord,
  type AttemptCommitOutcome,
  type AttemptMutationIntent,
  type ExecutorOnlyAttemptMutationIntent,
  type PublicAttemptMutationIntent,
} from "../store";
import type { AttemptClaimRequest } from "../transition";

const execFileAsync = promisify(execFile);

function baseCreateRequest(
  overrides: Partial<AttemptClaimRequest>,
): AttemptClaimRequest {
  return {
    targetVersion: "1.2.3",
    trigger: "manual",
    action: "start",
    expected: null,
    newAttemptId: "attempt-1",
    initialPhase: "downloading",
    nowIso: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const dirs: string[] = [];
const handles: UpdateAttemptLockHandle[] = [];

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "host-update-store-test-"));
  dirs.push(dir);
  return dir;
}

async function acquireHandle(
  hostHomeDir: string,
  reason: string,
): Promise<UpdateAttemptLockHandle> {
  const outcome = await acquireUpdateAttemptLock({
    hostHomeDir,
    reason,
    waitMs: 0,
    pollIntervalMs: 25,
  });
  if (outcome.kind !== "acquired") {
    throw new Error(`expected to acquire the lock, got ${outcome.kind}`);
  }
  handles.push(outcome.handle);
  return outcome.handle;
}

async function waitUntil(
  predicate: () => boolean,
  maxWaitMs: number,
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitUntil: condition never became true");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(async () => {
  __setBeforeRecordOpenHookForTest(null);
  __setBeforeRecordRenameHookForTest(null);
  __setBeforeRecordRemoveHookForTest(null);
  __setDirectorySyncHookForTest(null);
  __setRecordOpenPlatformForTest(null);
  __resetHeldInProcessForTest();
  await Promise.all(
    handles.splice(0).map((handle) => handle.release().catch(() => undefined)),
  );
  await Promise.all(
    dirs.splice(0).map(async (dir) => {
      await chmod(dir, 0o700).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("the barrel does not export raw record mutators", () => {
  it("has no writeUpdateAttemptRecord, removeUpdateAttemptRecord, or the old recordPath-based commitAttemptRecord", () => {
    expect("writeUpdateAttemptRecord" in barrel).toBe(false);
    expect("removeUpdateAttemptRecord" in barrel).toBe(false);
    expect("commitAttemptRecord" in barrel).toBe(false);
  });

  it("exports only the handle-bound, intent-based mutation API", () => {
    expect(typeof barrel.commitAttemptMutation).toBe("function");
    expect(typeof barrel.pruneTerminalAttemptRecord).toBe("function");
    expect(typeof barrel.readUpdateAttemptRecord).toBe("function");
    expect(typeof barrel.acquireAttemptMutationLease).toBe("function");
  });

  it("does not export the executor-only channel or its type - commitExecutorOnlyAttemptMutation and ExecutorOnlyAttemptMutationIntent stay direct-module-only", () => {
    expect("commitExecutorOnlyAttemptMutation" in barrel).toBe(false);
  });
});

// Ticket 03 final-authority cold review, P0, exact reproduction: the reviewer
// reached a false durable `complete` terminalization using nothing but
// `@traycer-clients/shared/host-update`'s own public exports - no deep
// import, no generic contender facade. This block reproduces that exact
// shape, importing only through the barrel namespace (`barrel.*`, from
// "../index" above) rather than any direct module, and proves the barrel's
// own `AttemptMutationIntent` type alias already excludes the shape at
// compile time.
describe("public barrel-only reproduction (Ticket 03 final-authority cold review P0)", () => {
  it("acquires a lock handle and commits a create through nothing but the barrel, then a structural `recover` intent commits no durable terminal write", async () => {
    const dir = await freshDir();

    const withOutcome = await barrel.withUpdateAttemptLock(
      {
        hostHomeDir: dir,
        reason: "barrel-only-repro",
        waitMs: 0,
        pollIntervalMs: 25,
      },
      async (handle) => {
        const created = await barrel.commitAttemptMutation({
          handle,
          intent: { kind: "create", request: baseCreateRequest({}) },
        });
        if (created.kind !== "committed") {
          throw new Error(`expected committed create, got ${created.kind}`);
        }

        const before = await readFile(updateAttemptRecordPath(dir), "utf8");

        // The reviewer's exact reproduction: a `recover` intent whose
        // installed/running legs are plain `verified` literals, with no
        // install tree or host process behind them. The barrel's exported
        // `AttemptMutationIntent` (= `PublicAttemptMutationIntent`)
        // structurally excludes `recover`, so only a cast reaches this call -
        // exactly the JS-boundary bypass the runtime guard exists to refuse.
        const structuralRecover: ExecutorOnlyAttemptMutationIntent = {
          kind: "recover",
          recovery: {
            expected: created.identity,
            action: "force",
            requestedTargetVersion: "1.2.3",
            evidence: {
              installed: { kind: "verified", version: "1.2.3" },
              staged: { kind: "absent" },
              running: {
                kind: "verified",
                version: "1.2.3",
                owner: "host-home-bound",
              },
            },
            nowIso: "2026-01-01T00:04:00.000Z",
          },
        };
        // Types disappear at the JavaScript boundary - build the forced
        // value through property assignment the same way that boundary is
        // actually crossed at runtime, rather than a type assertion the
        // compiler would reject outright.
        const forgedRecover = {} as PublicAttemptMutationIntent;
        for (const [key, value] of Object.entries(structuralRecover)) {
          Object.defineProperty(forgedRecover, key, {
            value,
            enumerable: true,
            configurable: true,
          });
        }

        const outcome = await barrel.commitAttemptMutation({
          handle,
          intent: forgedRecover,
        });

        expect(outcome).toMatchObject({
          kind: "rejected",
          reason: "intent-not-legal",
        });
        expect(await readFile(updateAttemptRecordPath(dir), "utf8")).toBe(
          before,
        );
        return "checked" as const;
      },
    );

    expect(withOutcome).toMatchObject({ kind: "acquired", result: "checked" });
  });

  it("the barrel's own `AttemptMutationIntent` export excludes `recover` at compile time - a `recover` literal is a type error naming only barrel-exported types", () => {
    const onlyTypeChecked = (intent: barrel.AttemptMutationIntent): void => {
      // @ts-expect-error the barrel's AttemptMutationIntent has no `recover` member.
      if (intent.kind === "recover") return;
    };
    void onlyTypeChecked;
    expect(true).toBe(true);
  });
});

describe("commitAttemptMutation - canonical binding", () => {
  it("writes only to the canonical record path derived from the handle's hostHomeDir", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "segment");

    const outcome = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(outcome.kind).toBe("committed");

    const recordPath = updateAttemptRecordPath(dir);
    const lockPath = updateAttemptLockPath(dir);
    await expect(stat(recordPath)).resolves.toBeDefined();

    // Exactly the two canonical filenames exist in the host home - no
    // sibling record was ever created next to the real one.
    const entries = (await readdir(dir)).sort();
    expect(entries).toEqual(
      [recordPath.slice(dir.length + 1), lockPath.slice(dir.length + 1)].sort(),
    );
  });

  it("two different host homes' handles never cross-write each other's canonical record", async () => {
    const dirA = await freshDir();
    const dirB = await freshDir();
    const handleA = await acquireHandle(dirA, "segment-a");
    const handleB = await acquireHandle(dirB, "segment-b");

    await commitAttemptMutation({
      handle: handleA,
      intent: {
        kind: "create",
        request: baseCreateRequest({ newAttemptId: "attempt-a" }),
      },
    });
    await commitAttemptMutation({
      handle: handleB,
      intent: {
        kind: "create",
        request: baseCreateRequest({ newAttemptId: "attempt-b" }),
      },
    });

    const readA = await readUpdateAttemptRecord(dirA);
    const readB = await readUpdateAttemptRecord(dirB);
    expect(readA.kind).toBe("valid");
    expect(readB.kind).toBe("valid");
    if (readA.kind === "valid") expect(readA.value.attemptId).toBe("attempt-a");
    if (readB.kind === "valid") expect(readB.value.attemptId).toBe("attempt-b");
  });
});

describe("commitAttemptMutation - illegal transitions are structurally unrepresentable", () => {
  // There is no `next` parameter anywhere on this API: the caller supplies
  // only an intent, and the module re-reads canonical disk state and asks
  // the pure transition algebra (`decideAttemptClaim` / `advanceAttempt`) to
  // derive the exact output. An arbitrary A -> B replacement, a counter
  // jump, or a target/trigger rewrite therefore cannot be expressed by any
  // caller of this API - not merely rejected at runtime.

  it("rejects intent-not-legal for a create intent over an already-active record, and disk is untouched", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "segment");

    const created = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(created.kind).toBe("committed");

    const attempt = await commitAttemptMutation({
      handle,
      intent: {
        kind: "create",
        request: baseCreateRequest({
          newAttemptId: "attempt-2",
          targetVersion: "9.9.9",
        }),
      },
    });
    expect(attempt.kind).toBe("rejected");
    if (attempt.kind === "rejected") {
      expect(attempt.reason).toBe("intent-not-legal");
    }

    const onDisk = await readUpdateAttemptRecord(dir);
    expect(onDisk.kind).toBe("valid");
    if (onDisk.kind === "valid")
      expect(onDisk.value.attemptId).toBe("attempt-1");
  });

  it("rejects intent-not-legal for a resume intent over an active (non-parked) record", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "segment");
    await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });

    const outcome = await commitAttemptMutation({
      handle,
      intent: {
        kind: "resume",
        request: baseCreateRequest({
          action: "resume-apply",
          expected: { attemptId: "attempt-1", generation: 1, sequence: 1 },
        }),
      },
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toBe("intent-not-legal");
    }
  });

  it("rejects intent-not-legal for a supersede intent over an active (non-parked) record - supersede is the retained-parked-target path only", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "segment");
    await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });

    const outcome = await commitAttemptMutation({
      handle,
      intent: {
        kind: "supersede",
        request: baseCreateRequest({ targetVersion: "9.9.9" }),
      },
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toBe("intent-not-legal");
    }
  });

  it("performs a two-write supersede: commit terminalizes the old target, and a SEPARATE create intent is required to land the new one", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "segment");

    // Build up a parked record the way a real executor would: create, then
    // advance into a park.
    await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    const parked = await commitAttemptMutation({
      handle,
      intent: {
        kind: "advance",
        held: { attemptId: "attempt-1", generation: 1, sequence: 1 },
        advance: {
          phase: "waiting-for-work",
          continuation: "resume-apply",
          progress: null,
          error: null,
          nowIso: "2026-01-01T00:01:00.000Z",
        },
      },
    });
    expect(parked.kind).toBe("committed");

    const supersede = await commitAttemptMutation({
      handle,
      intent: {
        kind: "supersede",
        request: baseCreateRequest({ targetVersion: "9.9.9" }),
      },
    });
    expect(supersede.kind).toBe("committed");
    if (supersede.kind === "committed") {
      expect(supersede.record.attemptId).toBe("attempt-1");
      expect(supersede.record.execution).toBe("terminal");
      expect(supersede.record.phase).toBe("superseded");
    }

    // The old attempt's terminal outcome is durably on disk RIGHT NOW - a
    // crash here must not be able to erase it.
    const afterSupersede = await readUpdateAttemptRecord(dir);
    expect(afterSupersede.kind).toBe("valid");
    if (afterSupersede.kind === "valid") {
      expect(afterSupersede.value.attemptId).toBe("attempt-1");
      expect(afterSupersede.value.execution).toBe("terminal");
    }

    const create = await commitAttemptMutation({
      handle,
      intent: {
        kind: "create",
        request: baseCreateRequest({
          targetVersion: "9.9.9",
          newAttemptId: "attempt-2",
        }),
      },
    });
    expect(create.kind).toBe("committed");
    if (create.kind === "committed") {
      expect(create.record.attemptId).toBe("attempt-2");
      expect(create.record.generation).toBe(1);
      expect(create.record.sequence).toBe(1);
    }
  });

  it("commits an advance intent, re-derived from disk rather than caller-supplied", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "segment");
    await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });

    const outcome = await commitAttemptMutation({
      handle,
      intent: {
        kind: "advance",
        held: { attemptId: "attempt-1", generation: 1, sequence: 1 },
        advance: {
          phase: "preparing",
          continuation: null,
          progress: null,
          error: null,
          nowIso: "2026-01-01T00:02:00.000Z",
        },
      },
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind === "committed") {
      expect(outcome.record.phase).toBe("preparing");
      expect(outcome.record.sequence).toBe(2);
    }
  });

  it("rejects intent-not-legal for an advance intent bound to a stale (late-writer) identity", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "segment");
    await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    await commitAttemptMutation({
      handle,
      intent: {
        kind: "advance",
        held: { attemptId: "attempt-1", generation: 1, sequence: 1 },
        advance: {
          phase: "preparing",
          continuation: null,
          progress: null,
          error: null,
          nowIso: "2026-01-01T00:02:00.000Z",
        },
      },
    });

    // A late callback still closing over the ORIGINAL identity (sequence 1),
    // even though disk has since moved to sequence 2.
    const stale = await commitAttemptMutation({
      handle,
      intent: {
        kind: "advance",
        held: { attemptId: "attempt-1", generation: 1, sequence: 1 },
        advance: {
          phase: "applying",
          continuation: null,
          progress: null,
          error: null,
          nowIso: "2026-01-01T00:03:00.000Z",
        },
      },
    });
    expect(stale.kind).toBe("rejected");
    if (stale.kind === "rejected") {
      expect(stale.reason).toBe("intent-not-legal");
    }

    const onDisk = await readUpdateAttemptRecord(dir);
    expect(onDisk.kind).toBe("valid");
    if (onDisk.kind === "valid") expect(onDisk.value.phase).toBe("preparing");
  });
});

describe("commitAttemptMutation - byte authority and round trips", () => {
  async function expectExactRoundTrip(
    dir: string,
    outcome: AttemptCommitOutcome,
  ): Promise<void> {
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    const read = await readUpdateAttemptRecord(dir);
    expect(read.kind).toBe("valid");
    if (read.kind !== "valid") return;
    expect(read.value).toEqual(outcome.record);
    expect(await readFile(updateAttemptRecordPath(dir), "utf8")).toBe(
      `${JSON.stringify(outcome.record, null, 2)}\n`,
    );
  }

  const mutationIntentKinds: {
    readonly [K in AttemptMutationIntent["kind"]]: K;
  } = {
    create: "create",
    resume: "resume",
    supersede: "supersede",
    advance: "advance",
    recover: "recover",
  };

  it.each(Object.values(mutationIntentKinds))(
    "writes decoder-valid, byte-identical output for the %s intent",
    async (kind) => {
      const dir = await freshDir();
      const handle = await acquireHandle(dir, `roundtrip-${kind}`);

      if (kind === "create") {
        await expectExactRoundTrip(
          dir,
          await commitAttemptMutation({
            handle,
            intent: { kind, request: baseCreateRequest({}) },
          }),
        );
        return;
      }

      const created = await commitAttemptMutation({
        handle,
        intent: { kind: "create", request: baseCreateRequest({}) },
      });
      expect(created.kind).toBe("committed");
      if (created.kind !== "committed") return;

      if (kind === "recover") {
        // Active, unheld record with independently verified install + running
        // evidence for the exact target: the sole path that bypasses the
        // ordinary verifying -> complete edge.
        await expectExactRoundTrip(
          dir,
          await commitExecutorOnlyAttemptMutation({
            handle,
            intent: {
              kind,
              recovery: {
                expected: created.identity,
                action: "force",
                requestedTargetVersion: "1.2.3",
                evidence: {
                  installed: { kind: "verified", version: "1.2.3" },
                  staged: { kind: "absent" },
                  running: {
                    kind: "verified",
                    version: "1.2.3",
                    owner: "host-home-bound",
                  },
                },
                nowIso: "2026-01-01T00:04:00.000Z",
              },
            },
          }),
        );
        return;
      }

      if (kind === "advance") {
        await expectExactRoundTrip(
          dir,
          await commitAttemptMutation({
            handle,
            intent: {
              kind,
              held: created.identity,
              advance: {
                phase: "preparing",
                continuation: null,
                progress: { percent: 10, bytes: 20, totalBytes: 200 },
                error: null,
                nowIso: "2026-01-01T00:02:00.000Z",
              },
            },
          }),
        );
        return;
      }

      const parked = await commitAttemptMutation({
        handle,
        intent: {
          kind: "advance",
          held: created.identity,
          advance: {
            phase: "waiting-for-work",
            continuation: "resume-apply",
            progress: null,
            error: null,
            nowIso: "2026-01-01T00:01:00.000Z",
          },
        },
      });
      expect(parked.kind).toBe("committed");
      if (parked.kind !== "committed") return;

      if (kind === "resume") {
        await expectExactRoundTrip(
          dir,
          await commitAttemptMutation({
            handle,
            intent: {
              kind,
              request: baseCreateRequest({
                action: "resume-apply",
                expected: parked.identity,
                initialPhase: "preparing",
                nowIso: "2026-01-01T00:03:00.000Z",
              }),
            },
          }),
        );
        return;
      }

      await expectExactRoundTrip(
        dir,
        await commitAttemptMutation({
          handle,
          intent: {
            kind,
            request: baseCreateRequest({ targetVersion: "9.9.9" }),
          },
        }),
      );
    },
  );

  const invalidActionRequest = (): AttemptClaimRequest => {
    const request = baseCreateRequest({});
    Object.defineProperty(request, "action", { value: "not-an-action" });
    return request;
  };

  it.each([
    ["empty attempt id", () => baseCreateRequest({ newAttemptId: "" })],
    ["empty target", () => baseCreateRequest({ targetVersion: "" })],
    ["invalid action", invalidActionRequest],
  ] as const)(
    "rejects %s before creating canonical bytes",
    async (_label, makeRequest) => {
      const dir = await freshDir();
      const handle = await acquireHandle(dir, "invalid-request");

      const outcome = await commitAttemptMutation({
        handle,
        intent: { kind: "create", request: makeRequest() },
      });
      expect(outcome).toMatchObject({
        kind: "rejected",
        reason: "intent-invalid",
      });
      await expect(stat(updateAttemptRecordPath(dir))).rejects.toThrow();
    },
  );

  it("rejects malicious progress/error toJSON objects without invoking them or changing bytes", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "malicious-json");
    const created = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(created.kind).toBe("committed");
    const before = await readFile(updateAttemptRecordPath(dir), "utf8");
    let progressToJsonCalls = 0;
    let errorToJsonCalls = 0;
    const progress = {
      percent: 10,
      bytes: 20,
      totalBytes: 200,
      toJSON: () => {
        progressToJsonCalls += 1;
        return { percent: 999 };
      },
    };
    const error = {
      code: "E_TEST",
      message: "bad",
      phase: "preparing",
      toJSON: () => {
        errorToJsonCalls += 1;
        return { code: "forged" };
      },
    };

    const outcome = await commitAttemptMutation({
      handle,
      intent: {
        kind: "advance",
        held: { attemptId: "attempt-1", generation: 1, sequence: 1 },
        advance: {
          phase: "preparing",
          continuation: null,
          progress,
          error,
          nowIso: "2026-01-01T00:02:00.000Z",
        },
      },
    });
    expect(outcome).toMatchObject({
      kind: "rejected",
      reason: "intent-invalid",
    });
    expect(progressToJsonCalls).toBe(0);
    expect(errorToJsonCalls).toBe(0);
    expect(await readFile(updateAttemptRecordPath(dir), "utf8")).toBe(before);
  });

  it.each([
    ["NaN progress", { percent: Number.NaN, bytes: 1, totalBytes: 2 }],
    ["unsafe held identity", null],
  ] as const)("rejects %s before mutation", async (label, progress) => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, `invalid-${label}`);
    await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    const before = await readFile(updateAttemptRecordPath(dir), "utf8");
    const outcome = await commitAttemptMutation({
      handle,
      intent: {
        kind: "advance",
        held:
          progress === null
            ? {
                attemptId: "attempt-1",
                generation: Number.MAX_SAFE_INTEGER + 1,
                sequence: 1,
              }
            : { attemptId: "attempt-1", generation: 1, sequence: 1 },
        advance: {
          phase: "preparing",
          continuation: null,
          progress,
          error: null,
          nowIso: "2026-01-01T00:02:00.000Z",
        },
      },
    });
    expect(outcome).toMatchObject({
      kind: "rejected",
      reason: "intent-invalid",
    });
    expect(await readFile(updateAttemptRecordPath(dir), "utf8")).toBe(before);
  });

  it("snapshots proxy-shaped progress values and writes exactly the validated snapshot", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "proxy-input");
    const created = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(created.kind).toBe("committed");
    if (created.kind !== "committed") return;

    let percentReads = 0;
    const progress = new Proxy(
      { percent: 10, bytes: 20, totalBytes: 200 },
      {
        get(target, property, receiver) {
          if (property === "percent") {
            percentReads += 1;
            return percentReads === 1 ? 10 : 999;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const outcome = await commitAttemptMutation({
      handle,
      intent: {
        kind: "advance",
        held: created.identity,
        advance: {
          phase: "preparing",
          continuation: null,
          progress,
          error: null,
          nowIso: "2026-01-01T00:02:00.000Z",
        },
      },
    });
    await expectExactRoundTrip(dir, outcome);
    expect(percentReads).toBe(0);
    const read = await readUpdateAttemptRecord(dir);
    expect(read.kind).toBe("valid");
    if (read.kind === "valid") {
      expect(read.value.progress).toEqual({
        percent: 10,
        bytes: 20,
        totalBytes: 200,
      });
    }
  });
});

describe("commitAttemptMutation - continuation provenance", () => {
  const advanceDefaults = {
    progress: null,
    error: null,
    nowIso: "2026-01-01T00:05:00.000Z",
  } as const;

  it("rejects preparing/null -> waiting-to-activate/activate and preserves canonical bytes", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "preparing-null");
    const created = await commitAttemptMutation({
      handle,
      intent: {
        kind: "create",
        request: baseCreateRequest({ initialPhase: "preparing" }),
      },
    });
    expect(created.kind).toBe("committed");
    if (created.kind !== "committed") return;
    const before = await readFile(updateAttemptRecordPath(dir), "utf8");

    const outcome = await commitAttemptMutation({
      handle,
      intent: {
        kind: "advance",
        held: created.identity,
        advance: {
          ...advanceDefaults,
          phase: "waiting-to-activate",
          continuation: "activate",
        },
      },
    });
    expect(outcome).toMatchObject({
      kind: "rejected",
      reason: "intent-not-legal",
    });
    expect(await readFile(updateAttemptRecordPath(dir), "utf8")).toBe(before);
  });

  it.each([
    ["restarting", "resume-apply"],
    ["verifying", "resume-apply"],
    ["waiting-to-activate", "activate"],
  ] as const)(
    "rejects resumed resume-apply preparing -> %s and preserves canonical bytes",
    async (phase, continuation) => {
      const dir = await freshDir();
      const handle = await acquireHandle(dir, `resume-apply-${phase}`);
      const created = await commitAttemptMutation({
        handle,
        intent: { kind: "create", request: baseCreateRequest({}) },
      });
      expect(created.kind).toBe("committed");
      if (created.kind !== "committed") return;
      const parked = await commitAttemptMutation({
        handle,
        intent: {
          kind: "advance",
          held: created.identity,
          advance: {
            ...advanceDefaults,
            phase: "waiting-for-work",
            continuation: "resume-apply",
          },
        },
      });
      expect(parked.kind).toBe("committed");
      if (parked.kind !== "committed") return;
      const resumed = await commitAttemptMutation({
        handle,
        intent: {
          kind: "resume",
          request: baseCreateRequest({
            action: "resume-apply",
            expected: parked.identity,
            initialPhase: "preparing",
          }),
        },
      });
      expect(resumed.kind).toBe("committed");
      if (resumed.kind !== "committed") return;
      const before = await readFile(updateAttemptRecordPath(dir), "utf8");

      const outcome = await commitAttemptMutation({
        handle,
        intent: {
          kind: "advance",
          held: resumed.identity,
          advance: { ...advanceDefaults, phase, continuation },
        },
      });
      expect(outcome).toMatchObject({
        kind: "rejected",
        reason: "intent-not-legal",
      });
      expect(await readFile(updateAttemptRecordPath(dir), "utf8")).toBe(before);
    },
  );

  it.each([
    ["verifying", "activate"],
    ["applying", "activate"],
    ["downloading", "activate"],
  ] as const)(
    "rejects activate/preparing -> %s and preserves canonical bytes",
    async (phase, continuation) => {
      const dir = await freshDir();
      const handle = await acquireHandle(dir, `activate-${phase}`);
      const created = await commitAttemptMutation({
        handle,
        intent: {
          kind: "create",
          request: baseCreateRequest({ initialPhase: "applying" }),
        },
      });
      expect(created.kind).toBe("committed");
      if (created.kind !== "committed") return;
      const parked = await commitAttemptMutation({
        handle,
        intent: {
          kind: "advance",
          held: created.identity,
          advance: {
            ...advanceDefaults,
            phase: "waiting-to-activate",
            continuation: "activate",
          },
        },
      });
      expect(parked.kind).toBe("committed");
      if (parked.kind !== "committed") return;
      const resumed = await commitAttemptMutation({
        handle,
        intent: {
          kind: "resume",
          request: baseCreateRequest({
            action: "activate",
            expected: parked.identity,
            initialPhase: "preparing",
          }),
        },
      });
      expect(resumed.kind).toBe("committed");
      if (resumed.kind !== "committed") return;
      const before = await readFile(updateAttemptRecordPath(dir), "utf8");

      const outcome = await commitAttemptMutation({
        handle,
        intent: {
          kind: "advance",
          held: resumed.identity,
          advance: { ...advanceDefaults, phase, continuation },
        },
      });
      expect(outcome).toMatchObject({
        kind: "rejected",
        reason: "intent-not-legal",
      });
      expect(await readFile(updateAttemptRecordPath(dir), "utf8")).toBe(before);
    },
  );

  it.each([
    ["applying/null", null],
    ["applying/resume-apply", "resume-apply"],
  ] as const)(
    "commits the sole legal byte-placement handoff %s -> waiting-to-activate/activate",
    async (_label, continuation) => {
      const dir = await freshDir();
      const handle = await acquireHandle(dir, "legal-byte-handoff");
      let current: AttemptCommitOutcome;
      if (continuation === null) {
        current = await commitAttemptMutation({
          handle,
          intent: {
            kind: "create",
            request: baseCreateRequest({ initialPhase: "applying" }),
          },
        });
      } else {
        const created = await commitAttemptMutation({
          handle,
          intent: { kind: "create", request: baseCreateRequest({}) },
        });
        expect(created.kind).toBe("committed");
        if (created.kind !== "committed") return;
        const parked = await commitAttemptMutation({
          handle,
          intent: {
            kind: "advance",
            held: created.identity,
            advance: {
              ...advanceDefaults,
              phase: "waiting-for-work",
              continuation: "resume-apply",
            },
          },
        });
        expect(parked.kind).toBe("committed");
        if (parked.kind !== "committed") return;
        current = await commitAttemptMutation({
          handle,
          intent: {
            kind: "resume",
            request: baseCreateRequest({
              action: "resume-apply",
              expected: parked.identity,
              initialPhase: "preparing",
            }),
          },
        });
        expect(current.kind).toBe("committed");
        if (current.kind !== "committed") return;
        current = await commitAttemptMutation({
          handle,
          intent: {
            kind: "advance",
            held: current.identity,
            advance: { ...advanceDefaults, phase: "applying", continuation },
          },
        });
      }
      expect(current.kind).toBe("committed");
      if (current.kind !== "committed") return;

      const outcome = await commitAttemptMutation({
        handle,
        intent: {
          kind: "advance",
          held: current.identity,
          advance: {
            ...advanceDefaults,
            phase: "waiting-to-activate",
            continuation: "activate",
          },
        },
      });
      expect(outcome.kind).toBe("committed");
      if (outcome.kind === "committed") {
        expect(outcome.record.phase).toBe("waiting-to-activate");
        expect(outcome.record.continuation).toBe("activate");
      }
    },
  );

  it("commits resumed activate repark, then restarting, then verifying", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "activate-route");
    const created = await commitAttemptMutation({
      handle,
      intent: {
        kind: "create",
        request: baseCreateRequest({ initialPhase: "applying" }),
      },
    });
    expect(created.kind).toBe("committed");
    if (created.kind !== "committed") return;
    const parked = await commitAttemptMutation({
      handle,
      intent: {
        kind: "advance",
        held: created.identity,
        advance: {
          ...advanceDefaults,
          phase: "waiting-to-activate",
          continuation: "activate",
        },
      },
    });
    expect(parked.kind).toBe("committed");
    if (parked.kind !== "committed") return;
    const resumed = await commitAttemptMutation({
      handle,
      intent: {
        kind: "resume",
        request: baseCreateRequest({
          action: "activate",
          expected: parked.identity,
          initialPhase: "preparing",
        }),
      },
    });
    expect(resumed.kind).toBe("committed");
    if (resumed.kind !== "committed") return;

    const reparks = await commitAttemptMutation({
      handle,
      intent: {
        kind: "advance",
        held: resumed.identity,
        advance: {
          ...advanceDefaults,
          phase: "waiting-to-activate",
          continuation: "activate",
        },
      },
    });
    expect(reparks.kind).toBe("committed");
    if (reparks.kind !== "committed") return;

    const resumedAgain = await commitAttemptMutation({
      handle,
      intent: {
        kind: "resume",
        request: baseCreateRequest({
          action: "activate",
          expected: reparks.identity,
          initialPhase: "preparing",
        }),
      },
    });
    expect(resumedAgain.kind).toBe("committed");
    if (resumedAgain.kind !== "committed") return;
    const restarting = await commitAttemptMutation({
      handle,
      intent: {
        kind: "advance",
        held: resumedAgain.identity,
        advance: {
          ...advanceDefaults,
          phase: "restarting",
          continuation: "activate",
        },
      },
    });
    expect(restarting.kind).toBe("committed");
    if (restarting.kind !== "committed") return;
    const verifying = await commitAttemptMutation({
      handle,
      intent: {
        kind: "advance",
        held: restarting.identity,
        advance: {
          ...advanceDefaults,
          phase: "verifying",
          continuation: "activate",
        },
      },
    });
    expect(verifying.kind).toBe("committed");
    if (verifying.kind === "committed") {
      expect(verifying.record.phase).toBe("verifying");
      expect(verifying.record.continuation).toBe("activate");
    }
  });
});

// `recover` and supersede-with-`recovery` are executor-only intents (Ticket 03
// final-authority cold review, P0 class sweep): the public `commitAttemptMutation`
// channel's type excludes them and its runtime unconditionally refuses them
// before any recovery business logic runs (see the dedicated describe block
// below). These business-logic cases therefore exercise the direct-module
// `commitExecutorOnlyAttemptMutation` channel instead - the same channel the
// CLI executor's recovery bridge calls through `contender.ts`. Plain `create`
// and non-completing `advance` calls in this block stay on the public channel
// since they remain legal there.
describe("commitExecutorOnlyAttemptMutation - recover intent", () => {
  it("terminalizes complete when installed + running evidence exactly matches the target, bypassing verifying", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "recover-complete");
    const created = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(created.kind).toBe("committed");
    if (created.kind !== "committed") return;

    const outcome = await commitExecutorOnlyAttemptMutation({
      handle,
      intent: {
        kind: "recover",
        recovery: {
          expected: created.identity,
          action: "force",
          requestedTargetVersion: "1.2.3",
          evidence: {
            installed: { kind: "verified", version: "1.2.3" },
            staged: { kind: "absent" },
            running: {
              kind: "verified",
              version: "1.2.3",
              owner: "host-home-bound",
            },
          },
          nowIso: "2026-01-01T00:04:00.000Z",
        },
      },
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(outcome.record.phase).toBe("complete");
    expect(outcome.record.execution).toBe("terminal");
    expect(outcome.record.recovery).toMatchObject({
      recoveredBy: "attempt-executor",
      outcome: "complete",
    });

    const onDisk = await readUpdateAttemptRecord(dir);
    expect(onDisk.kind).toBe("valid");
    if (onDisk.kind === "valid") expect(onDisk.value.phase).toBe("complete");
  });

  it("resumes into preparing/activate when only installed evidence verifies the target", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "recover-activate");
    const created = await commitAttemptMutation({
      handle,
      intent: {
        kind: "create",
        request: baseCreateRequest({ initialPhase: "applying" }),
      },
    });
    expect(created.kind).toBe("committed");
    if (created.kind !== "committed") return;

    const outcome = await commitExecutorOnlyAttemptMutation({
      handle,
      intent: {
        kind: "recover",
        recovery: {
          expected: created.identity,
          action: "activate",
          requestedTargetVersion: "1.2.3",
          evidence: {
            installed: { kind: "verified", version: "1.2.3" },
            staged: { kind: "absent" },
            running: { kind: "absent" },
          },
          nowIso: "2026-01-01T00:04:00.000Z",
        },
      },
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(outcome.record.phase).toBe("preparing");
    expect(outcome.record.execution).toBe("active");
    expect(outcome.record.continuation).toBe("activate");
    expect(outcome.record.generation).toBe(2);
  });

  it("resumes into preparing/resume-apply when only staged evidence verifies the target", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "recover-resume-apply");
    const created = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(created.kind).toBe("committed");
    if (created.kind !== "committed") return;

    const outcome = await commitExecutorOnlyAttemptMutation({
      handle,
      intent: {
        kind: "recover",
        recovery: {
          expected: created.identity,
          action: "resume-apply",
          requestedTargetVersion: "1.2.3",
          evidence: {
            installed: { kind: "absent" },
            staged: { kind: "verified", version: "1.2.3" },
            running: { kind: "absent" },
          },
          nowIso: "2026-01-01T00:04:00.000Z",
        },
      },
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(outcome.record.phase).toBe("preparing");
    expect(outcome.record.continuation).toBe("resume-apply");
  });

  it("terminalizes failed when evidence contradicts (installed missing at target)", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "recover-contradiction");
    const created = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(created.kind).toBe("committed");
    if (created.kind !== "committed") return;

    const outcome = await commitExecutorOnlyAttemptMutation({
      handle,
      intent: {
        kind: "recover",
        recovery: {
          expected: created.identity,
          action: "force",
          requestedTargetVersion: "1.2.3",
          evidence: {
            installed: { kind: "missing", version: "1.2.3" },
            staged: { kind: "absent" },
            running: { kind: "absent" },
          },
          nowIso: "2026-01-01T00:04:00.000Z",
        },
      },
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(outcome.record.phase).toBe("failed");
    expect(outcome.record.execution).toBe("terminal");
    expect(outcome.record.error?.code).toBe("recovery-evidence-contradiction");
  });

  it("terminalizes failed when neither installed nor staged evidence can authorize a continuation", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "recover-insufficient");
    const created = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(created.kind).toBe("committed");
    if (created.kind !== "committed") return;

    const outcome = await commitExecutorOnlyAttemptMutation({
      handle,
      intent: {
        kind: "recover",
        recovery: {
          expected: created.identity,
          action: "force",
          requestedTargetVersion: "1.2.3",
          evidence: {
            installed: { kind: "absent" },
            staged: { kind: "absent" },
            running: { kind: "absent" },
          },
          nowIso: "2026-01-01T00:04:00.000Z",
        },
      },
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(outcome.record.phase).toBe("failed");
    expect(outcome.record.error?.code).toBe("recovery-evidence-insufficient");
  });

  it("rejects intent-not-legal for a plain `recover` intent when the pure decision would be supersede - target-change recovery must travel through `supersede`'s optional `recovery` field instead", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "recover-refuses-supersede");
    const created = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(created.kind).toBe("committed");
    if (created.kind !== "committed") return;
    const before = await readFile(updateAttemptRecordPath(dir), "utf8");

    const outcome = await commitExecutorOnlyAttemptMutation({
      handle,
      intent: {
        kind: "recover",
        recovery: {
          expected: created.identity,
          action: "force",
          requestedTargetVersion: "9.9.9",
          evidence: {
            installed: { kind: "absent" },
            staged: { kind: "absent" },
            running: { kind: "absent" },
          },
          nowIso: "2026-01-01T00:04:00.000Z",
        },
      },
    });
    expect(outcome).toMatchObject({
      kind: "rejected",
      reason: "intent-not-legal",
    });
    expect(await readFile(updateAttemptRecordPath(dir), "utf8")).toBe(before);
  });

  it("supersedes the interrupted attempt through `supersede`'s optional `recovery` field when the requested target has changed, and a separate create then lands the new target", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "recover-supersede");
    const created = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(created.kind).toBe("committed");
    if (created.kind !== "committed") return;

    const supersede = await commitExecutorOnlyAttemptMutation({
      handle,
      intent: {
        kind: "supersede",
        request: baseCreateRequest({
          action: "force",
          targetVersion: "9.9.9",
          expected: created.identity,
        }),
        recovery: {
          expected: created.identity,
          action: "force",
          requestedTargetVersion: "9.9.9",
          evidence: {
            installed: { kind: "absent" },
            staged: { kind: "absent" },
            running: { kind: "absent" },
          },
          nowIso: "2026-01-01T00:04:00.000Z",
        },
      },
    });
    expect(supersede.kind).toBe("committed");
    if (supersede.kind !== "committed") return;
    expect(supersede.record.attemptId).toBe(created.identity.attemptId);
    expect(supersede.record.phase).toBe("superseded");
    expect(supersede.record.execution).toBe("terminal");
    expect(supersede.record.recovery).toMatchObject({
      recoveredBy: "attempt-executor",
      outcome: "superseded",
    });

    // Recovery never mints the new target's record itself - that stays the
    // existing, separately authorized `create` intent (two durable writes).
    const create = await commitAttemptMutation({
      handle,
      intent: {
        kind: "create",
        request: baseCreateRequest({
          targetVersion: "9.9.9",
          newAttemptId: "attempt-2",
        }),
      },
    });
    expect(create.kind).toBe("committed");
    if (create.kind === "committed") {
      expect(create.record.attemptId).toBe("attempt-2");
      expect(create.record.targetVersion).toBe("9.9.9");
    }
  });

  it("rejects intent-not-legal for a `supersede` intent whose `recovery` field disagrees with `request` on target or action", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "recover-supersede-mismatch");
    const created = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(created.kind).toBe("committed");
    if (created.kind !== "committed") return;
    const before = await readFile(updateAttemptRecordPath(dir), "utf8");

    const targetMismatch = await commitExecutorOnlyAttemptMutation({
      handle,
      intent: {
        kind: "supersede",
        request: baseCreateRequest({
          action: "force",
          targetVersion: "9.9.9",
          expected: created.identity,
        }),
        recovery: {
          expected: created.identity,
          action: "force",
          // Disagrees with the request's targetVersion above.
          requestedTargetVersion: "1.2.3",
          evidence: {
            installed: { kind: "absent" },
            staged: { kind: "absent" },
            running: { kind: "absent" },
          },
          nowIso: "2026-01-01T00:04:00.000Z",
        },
      },
    });
    expect(targetMismatch).toMatchObject({
      kind: "rejected",
      reason: "intent-not-legal",
    });

    const actionMismatch = await commitExecutorOnlyAttemptMutation({
      handle,
      intent: {
        kind: "supersede",
        request: baseCreateRequest({
          action: "force",
          targetVersion: "9.9.9",
          expected: created.identity,
        }),
        recovery: {
          expected: created.identity,
          // Disagrees with the request's action above.
          action: "activate",
          requestedTargetVersion: "9.9.9",
          evidence: {
            installed: { kind: "absent" },
            staged: { kind: "absent" },
            running: { kind: "absent" },
          },
          nowIso: "2026-01-01T00:04:00.000Z",
        },
      },
    });
    expect(actionMismatch).toMatchObject({
      kind: "rejected",
      reason: "intent-not-legal",
    });
    expect(await readFile(updateAttemptRecordPath(dir), "utf8")).toBe(before);
  });

  it("rejects intent-not-legal (identity-mismatch) when the recovery request names a stale identity", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "recover-identity-mismatch");
    const created = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(created.kind).toBe("committed");
    if (created.kind !== "committed") return;
    const before = await readFile(updateAttemptRecordPath(dir), "utf8");

    const outcome = await commitExecutorOnlyAttemptMutation({
      handle,
      intent: {
        kind: "recover",
        recovery: {
          expected: {
            attemptId: "some-other-attempt",
            generation: 1,
            sequence: 1,
          },
          action: "force",
          requestedTargetVersion: "1.2.3",
          evidence: {
            installed: { kind: "absent" },
            staged: { kind: "absent" },
            running: { kind: "absent" },
          },
          nowIso: "2026-01-01T00:04:00.000Z",
        },
      },
    });
    expect(outcome).toMatchObject({
      kind: "rejected",
      reason: "intent-not-legal",
    });
    expect(await readFile(updateAttemptRecordPath(dir), "utf8")).toBe(before);
  });

  it("rejects intent-not-legal (record-not-recoverable) when the record is parked, not active", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "recover-not-active");
    const created = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(created.kind).toBe("committed");
    if (created.kind !== "committed") return;
    const parked = await commitAttemptMutation({
      handle,
      intent: {
        kind: "advance",
        held: created.identity,
        advance: {
          phase: "waiting-for-work",
          continuation: "resume-apply",
          progress: null,
          error: null,
          nowIso: "2026-01-01T00:01:00.000Z",
        },
      },
    });
    expect(parked.kind).toBe("committed");
    if (parked.kind !== "committed") return;

    const outcome = await commitExecutorOnlyAttemptMutation({
      handle,
      intent: {
        kind: "recover",
        recovery: {
          expected: parked.identity,
          action: "force",
          requestedTargetVersion: "1.2.3",
          evidence: {
            installed: { kind: "absent" },
            staged: { kind: "absent" },
            running: { kind: "absent" },
          },
          nowIso: "2026-01-01T00:04:00.000Z",
        },
      },
    });
    expect(outcome).toMatchObject({
      kind: "rejected",
      reason: "intent-not-legal",
    });
  });

  it("rejects intent-invalid when evidence is malformed before touching disk", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "recover-invalid-evidence");
    const created = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(created.kind).toBe("committed");
    if (created.kind !== "committed") return;
    const before = await readFile(updateAttemptRecordPath(dir), "utf8");

    const outcome = await commitExecutorOnlyAttemptMutation({
      handle,
      intent: {
        kind: "recover",
        recovery: {
          expected: created.identity,
          action: "force",
          requestedTargetVersion: "1.2.3",
          // `unreadable` on any leg is normalize-legal (it is a defined
          // evidence kind); an outright malformed shape is what must fail
          // BEFORE the transition runs.
          evidence: {
            installed: { kind: "not-a-real-kind" } as never,
            staged: { kind: "absent" },
            running: { kind: "absent" },
          },
          nowIso: "2026-01-01T00:04:00.000Z",
        },
      },
    });
    expect(outcome).toMatchObject({
      kind: "rejected",
      reason: "intent-invalid",
    });
    expect(await readFile(updateAttemptRecordPath(dir), "utf8")).toBe(before);
  });

  it("refuses record-fail-closed (never fabricating recovery) when the record is unreadable evidence rather than active", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "recover-fail-closed");
    await writeFile(
      updateAttemptRecordPath(dir),
      '{"schemaVersion":2,"attemptId":"a"',
    );

    const outcome = await commitExecutorOnlyAttemptMutation({
      handle,
      intent: {
        kind: "recover",
        recovery: {
          expected: { attemptId: "a", generation: 1, sequence: 1 },
          action: "force",
          requestedTargetVersion: "1.2.3",
          evidence: {
            installed: { kind: "absent" },
            staged: { kind: "absent" },
            running: { kind: "absent" },
          },
          nowIso: "2026-01-01T00:04:00.000Z",
        },
      },
    });
    expect(outcome).toMatchObject({
      kind: "rejected",
      reason: "record-fail-closed",
    });
  });

  // The generation/sequence-ceiling `counter-exhausted` refusal is exercised
  // directly against the pure `decideAttemptRecovery` core in
  // transition.test.ts (constructing a record at
  // `Number.MAX_SAFE_INTEGER` here would require driving thousands of real
  // commits through the filesystem). This test instead confirms the
  // persistence boundary commits a legal, non-ceiling recovery end to end,
  // so the ceiling behaviour proven in isolation is not testing a path the
  // store never reaches.
  it("commits a legal recovery end to end through the persistence boundary", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "recover-persistence-boundary");
    const created = await commitAttemptMutation({
      handle,
      intent: {
        kind: "create",
        request: baseCreateRequest({}),
      },
    });
    expect(created.kind).toBe("committed");
    if (created.kind !== "committed") return;

    const outcome = await commitExecutorOnlyAttemptMutation({
      handle,
      intent: {
        kind: "recover",
        recovery: {
          expected: created.identity,
          action: "force",
          requestedTargetVersion: "1.2.3",
          evidence: {
            installed: { kind: "verified", version: "1.2.3" },
            staged: { kind: "absent" },
            running: {
              kind: "verified",
              version: "1.2.3",
              owner: "host-home-bound",
            },
          },
          nowIso: "2026-01-01T00:04:00.000Z",
        },
      },
    });
    expect(outcome.kind).toBe("committed");
  });
});

// Ticket 03 final-authority cold review, P0 (class swept to its full shape):
// the public `commitAttemptMutation` channel must refuse `recover`, `advance`
// to `complete`, and `supersede` carrying a `recovery` field - never routing
// any of the three into recovery/completion business logic - even when a
// caller manufactures the intent through a type cast, a JS boundary, or a
// parsed/deserialized object. `PublicAttemptMutationIntent` excludes all
// three at the type level; `commitAttemptMutationInternal`'s
// `isExecutorOnlyMutationIntent` guard excludes them again at runtime, before
// any lease is taken or any read happens.
describe("commitAttemptMutation - executor-only intents (recover / advance-to-complete / supersede-with-recovery) are refused, not routed to business logic", () => {
  // Types disappear at the JavaScript boundary - the guard under test exists
  // precisely because a JS caller, a plugin, or a parsed/deserialized object
  // can hand `commitAttemptMutation` a shape typed code never could. Rather
  // than a type assertion the compiler would reject outright (`recover` and
  // `PublicAttemptMutationIntent` share no overlapping member), this builds
  // the forced value through property assignment the same way that boundary
  // is actually crossed at runtime.
  function forcedIntent(
    intent: ExecutorOnlyAttemptMutationIntent,
  ): PublicAttemptMutationIntent {
    const forced = {} as PublicAttemptMutationIntent;
    for (const [key, value] of Object.entries(intent)) {
      Object.defineProperty(forced, key, {
        value,
        enumerable: true,
        configurable: true,
      });
    }
    return forced;
  }

  // Byte-unchanged is necessary but not sufficient: a commit that opens the
  // canonical record, re-derives an identical record, and renames it back
  // over itself would also leave the bytes unchanged, yet would prove the
  // guard runs AFTER a read/write rather than before one - the opposite of
  // "no lease is taken or any read happens" above. This wraps a forced call
  // with the existing record-open/rename test seams so each runtime case
  // proves zero canonical opens and zero renames, matching the production
  // guard firing before `commitAttemptMutationInternal`'s lease/read at all.
  async function commitWithNoCanonicalIo(
    options: Parameters<typeof commitAttemptMutation>[0],
  ): Promise<AttemptCommitOutcome> {
    let opens = 0;
    let renames = 0;
    __setBeforeRecordOpenHookForTest(async () => {
      opens += 1;
    });
    __setBeforeRecordRenameHookForTest(async () => {
      renames += 1;
    });
    const outcome = await commitAttemptMutation(options);
    // Clear before the caller's post-check read, so that read - and
    // whatever the test does next - is never itself observed by a hook
    // still armed from this call.
    __setBeforeRecordOpenHookForTest(null);
    __setBeforeRecordRenameHookForTest(null);
    expect(opens).toBe(0);
    expect(renames).toBe(0);
    return outcome;
  }

  it("compile-time: does not accept a `recover` intent literal", () => {
    const onlyTypeChecked = (handle: UpdateAttemptLockHandle): void => {
      void commitAttemptMutation({
        handle,
        intent: {
          // @ts-expect-error `recover` is excluded from PublicAttemptMutationIntent.
          kind: "recover",
          recovery: {
            expected: { attemptId: "a", generation: 1, sequence: 1 },
            action: "force",
            requestedTargetVersion: "1.2.3",
            evidence: {
              installed: { kind: "absent" },
              staged: { kind: "absent" },
              running: { kind: "absent" },
            },
            nowIso: "2026-01-01T00:00:00.000Z",
          },
        },
      });
    };
    void onlyTypeChecked;
    expect(true).toBe(true);
  });

  it("compile-time: does not accept an `advance` intent whose phase is `complete`", () => {
    const onlyTypeChecked = (handle: UpdateAttemptLockHandle): void => {
      void commitAttemptMutation({
        handle,
        intent: {
          kind: "advance",
          held: { attemptId: "a", generation: 1, sequence: 1 },
          advance: {
            // @ts-expect-error `complete` is excluded from the public `advance` phase union.
            phase: "complete",
            continuation: null,
            progress: null,
            error: null,
            nowIso: "2026-01-01T00:00:00.000Z",
          },
        },
      });
    };
    void onlyTypeChecked;
    expect(true).toBe(true);
  });

  it("compile-time: does not accept a `supersede` intent carrying a `recovery` field", () => {
    const onlyTypeChecked = (
      handle: UpdateAttemptLockHandle,
      request: AttemptClaimRequest,
    ): void => {
      void commitAttemptMutation({
        handle,
        intent: {
          kind: "supersede",
          request,
          // @ts-expect-error `recovery` is excluded from the public `supersede` intent.
          recovery: {
            expected: { attemptId: "a", generation: 1, sequence: 1 },
            action: "force",
            requestedTargetVersion: "1.2.3",
            evidence: {
              installed: { kind: "absent" },
              staged: { kind: "absent" },
              running: { kind: "absent" },
            },
            nowIso: "2026-01-01T00:00:00.000Z",
          },
        },
      });
    };
    void onlyTypeChecked;
    expect(true).toBe(true);
  });

  it("runtime: refuses a structural `recover` intent forced past the type boundary - no read, no write", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "public-refuses-recover");
    const created = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(created.kind).toBe("committed");
    if (created.kind !== "committed") return;
    const before = await readFile(updateAttemptRecordPath(dir), "utf8");

    const outcome = await commitWithNoCanonicalIo({
      handle,
      intent: forcedIntent({
        kind: "recover",
        recovery: {
          expected: created.identity,
          action: "force",
          requestedTargetVersion: "1.2.3",
          evidence: {
            installed: { kind: "verified", version: "1.2.3" },
            staged: { kind: "absent" },
            running: {
              kind: "verified",
              version: "1.2.3",
              owner: "host-home-bound",
            },
          },
          nowIso: "2026-01-01T00:04:00.000Z",
        },
      }),
    });

    expect(outcome).toMatchObject({
      kind: "rejected",
      reason: "intent-not-legal",
    });
    expect(await readFile(updateAttemptRecordPath(dir), "utf8")).toBe(before);
  });

  it("runtime: refuses a structural `advance` intent to `complete` forced past the type boundary", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "public-refuses-advance-complete");
    const created = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(created.kind).toBe("committed");
    if (created.kind !== "committed") return;
    const before = await readFile(updateAttemptRecordPath(dir), "utf8");

    const outcome = await commitWithNoCanonicalIo({
      handle,
      intent: forcedIntent({
        kind: "advance",
        held: created.identity,
        advance: {
          phase: "complete",
          continuation: null,
          progress: null,
          error: null,
          nowIso: "2026-01-01T00:04:00.000Z",
        },
      }),
    });

    expect(outcome).toMatchObject({
      kind: "rejected",
      reason: "intent-not-legal",
    });
    expect(await readFile(updateAttemptRecordPath(dir), "utf8")).toBe(before);
  });

  it("runtime: refuses a structural `supersede` intent carrying a `recovery` field forced past the type boundary - the exact public-barrel-only reproduction shape from the final-authority cold review", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(
      dir,
      "public-refuses-supersede-recovery",
    );
    const created = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(created.kind).toBe("committed");
    if (created.kind !== "committed") return;
    const before = await readFile(updateAttemptRecordPath(dir), "utf8");

    const outcome = await commitWithNoCanonicalIo({
      handle,
      intent: forcedIntent({
        kind: "supersede",
        request: baseCreateRequest({
          action: "force",
          targetVersion: "9.9.9",
          expected: created.identity,
        }),
        recovery: {
          expected: created.identity,
          action: "force",
          requestedTargetVersion: "9.9.9",
          evidence: {
            installed: { kind: "verified", version: "9.9.9" },
            staged: { kind: "absent" },
            running: {
              kind: "verified",
              version: "9.9.9",
              owner: "host-home-bound",
            },
          },
          nowIso: "2026-01-01T00:04:00.000Z",
        },
      }),
    });

    expect(outcome).toMatchObject({
      kind: "rejected",
      reason: "intent-not-legal",
    });
    expect(await readFile(updateAttemptRecordPath(dir), "utf8")).toBe(before);
  });
});

describe("commitAttemptMutation - handle authority", () => {
  it("rejects a released handle's stale write, and the newer bytes on disk are untouched", async () => {
    const dir = await freshDir();

    const handle1 = await acquireHandle(dir, "segment-1");
    const commit1 = await commitAttemptMutation({
      handle: handle1,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(commit1.kind).toBe("committed");
    if (commit1.kind !== "committed") return;
    const identity1 = commit1.identity;

    await handle1.release();

    const handle2 = await acquireHandle(dir, "segment-2");
    const commit2 = await commitAttemptMutation({
      handle: handle2,
      intent: {
        kind: "advance",
        held: identity1,
        advance: {
          phase: "preparing",
          continuation: null,
          progress: null,
          error: null,
          nowIso: "2026-01-01T00:05:00.000Z",
        },
      },
    });
    expect(commit2.kind).toBe("committed");
    if (commit2.kind !== "committed") return;

    // The stale callback from segment 1 still closes over its cached
    // identity and runs after its handle was released.
    const staleCommit = await commitAttemptMutation({
      handle: handle1,
      intent: {
        kind: "advance",
        held: identity1,
        advance: {
          phase: "applying",
          continuation: null,
          progress: null,
          error: null,
          nowIso: "2026-01-01T00:06:00.000Z",
        },
      },
    });
    expect(staleCommit.kind).toBe("rejected");
    if (staleCommit.kind === "rejected") {
      expect(staleCommit.reason).toBe("handle-released");
    }

    const onDisk = await readUpdateAttemptRecord(dir);
    expect(onDisk.kind).toBe("valid");
    if (onDisk.kind === "valid") {
      expect(onDisk.value.phase).toBe("preparing");
      expect(onDisk.value.sequence).toBe(2);
    }
  });

  it("rejects a forged handle object that mimics an issued one, and nothing is written", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "real");

    const forged: UpdateAttemptLockHandle = {
      hostHomeDir: handle.hostHomeDir,
      path: handle.path,
      metadata: handle.metadata,
      release: () => Promise.resolve(),
    };

    const outcome = await commitAttemptMutation({
      handle: forged,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toBe("handle-not-issued");
    }
    await expect(stat(updateAttemptRecordPath(dir))).rejects.toThrow();
  });

  it("rejects lock-lost when the lock has been broken and re-acquired while the handle is still unreleased", async () => {
    const dir = await freshDir();
    const lockPath = updateAttemptLockPath(dir);

    const handle1 = await acquireHandle(dir, "segment-1");
    const commit1 = await commitAttemptMutation({
      handle: handle1,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(commit1.kind).toBe("committed");
    if (commit1.kind !== "committed") return;

    // Simulate another contender breaking and re-taking the lock without
    // handle1 ever being released.
    await rm(lockPath, { force: true });
    __resetHeldInProcessForTest();
    await acquireHandle(dir, "segment-2");

    const staleCommit = await commitAttemptMutation({
      handle: handle1,
      intent: {
        kind: "advance",
        held: commit1.identity,
        advance: {
          phase: "preparing",
          continuation: null,
          progress: null,
          error: null,
          nowIso: "2026-01-01T00:05:00.000Z",
        },
      },
    });
    expect(staleCommit.kind).toBe("rejected");
    if (staleCommit.kind === "rejected") {
      expect(staleCommit.reason).toBe("lock-lost");
    }

    const onDisk = await readUpdateAttemptRecord(dir);
    expect(onDisk.kind).toBe("valid");
    if (onDisk.kind === "valid") expect(onDisk.value.phase).toBe("downloading");
  });

  it("rejects record-fail-closed for corrupt bytes on disk, and the corrupt bytes survive", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "segment");
    await writeFile(
      updateAttemptRecordPath(dir),
      '{"schemaVersion":2,"attemptId":"a"',
    );

    const outcome = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toBe("record-fail-closed");
    }

    expect(await readFile(updateAttemptRecordPath(dir), "utf8")).toBe(
      '{"schemaVersion":2,"attemptId":"a"',
    );
  });
});

describe("commitAttemptMutation - release cannot overtake an in-flight commit", () => {
  it("release() stays pending across the rename barrier, and a fresh contender cannot acquire until the commit resolves", async () => {
    const dir = await freshDir();
    const lockPath = updateAttemptLockPath(dir);
    const handle = await acquireHandle(dir, "segment");

    const gate = deferred();
    let hookEntered = false;
    __setBeforeRecordRenameHookForTest(async () => {
      hookEntered = true;
      await gate.promise;
    });

    const commitPromise = commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    await waitUntil(() => hookEntered, 5_000);

    let released = false;
    const releasePromise = handle.release().then(() => {
      released = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(released).toBe(false);
      await expect(stat(lockPath)).resolves.toBeDefined();

      // A fresh contender must not be able to acquire - the old commit has
      // not finished its rename, and release() must not have removed the
      // lock out from under it. In this same process the in-process claim
      // (still held until release() actually completes) answers first with
      // `held-in-process`; a genuinely separate process would see `busy` -
      // either way, `acquired` must never happen here.
      const contender = await acquireUpdateAttemptLock({
        hostHomeDir: dir,
        reason: "contender",
        waitMs: 0,
        pollIntervalMs: 25,
      });
      expect(contender.kind).not.toBe("acquired");
    } finally {
      gate.resolve();
    }
    const commitOutcome = await commitPromise;
    expect(commitOutcome.kind).toBe("committed");
    await releasePromise;
    expect(released).toBe(true);
    await expect(stat(lockPath)).rejects.toThrow();

    const freshAcquire = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "fresh",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(freshAcquire.kind).toBe("acquired");
    if (freshAcquire.kind === "acquired") handles.push(freshAcquire.handle);
  });
});

describe("pruneTerminalAttemptRecord - release cannot overtake an in-flight prune", () => {
  async function terminalRecord(
    handle: UpdateAttemptLockHandle,
  ): Promise<HostUpdateAttemptIdentity> {
    await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    const outcome = await commitAttemptMutation({
      handle,
      intent: {
        kind: "advance",
        held: { attemptId: "attempt-1", generation: 1, sequence: 1 },
        advance: {
          phase: "failed",
          continuation: null,
          progress: null,
          error: { code: "x", message: "y", phase: "downloading" },
          nowIso: "2020-01-01T00:00:00.000Z",
        },
      },
    });
    if (outcome.kind !== "committed") throw new Error("expected committed");
    return outcome.identity;
  }

  it("release() stays pending across the unlink barrier, and a fresh contender cannot acquire until the prune resolves", async () => {
    const dir = await freshDir();
    const lockPath = updateAttemptLockPath(dir);
    const handle = await acquireHandle(dir, "segment");
    const identity = await terminalRecord(handle);

    const gate = deferred();
    let hookEntered = false;
    __setBeforeRecordRemoveHookForTest(async () => {
      hookEntered = true;
      await gate.promise;
    });

    const prunePromise = pruneTerminalAttemptRecord({
      handle,
      expected: identity,
      nowMs: Date.parse("2026-02-01T00:00:00.000Z"),
    });
    await waitUntil(() => hookEntered, 5_000);

    let released = false;
    const releasePromise = handle.release().then(() => {
      released = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(released).toBe(false);
      await expect(stat(lockPath)).resolves.toBeDefined();

      // See the rename-barrier test above for why `held-in-process` (not
      // `busy`) is the expected same-process outcome; either way `acquired`
      // must never happen while the old prune is still able to unlink.
      const contender = await acquireUpdateAttemptLock({
        hostHomeDir: dir,
        reason: "contender",
        waitMs: 0,
        pollIntervalMs: 25,
      });
      expect(contender.kind).not.toBe("acquired");
    } finally {
      gate.resolve();
    }
    const pruneOutcome = await prunePromise;
    expect(pruneOutcome.kind).toBe("pruned");
    await releasePromise;
    expect(released).toBe(true);
    await expect(stat(lockPath)).rejects.toThrow();

    const freshAcquire = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "fresh",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(freshAcquire.kind).toBe("acquired");
    if (freshAcquire.kind === "acquired") handles.push(freshAcquire.handle);
  });
});

describe("commitAttemptMutation - durability", () => {
  it.skipIf(process.platform === "win32")(
    "returns durability-unverified with a fresh canonical read when the directory OPEN fails for a real reason (EIO at sync stage)",
    async () => {
      const dir = await freshDir();
      const handle = await acquireHandle(dir, "segment");

      __setDirectorySyncHookForTest((_dir, stage) => {
        if (stage === "open") return Promise.resolve();
        const err = new Error("boom");
        Object.assign(err, { code: "EIO" });
        return Promise.reject(err);
      });

      const outcome = await commitAttemptMutation({
        handle,
        intent: { kind: "create", request: baseCreateRequest({}) },
      });
      expect(outcome.kind).toBe("durability-unverified");
      if (outcome.kind === "durability-unverified") {
        expect(outcome.cause).toBe("EIO");
        // The bytes ARE on disk - rename already happened - so a fresh
        // canonical read must see the new record, not the old absence.
        expect(outcome.canonical.kind).toBe("valid");
        if (outcome.canonical.kind === "valid") {
          expect(outcome.canonical.value.attemptId).toBe("attempt-1");
        }
      }
    },
  );

  it.each(["EACCES", "EPERM"])(
    "classifies a directory OPEN failure (%s) as durability-unverified, never committed - an access failure proves nothing about fsync support",
    async (code) => {
      const dir = await freshDir();
      const handle = await acquireHandle(dir, "segment");

      __setDirectorySyncHookForTest((_dir, stage) => {
        if (stage !== "open") return Promise.resolve();
        const err = new Error("no access");
        Object.assign(err, { code });
        return Promise.reject(err);
      });

      const outcome = await commitAttemptMutation({
        handle,
        intent: { kind: "create", request: baseCreateRequest({}) },
      });
      expect(outcome.kind).toBe("durability-unverified");
      if (outcome.kind === "durability-unverified") {
        expect(outcome.cause).toBe(code);
        expect(outcome.canonical.kind).toBe("valid");
      }
    },
  );

  it.each(["EINVAL", "ENOTSUP", "EOPNOTSUPP"])(
    "treats a positively-known unsupported directory-sync error (%s) at the SYNC stage as committed",
    async (code) => {
      const dir = await freshDir();
      const handle = await acquireHandle(dir, "segment");

      __setDirectorySyncHookForTest((_dir, stage) => {
        if (stage === "open") return Promise.resolve();
        const err = new Error("not supported here");
        Object.assign(err, { code });
        return Promise.reject(err);
      });

      const outcome = await commitAttemptMutation({
        handle,
        intent: { kind: "create", request: baseCreateRequest({}) },
      });
      expect(outcome.kind).toBe("committed");
    },
  );

  it.skipIf(
    process.platform === "win32" ||
      (typeof process.getuid === "function" && process.getuid() === 0),
  )(
    "classifies a REAL EACCES from an execute/write-only host home directory as durability-unverified, never committed",
    async () => {
      const dir = await freshDir();
      const handle = await acquireHandle(dir, "segment");

      // Execute+write, no read: creating/renaming known child paths still
      // works (that only needs the execute+write bits), but `open(dir,
      // O_RDONLY)` needs the read bit and genuinely fails EACCES.
      await chmod(dir, 0o300);

      const outcome = await commitAttemptMutation({
        handle,
        intent: { kind: "create", request: baseCreateRequest({}) },
      });
      expect(outcome.kind).toBe("durability-unverified");
    },
  );
});

describe("readUpdateAttemptRecord - missing Node flag fallback", () => {
  it.skipIf(process.platform === "win32")(
    "keeps Linux absence/create/regular-file reads working when both safe flags are unavailable",
    async () => {
      __setRecordOpenPlatformForTest({ noFollow: 0, nonBlock: 0 });
      const dir = await freshDir();

      await expect(readUpdateAttemptRecord(dir)).resolves.toEqual({
        kind: "absent",
      });

      const handle = await acquireHandle(dir, "missing-flag-fallback");
      const committed = await commitAttemptMutation({
        handle,
        intent: { kind: "create", request: baseCreateRequest({}) },
      });
      expect(committed.kind).toBe("committed");

      const read = await readUpdateAttemptRecord(dir);
      expect(read.kind).toBe("valid");
      if (read.kind === "valid") {
        expect(read.value.attemptId).toBe("attempt-1");
        expect(read.value.targetVersion).toBe("1.2.3");
      }

      const recordPath = updateAttemptRecordPath(dir);
      const swappedTarget = join(dir, "swapped-target.json");
      await writeFile(swappedTarget, await readFile(recordPath, "utf8"));
      __setBeforeRecordOpenHookForTest(async () => {
        await rm(recordPath, { force: true });
        await symlink(swappedTarget, recordPath);
      });
      await expect(readUpdateAttemptRecord(dir)).resolves.toEqual({
        kind: "unreadable",
        cause: "attempt-record-is-symlink",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed for a symlink, a non-regular entry, and ambiguous file identity on the forced fallback",
    async () => {
      __setRecordOpenPlatformForTest({ noFollow: 0, nonBlock: 0 });

      const symlinkDir = await freshDir();
      const symlinkPath = updateAttemptRecordPath(symlinkDir);
      await writeFile(join(symlinkDir, "target.json"), "{}\n");
      await symlink(join(symlinkDir, "target.json"), symlinkPath);
      await expect(readUpdateAttemptRecord(symlinkDir)).resolves.toEqual({
        kind: "unreadable",
        cause: "attempt-record-is-symlink",
      });

      const specialDir = await freshDir();
      await mkdir(updateAttemptRecordPath(specialDir));
      await expect(readUpdateAttemptRecord(specialDir)).resolves.toEqual({
        kind: "unreadable",
        cause: "attempt-record-not-a-regular-file",
      });

      expect(
        __sameRecordFileIdentityForTest(
          { ino: 0, dev: 0 },
          { ino: 17, dev: 4 },
        ),
      ).toBe(false);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "forces the Node/Electron fallback on Windows and proves absent/create/regular, reparse, and identity ambiguity outcomes",
    async () => {
      __setRecordOpenPlatformForTest({ noFollow: 0, nonBlock: 0 });
      const dir = await freshDir();

      await expect(readUpdateAttemptRecord(dir)).resolves.toEqual({
        kind: "absent",
      });
      const handle = await acquireHandle(dir, "windows-missing-flag-fallback");
      const committed = await commitAttemptMutation({
        handle,
        intent: { kind: "create", request: baseCreateRequest({}) },
      });
      expect(committed.kind).toBe("committed");
      const regular = await readUpdateAttemptRecord(dir);
      expect(regular.kind).toBe("valid");

      const recordPath = updateAttemptRecordPath(dir);
      const swappedTarget = join(dir, "swapped-target.json");
      await writeFile(swappedTarget, await readFile(recordPath, "utf8"));
      __setBeforeRecordOpenHookForTest(async () => {
        await rm(recordPath, { force: true });
        await symlink(swappedTarget, recordPath);
      });
      await expect(readUpdateAttemptRecord(dir)).resolves.toEqual({
        kind: "unreadable",
        cause: "attempt-record-is-symlink",
      });
      __setBeforeRecordOpenHookForTest(null);

      const linkDir = await freshDir();
      const linkPath = updateAttemptRecordPath(linkDir);
      const targetPath = join(linkDir, "target.json");
      await writeFile(targetPath, "{}\n");
      await symlink(targetPath, linkPath);
      await expect(readUpdateAttemptRecord(linkDir)).resolves.toEqual({
        kind: "unreadable",
        cause: "attempt-record-is-symlink",
      });

      const specialDir = await freshDir();
      await mkdir(updateAttemptRecordPath(specialDir));
      await expect(readUpdateAttemptRecord(specialDir)).resolves.toEqual({
        kind: "unreadable",
        cause: "attempt-record-not-a-regular-file",
      });
      expect(
        __sameRecordFileIdentityForTest(
          { ino: 0, dev: 0 },
          { ino: 17, dev: 4 },
        ),
      ).toBe(false);
    },
  );
});

describe("readUpdateAttemptRecord - symlink TOCTOU on read", () => {
  it.skipIf(process.platform === "win32")(
    "reads a symlink swapped into the record path exactly at open as unreadable, never following it",
    async () => {
      const dir = await freshDir();
      const recordPath = updateAttemptRecordPath(dir);
      const targetPath = join(dir, "elsewhere.json");
      const handle = await acquireHandle(dir, "segment");
      await commitAttemptMutation({
        handle,
        intent: { kind: "create", request: baseCreateRequest({}) },
      });
      const originalBytes = await readFile(recordPath, "utf8");
      await writeFile(targetPath, originalBytes);

      __setBeforeRecordOpenHookForTest(async () => {
        await rm(recordPath, { force: true });
        await symlink(targetPath, recordPath);
      });

      const read = await readUpdateAttemptRecord(dir);
      expect(read).toEqual({
        kind: "unreadable",
        cause: "attempt-record-is-symlink",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "reads a symlink already present before the read as unreadable, never following it",
    async () => {
      const dir = await freshDir();
      const recordPath = updateAttemptRecordPath(dir);
      const targetPath = join(dir, "elsewhere.json");
      await writeFile(targetPath, '{"hello":"world"}');
      await symlink(targetPath, recordPath);

      const read = await readUpdateAttemptRecord(dir);
      expect(read).toEqual({
        kind: "unreadable",
        cause: "attempt-record-is-symlink",
      });
    },
  );
});

describe("readUpdateAttemptRecord - bounded read of a non-regular file", () => {
  it.skipIf(process.platform === "win32")(
    "does not block reading a FIFO placed at the record path, and classifies it as unreadable within a bounded time",
    async () => {
      const dir = await freshDir();
      const recordPath = updateAttemptRecordPath(dir);
      try {
        await execFileAsync("mkfifo", [recordPath]);
      } catch {
        // `mkfifo` unavailable on this platform/image - nothing to prove.
        return;
      }

      const start = Date.now();
      const read = await readUpdateAttemptRecord(dir);
      const elapsedMs = Date.now() - start;

      expect(read.kind).toBe("unreadable");
      // No writer was ever connected. A blocking open would never return;
      // this proves the read is total.
      expect(elapsedMs).toBeLessThan(2_000);
    },
    5_000,
  );
});

describe("__sameRecordFileIdentityForTest - Windows fallback identity abstraction", () => {
  it("fails closed when either side reports a zero inode", () => {
    expect(
      __sameRecordFileIdentityForTest({ ino: 0, dev: 5 }, { ino: 0, dev: 5 }),
    ).toBe(false);
    expect(
      __sameRecordFileIdentityForTest({ ino: 1, dev: 5 }, { ino: 0, dev: 5 }),
    ).toBe(false);
  });

  it("fails closed when either side reports a zero device", () => {
    expect(
      __sameRecordFileIdentityForTest({ ino: 1, dev: 0 }, { ino: 1, dev: 5 }),
    ).toBe(false);
    expect(
      __sameRecordFileIdentityForTest({ ino: 1, dev: 5 }, { ino: 1, dev: 0 }),
    ).toBe(false);
  });

  it("fails closed for mismatched positive identities", () => {
    expect(
      __sameRecordFileIdentityForTest({ ino: 1, dev: 2 }, { ino: 1, dev: 3 }),
    ).toBe(false);
    expect(
      __sameRecordFileIdentityForTest({ ino: 1, dev: 2 }, { ino: 9, dev: 2 }),
    ).toBe(false);
  });

  it("succeeds only for equal positive identities", () => {
    expect(
      __sameRecordFileIdentityForTest({ ino: 7, dev: 3 }, { ino: 7, dev: 3 }),
    ).toBe(true);
  });
});

// Windows has no `O_NOFOLLOW`; `openRecordNoFollow` falls back to a
// pre-open `lstat` plus the identity check above. Both reparse-point races
// only exist on that fallback path, so these are Windows-only - they are
// present in source (and exercised in Windows CI) but skipped everywhere
// else, matching the existing POSIX symlink tests' inverse guard.
describe("readUpdateAttemptRecord - Windows reparse-point races (Windows fallback path only)", () => {
  it.skipIf(process.platform !== "win32")(
    "reads a reparse point already present before the read as unreadable, never following it",
    async () => {
      const dir = await freshDir();
      const recordPath = updateAttemptRecordPath(dir);
      const targetPath = join(dir, "elsewhere.json");
      await writeFile(targetPath, '{"hello":"world"}');
      await symlink(targetPath, recordPath);

      const read = await readUpdateAttemptRecord(dir);
      expect(read.kind).toBe("unreadable");
    },
  );

  it.skipIf(process.platform !== "win32")(
    "reads a reparse point swapped in exactly at open as unreadable, never following it",
    async () => {
      const dir = await freshDir();
      const recordPath = updateAttemptRecordPath(dir);
      const targetPath = join(dir, "elsewhere.json");
      const handle = await acquireHandle(dir, "segment");
      await commitAttemptMutation({
        handle,
        intent: { kind: "create", request: baseCreateRequest({}) },
      });
      const originalBytes = await readFile(recordPath, "utf8");
      await writeFile(targetPath, originalBytes);

      __setBeforeRecordOpenHookForTest(async () => {
        await rm(recordPath, { force: true });
        await symlink(targetPath, recordPath);
      });

      const read = await readUpdateAttemptRecord(dir);
      expect(read.kind).toBe("unreadable");
    },
  );
});

describe("pruneTerminalAttemptRecord", () => {
  async function terminalRecord(
    handle: UpdateAttemptLockHandle,
    completedAtIso: string,
  ): Promise<HostUpdateAttemptIdentity> {
    await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    const outcome = await commitAttemptMutation({
      handle,
      intent: {
        kind: "advance",
        held: { attemptId: "attempt-1", generation: 1, sequence: 1 },
        advance: {
          phase: "failed",
          continuation: null,
          progress: null,
          error: { code: "x", message: "y", phase: "downloading" },
          nowIso: completedAtIso,
        },
      },
    });
    if (outcome.kind !== "committed") throw new Error("expected committed");
    return outcome.identity;
  }

  it("rejects not-terminal and leaves the file present", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "segment");
    const commit = await commitAttemptMutation({
      handle,
      intent: { kind: "create", request: baseCreateRequest({}) },
    });
    expect(commit.kind).toBe("committed");
    if (commit.kind !== "committed") return;

    const outcome = await pruneTerminalAttemptRecord({
      handle,
      expected: commit.identity,
      nowMs: Date.parse("2026-02-01T00:00:00.000Z"),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected")
      expect(outcome.reason).toBe("not-terminal");
    await expect(stat(updateAttemptRecordPath(dir))).resolves.toBeDefined();
  });

  it.each([
    ["at the exact completion time", 0],
    ["before the seven-day retention boundary", 6 * 24 * 60 * 60 * 1000],
  ] as const)(
    "rejects not-expired %s and leaves the file present",
    async (_label, elapsedMs) => {
      const dir = await freshDir();
      const handle = await acquireHandle(dir, "segment");
      const completedAtMs = Date.parse("2026-01-01T00:00:00.000Z");
      const identity = await terminalRecord(
        handle,
        new Date(completedAtMs).toISOString(),
      );

      const onDisk = await readUpdateAttemptRecord(dir);
      expect(onDisk.kind).toBe("valid");
      if (onDisk.kind === "valid") {
        expect(onDisk.value.completedAt).toBe(
          new Date(completedAtMs).toISOString(),
        );
      }

      const outcome = await pruneTerminalAttemptRecord({
        handle,
        expected: identity,
        nowMs: completedAtMs + elapsedMs,
      });
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected")
        expect(outcome.reason).toBe("not-expired");
      await expect(stat(updateAttemptRecordPath(dir))).resolves.toBeDefined();
    },
  );

  it("does not expose retention policy as a writable public option", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "retention-api-shape");
    type PublicPruneOptions = Parameters<typeof pruneTerminalAttemptRecord>[0];
    type HasRetentionOption = "retentionMs" extends keyof PublicPruneOptions
      ? true
      : false;
    const hasRetentionOption: HasRetentionOption = false;

    const validOptions = {
      handle,
      expected: { attemptId: "attempt-1", generation: 1, sequence: 1 },
      nowMs: 0,
    } satisfies PublicPruneOptions;
    const negativeRetention: PublicPruneOptions = {
      ...validOptions,
      // @ts-expect-error retention policy is fixed by the store, not caller input
      retentionMs: -1,
    };
    const customRetention: PublicPruneOptions = {
      ...validOptions,
      // @ts-expect-error custom retention windows are not part of the public API
      retentionMs: 60_000,
    };
    void negativeRetention;
    void customRetention;
    expect(hasRetentionOption).toBe(false);
    expect(validOptions.nowMs).toBe(0);
  });

  it("prunes only after the fixed seven-day retention period", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "segment");
    const completedAtMs = Date.parse("2026-01-01T00:00:00.000Z");
    const identity = await terminalRecord(
      handle,
      new Date(completedAtMs).toISOString(),
    );

    const outcome = await pruneTerminalAttemptRecord({
      handle,
      expected: identity,
      nowMs: completedAtMs + TERMINAL_ATTEMPT_RETENTION_MS + 1,
    });
    expect(outcome.kind).toBe("pruned");
    await expect(stat(updateAttemptRecordPath(dir))).rejects.toThrow();
  });

  it("rejects expectation-mismatch and leaves the file present", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "segment");
    await terminalRecord(handle, "2026-01-01T00:00:00.000Z");

    const outcome = await pruneTerminalAttemptRecord({
      handle,
      expected: { attemptId: "some-other-attempt", generation: 1, sequence: 1 },
      nowMs: Date.parse("2026-02-01T00:00:00.000Z"),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toBe("expectation-mismatch");
    }
    await expect(stat(updateAttemptRecordPath(dir))).resolves.toBeDefined();
  });

  it("rejects handle-released and leaves the file present", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "segment");
    const identity = await terminalRecord(handle, "2020-01-01T00:00:00.000Z");
    await handle.release();

    const outcome = await pruneTerminalAttemptRecord({
      handle,
      expected: identity,
      nowMs: Date.parse("2026-02-01T00:00:00.000Z"),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toBe("handle-released");
    }
    await expect(stat(updateAttemptRecordPath(dir))).resolves.toBeDefined();
  });

  it("rejects a forged handle with handle-not-issued", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "segment");
    const identity = await terminalRecord(handle, "2020-01-01T00:00:00.000Z");

    const forged: UpdateAttemptLockHandle = {
      hostHomeDir: handle.hostHomeDir,
      path: handle.path,
      metadata: handle.metadata,
      release: () => Promise.resolve(),
    };

    const outcome = await pruneTerminalAttemptRecord({
      handle: forged,
      expected: identity,
      nowMs: Date.parse("2026-02-01T00:00:00.000Z"),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toBe("handle-not-issued");
    }
    await expect(stat(updateAttemptRecordPath(dir))).resolves.toBeDefined();
  });

  it("rejects lock-lost when the lock has been broken and re-acquired while the handle is still unreleased", async () => {
    const dir = await freshDir();
    const lockPath = updateAttemptLockPath(dir);
    const handle = await acquireHandle(dir, "segment");
    const identity = await terminalRecord(handle, "2020-01-01T00:00:00.000Z");

    await rm(lockPath, { force: true });
    __resetHeldInProcessForTest();
    await acquireHandle(dir, "segment-2");

    const outcome = await pruneTerminalAttemptRecord({
      handle,
      expected: identity,
      nowMs: Date.parse("2026-02-01T00:00:00.000Z"),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toBe("lock-lost");
    }
    await expect(stat(updateAttemptRecordPath(dir))).resolves.toBeDefined();
  });

  it("prunes only when terminal, expired, and identity-matching all hold", async () => {
    const dir = await freshDir();
    const handle = await acquireHandle(dir, "segment");
    const identity = await terminalRecord(handle, "2020-01-01T00:00:00.000Z");

    const outcome = await pruneTerminalAttemptRecord({
      handle,
      expected: identity,
      nowMs: Date.parse("2026-02-01T00:00:00.000Z"),
    });
    expect(outcome.kind).toBe("pruned");
    await expect(stat(updateAttemptRecordPath(dir))).rejects.toThrow();
  });
});

function assertNever(value: never): never {
  throw new Error(`unhandled mutation intent: ${String(value)}`);
}

function mutationIntentDescription(
  kind: AttemptMutationIntent["kind"],
): string {
  switch (kind) {
    case "create":
      return "create";
    case "resume":
      return "resume";
    case "supersede":
      return "supersede";
    case "advance":
      return "advance";
    case "recover":
      return "recover";
    default:
      return assertNever(kind);
  }
}

// This mapped type is deliberately exhaustive: adding an intent arm without
// updating the persistence tests becomes a compile error instead of silently
// leaving a new mutation untested.
describe("AttemptMutationIntent - exhaustive shape", () => {
  it("keeps every intent kind represented in the typed test map", () => {
    const kinds: {
      readonly [K in AttemptMutationIntent["kind"]]: K;
    } = {
      create: "create",
      resume: "resume",
      supersede: "supersede",
      advance: "advance",
      recover: "recover",
    };
    expect(Object.values(kinds).map(mutationIntentDescription).sort()).toEqual([
      "advance",
      "create",
      "recover",
      "resume",
      "supersede",
    ]);
  });
});
