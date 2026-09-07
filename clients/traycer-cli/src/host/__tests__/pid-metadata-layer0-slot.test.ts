import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** pid.json `layer0Slot` is a cross-version contract with the host; renaming it breaks N-1. */
// Composed from `process` - a global needing no import - rather than `join(tmpdir(), ...)`: `vi.hoisted` runs BEFORE this file's imports are initialised, so referencing them here is a TDZ error.
const { FAKE_HOME } = vi.hoisted(() => ({
  FAKE_HOME: `${process.env["TMPDIR"] ?? "/tmp"}/traycer-cli-pid-layer0slot-test-home`,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => FAKE_HOME };
});

const { readHostPidMetadata } = await import("../pid-metadata");
const { hostPidMetadataPath } = await import("../../store/paths");

const BASE_RECORD = {
  pid: 4242,
  hostId: "host-4242",
  version: "1.2.3",
  websocketUrl: "ws://127.0.0.1:7100/rpc",
  startedAt: "2026-08-10T00:00:00.000Z",
};

async function writeRecord(record: Record<string, unknown>): Promise<void> {
  const path = hostPidMetadataPath(undefined);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(record), "utf8");
}

describe("pid.json layer0Slot cross-version tolerance", () => {
  beforeEach(async () => {
    await rm(FAKE_HOME, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(FAKE_HOME, { recursive: true, force: true });
  });

  it("OLD RECORD: an absent layer0Slot reads as not-recorded, never guaranteed", async () => {
    await writeRecord({ ...BASE_RECORD, layer0: null });

    const parsed = await readHostPidMetadata(undefined);
    expect(parsed).not.toBeNull();
    expect(parsed?.layer0Slot).toBeNull();
    // The rest of the record is untouched by the new field's absence.
    expect(parsed?.pid).toBe(4242);
    expect(parsed?.hostId).toBe("host-4242");
  });

  it("NEW RECORD: an unknown key alongside layer0Slot does not break the parse", async () => {
    await writeRecord({
      ...BASE_RECORD,
      layer0: { status: "acquired", attemptId: "host-4242" },
      layer0Slot: {
        status: "degraded",
        attemptId: "host-4242",
        cause: "addon-load-failed",
        evidence: "Cannot find module 'lifecycle_lock.node'",
      },
      // The stand-in for whatever a FUTURE host adds.
      // This reader has never heard of it, and that must stay a non-event - which is the same property that makes today's shipped readers safe against `layer0Slot`.
      someFutureFieldThisReaderHasNeverHeardOf: { anything: [1, 2, 3] },
    });

    const parsed = await readHostPidMetadata(undefined);
    expect(parsed).not.toBeNull();
    expect(parsed?.layer0).toEqual({
      status: "acquired",
      attemptId: "host-4242",
    });
    expect(parsed?.layer0Slot).toEqual({
      status: "degraded",
      attemptId: "host-4242",
      cause: "addon-load-failed",
      evidence: "Cannot find module 'lifecycle_lock.node'",
    });
    expect(parsed?.websocketUrl).toBe("ws://127.0.0.1:7100/rpc");
  });

  it("a malformed layer0Slot degrades to unrecognized rather than sinking the file", async () => {
    // Fail-open on shape, fail-closed on meaning: losing host discovery over a diagnostic field would be the worse trade, but an unreadable record must not read as healthy either.
    await writeRecord({
      ...BASE_RECORD,
      layer0: null,
      layer0Slot: { status: "who-knows" },
    });

    const parsed = await readHostPidMetadata(undefined);
    expect(parsed).not.toBeNull();
    expect(parsed?.layer0Slot).toMatchObject({ status: "unrecognized" });
  });
});
