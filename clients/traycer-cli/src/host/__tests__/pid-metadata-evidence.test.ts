import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `readHostPidMetadataEvidence` keeps an absent record apart from one that
// exists and cannot be read. The takeover's published-host gate refuses on
// the second and proceeds on the first, so the split is what this file pins;
// `readHostPidMetadata` must keep folding both into `null` for every
// discovery caller. The record path is redirected to a scratch directory so
// the real `~/.traycer` is never read.
const PATHS = vi.hoisted(() => ({ recordPath: "" }));
vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return {
    ...actual,
    hostPidMetadataPath: () => PATHS.recordPath,
  };
});

import {
  readHostPidMetadata,
  readHostPidMetadataEvidence,
} from "../pid-metadata";

const VALID_RECORD = {
  pid: 4242,
  hostId: "host-1",
  version: "1.2.3",
  websocketUrl: "ws://127.0.0.1:7100/rpc",
  startedAt: "2026-09-06T00:00:00.000Z",
};

describe("readHostPidMetadataEvidence", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "traycer-pid-metadata-"));
    PATHS.recordPath = join(dir, "pid.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a missing record as absent, and readHostPidMetadata as null", async () => {
    await expect(readHostPidMetadataEvidence("staging")).resolves.toEqual({
      kind: "absent",
    });
    await expect(readHostPidMetadata("staging")).resolves.toBeNull();
  });

  it("reads a torn or non-JSON record as unreadable, not absent", async () => {
    await writeFile(PATHS.recordPath, '{"pid": 42', "utf8");
    await expect(readHostPidMetadataEvidence("staging")).resolves.toEqual({
      kind: "unreadable",
      cause: "not valid JSON",
    });
    // Discovery callers keep the fold: unreadable is still `null` for them.
    await expect(readHostPidMetadata("staging")).resolves.toBeNull();
  });

  it("reads a JSON scalar and a record missing required fields as unreadable with distinct causes", async () => {
    await writeFile(PATHS.recordPath, "42", "utf8");
    await expect(readHostPidMetadataEvidence("staging")).resolves.toEqual({
      kind: "unreadable",
      cause: "not a JSON object",
    });
    await writeFile(
      PATHS.recordPath,
      JSON.stringify({ pid: 4242, hostId: "host-1" }),
      "utf8",
    );
    await expect(readHostPidMetadataEvidence("staging")).resolves.toEqual({
      kind: "unreadable",
      cause: "malformed record (required fields missing)",
    });
  });

  it("reads a valid record as read, with the same projection readHostPidMetadata returns", async () => {
    await writeFile(PATHS.recordPath, JSON.stringify(VALID_RECORD), "utf8");
    const evidence = await readHostPidMetadataEvidence("staging");
    expect(evidence.kind).toBe("read");
    if (evidence.kind !== "read") throw new Error("expected a read record");
    expect(evidence.metadata).toMatchObject({
      ...VALID_RECORD,
      processStartIdentity: null,
      layer0: null,
      layer0Slot: null,
    });
    await expect(readHostPidMetadata("staging")).resolves.toEqual(
      evidence.metadata,
    );
  });
});
