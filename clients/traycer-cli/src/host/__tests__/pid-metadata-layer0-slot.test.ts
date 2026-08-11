import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The pid.json cross-version contract for `layer0Slot` (chat-sync-v2 ticket
 * 38).
 *
 * pid.json is written by the host and read by INDEPENDENTLY VERSIONED
 * processes - this CLI, and the desktop shell - so adding a key is a
 * compatibility question before it is a feature. Ticket 38's STOP condition
 * was "does any real reader strict-parse this file"; the answer was no (every
 * reader hand-picks its known fields and there is no zod schema anywhere), and
 * these are the two directions that answer has to keep being true in:
 *
 *   NEW record, OLD reader - an unknown key must be ignored, not rejected.
 *     Pinned by feeding a record carrying BOTH `layer0Slot` and a key no
 *     version of this reader has ever known, and asserting every known field
 *     still decodes. The old reader's field-picking is this one minus the
 *     `layer0Slot` line, so "extras are ignored" is precisely the property
 *     that makes it safe.
 *   OLD record, NEW reader - an absent key must read as "not recorded", never
 *     as "guaranteed".
 *
 * `homedir` is mocked because `HOST_HOME` is computed at module load from it,
 * so the temp dir has to be in place before `store/paths` is imported.
 */
// Composed from `process` - a global needing no import - rather than
// `join(tmpdir(), ...)`: `vi.hoisted` runs BEFORE this file's imports are
// initialised, so referencing them here is a TDZ error.
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
      // The stand-in for whatever a FUTURE host adds. This reader has never
      // heard of it, and that must stay a non-event - which is the same
      // property that makes today's shipped readers safe against `layer0Slot`.
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
    // Fail-open on shape, fail-closed on meaning: losing host discovery over a
    // diagnostic field would be the worse trade, but an unreadable record must
    // not read as healthy either.
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
