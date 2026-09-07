import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeBooleanSentinel } from "@traycer-clients/shared/host-lifecycle/durable/sentinel";
import { canonicalBooleanSentinelBytes } from "@traycer-clients/shared/host-lifecycle/durable/repair";
import type { BooleanSentinelRecord } from "@traycer-clients/shared/host-lifecycle/durable/sentinel";

/**
 * Writer ↔ reader pinning for the removed-by-user sentinel (macOS annex §2.1.1: "Reader and writer must be pinned to each other by a test that runs the *real writer* and feeds its.
 * A fixture the product cannot produce proves nothing about either.").
 */

let userDataDir = "";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => process.env.TRAYCER_TEST_USER_DATA ?? tmpdir()),
    isPackaged: false,
    getAppPath: vi.fn(() => "/tmp"),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const {
  __resetHostRemovalStateForTest,
  clearHostRemovedByUser,
  isHostRemovedByUser,
  markHostRemovedByUser,
} = await import("../host-removal-state");

const SENTINEL_FILE = "host-removal-state.json";

async function decodeWrittenSentinel(): Promise<{
  readonly bytes: string;
  readonly decoded: BooleanSentinelRecord;
  readonly decodedAsStopSentinel: BooleanSentinelRecord;
}> {
  const bytes = await readFile(join(userDataDir, SENTINEL_FILE), "utf8");
  return {
    bytes,
    decoded: decodeBooleanSentinel(
      { kind: "bytes", text: bytes },
      "removedByUser",
    ),
    decodedAsStopSentinel: decodeBooleanSentinel(
      { kind: "bytes", text: bytes },
      "stoppedByUser",
    ),
  };
}

describe("removed-by-user sentinel: real writer → lifecycle reader", () => {
  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), "traycer-removal-sentinel-"));
    process.env.TRAYCER_TEST_USER_DATA = userDataDir;
    __resetHostRemovalStateForTest();
  });

  afterEach(async () => {
    delete process.env.TRAYCER_TEST_USER_DATA;
    __resetHostRemovalStateForTest();
    await rm(userDataDir, { recursive: true, force: true });
  });

  // The blocker, stated as a test: this is the file a normal, working install
  // has on disk, and it must not read as a refusal to start.
  it("decodes the real `clearHostRemovedByUser` output as observed(false)", async () => {
    await clearHostRemovedByUser();
    const { bytes, decoded } = await decodeWrittenSentinel();

    // Show the shape that was previously unrecognised, so a future writer
    // change that renames the key fails here rather than silently in the field.
    expect(JSON.parse(bytes)).toEqual({ removedByUser: false });
    expect(decoded).toEqual({ kind: "observed", value: false });
  });

  it("decodes the real `markHostRemovedByUser` output as observed(true)", async () => {
    await markHostRemovedByUser();
    const { bytes, decoded } = await decodeWrittenSentinel();

    expect(JSON.parse(bytes)).toEqual({ removedByUser: true });
    expect(decoded).toEqual({ kind: "observed", value: true });
  });

  /** The keyed-decode rule, pinned by the real writer's bytes rather than a hand-built fixture. */
  it("does not decode as a stop-sentinel refusal when read at the wrong path", async () => {
    await markHostRemovedByUser();
    const { decoded, decodedAsStopSentinel } = await decodeWrittenSentinel();

    expect(decoded).toEqual({ kind: "observed", value: true });
    expect(decodedAsStopSentinel).toEqual({ kind: "corrupt" });
  });

  it("writes bytes the real shipped reader still understands", async () => {
    for (const value of [true, false]) {
      __resetHostRemovalStateForTest();
      await writeFile(
        join(userDataDir, SENTINEL_FILE),
        canonicalBooleanSentinelBytes("removed-by-user", value),
        "utf8",
      );

      // The shipped reader  -  the one `host-launch-converge`,
      // `host-health-respawn` and `host-login-item` all gate on.
      expect(await isHostRemovedByUser()).toBe(value);

      // …and the lifecycle reader agrees, so the two cannot drift apart.
      expect((await decodeWrittenSentinel()).decoded).toEqual({
        kind: "observed",
        value,
      });
    }
  });

  it("round-trips mark → clear, so both arms are reachable from the product", async () => {
    await markHostRemovedByUser();
    expect((await decodeWrittenSentinel()).decoded).toEqual({
      kind: "observed",
      value: true,
    });

    await clearHostRemovedByUser();
    expect((await decodeWrittenSentinel()).decoded).toEqual({
      kind: "observed",
      value: false,
    });
  });
});
