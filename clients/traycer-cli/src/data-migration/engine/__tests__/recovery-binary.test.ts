import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import {
  checkJournalSuccessor,
  migrationJournalSchema,
} from "@traycer/protocol/config/data-migration-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locateRecoveryBinaries } from "../recovery-binary";
import { sampleJournal } from "./engine-fixtures";

const ORIGINAL = Buffer.from("the original coordinator cli");
const NEWER = Buffer.from("a newer current cli");

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe.skipIf(process.platform === "win32")("locateRecoveryBinaries", () => {
  let base = "";
  let sourceRoot = "";
  let destinationRoot = "";

  beforeEach(async () => {
    base = await realpath(
      await mkdtemp(join(tmpdir(), "traycer-recovery-binary-")),
    );
    sourceRoot = join(base, "source");
    destinationRoot = join(base, "destination");
    await mkdir(sourceRoot);
    await mkdir(destinationRoot);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function journal(hash: string | null) {
    const sample = sampleJournal({ maintenanceBuild: null });
    return {
      ...sample,
      source: { ...sample.source, path: sourceRoot },
      destination: { ...sample.destination, path: destinationRoot },
      coordinatorExecutableSha256: hash,
    };
  }

  async function install(
    path: string,
    bytes: Buffer,
    mode: number,
  ): Promise<string> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    await chmod(path, mode);
    return path;
  }

  const productionIn = (root: string): string =>
    join(root, "cli", "bin", "traycer");

  it("finds nothing when no CLI is installed", async () => {
    expect(
      await locateRecoveryBinaries({
        journal: journal(sha(ORIGINAL)),
        platform: "posix",
      }),
    ).toEqual([]);
  });

  it("a newer current binary is irrelevant: the preserved original matches the recorded hash", async () => {
    const original = await install(productionIn(sourceRoot), ORIGINAL, 0o644);
    const current = await install(productionIn(destinationRoot), NEWER, 0o644);
    const found = await locateRecoveryBinaries({
      journal: journal(sha(ORIGINAL)),
      platform: "posix",
    });
    expect(found).toEqual([
      { path: original, root: "source", slot: "production", compatible: true },
      {
        path: current,
        root: "destination",
        slot: "production",
        compatible: false,
      },
    ]);
  });

  it("an altered original (one byte changed) is not compatible", async () => {
    const altered = Buffer.from(ORIGINAL);
    altered[0] = altered[0] === 0x74 ? 0x75 : 0x74;
    const path = await install(productionIn(sourceRoot), altered, 0o644);
    const found = await locateRecoveryBinaries({
      journal: journal(sha(ORIGINAL)),
      platform: "posix",
    });
    expect(found).toEqual([
      { path, root: "source", slot: "production", compatible: false },
    ]);
  });

  it("a symlink to the original is not compatible", async () => {
    const real = await install(join(base, "real-original"), ORIGINAL, 0o644);
    const link = productionIn(sourceRoot);
    await mkdir(dirname(link), { recursive: true });
    await symlink(real, link);
    const found = await locateRecoveryBinaries({
      journal: journal(sha(ORIGINAL)),
      platform: "posix",
    });
    expect(found).toEqual([
      { path: link, root: "source", slot: "production", compatible: false },
    ]);
  });

  it("finds a dev-runs slot binary", async () => {
    const path = await install(
      join(sourceRoot, "cli", "dev-runs", "mine", "bin", "traycer"),
      ORIGINAL,
      0o644,
    );
    const found = await locateRecoveryBinaries({
      journal: journal(sha(ORIGINAL)),
      platform: "posix",
    });
    expect(found).toEqual([
      { path, root: "source", slot: "dev-runs/mine", compatible: true },
    ]);
  });

  it("finds the staging and dev slots at both roots", async () => {
    await install(
      join(sourceRoot, "cli", "staging", "bin", "traycer"),
      ORIGINAL,
      0o644,
    );
    await install(
      join(destinationRoot, "cli", "dev", "bin", "traycer"),
      ORIGINAL,
      0o644,
    );
    const found = await locateRecoveryBinaries({
      journal: journal(sha(ORIGINAL)),
      platform: "posix",
    });
    expect(
      found.map(
        (candidate) =>
          `${candidate.root}:${candidate.slot}:${String(candidate.compatible)}`,
      ),
    ).toEqual(["source:staging:true", "destination:dev:true"]);
  });

  it("a null recorded hash makes nothing compatible", async () => {
    await install(productionIn(sourceRoot), ORIGINAL, 0o644);
    await install(productionIn(destinationRoot), ORIGINAL, 0o644);
    const found = await locateRecoveryBinaries({
      journal: journal(null),
      platform: "posix",
    });
    expect(found).toHaveLength(2);
    expect(found.every((candidate) => !candidate.compatible)).toBe(true);
  });

  it("executes nothing it finds: a non-executable (0644) script is only hashed", async () => {
    const marker = join(base, "marker");
    const script = Buffer.from(`#!/bin/sh\ntouch ${marker}\n`);
    const path = await install(productionIn(sourceRoot), script, 0o644);
    const found = await locateRecoveryBinaries({
      journal: journal(sha(script)),
      platform: "posix",
    });
    expect(found).toEqual([
      { path, root: "source", slot: "production", compatible: true },
    ]);
    await expect(realpath(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path)).toEqual(script);
  });
});

describe("the journal's coordinatorExecutableSha256", () => {
  const HASH = "a".repeat(64);

  it("accepts a lowercase 64-hex digest and null", () => {
    const planned = sampleJournal({ maintenanceBuild: null });
    expect(
      migrationJournalSchema.safeParse({
        ...planned,
        coordinatorExecutableSha256: HASH,
      }).success,
    ).toBe(true);
    expect(
      migrationJournalSchema.safeParse({
        ...planned,
        coordinatorExecutableSha256: null,
      }).success,
    ).toBe(true);
  });

  it("rejects 63 hex characters, uppercase, a non-hex digit, an empty string and a missing field", () => {
    const planned = sampleJournal({ maintenanceBuild: null });
    for (const bad of [
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      `${"a".repeat(63)}g`,
      "",
    ]) {
      expect(
        migrationJournalSchema.safeParse({
          ...planned,
          coordinatorExecutableSha256: bad,
        }).success,
      ).toBe(false);
    }
    const without = Object.fromEntries(
      Object.entries(planned).filter(
        ([key]) => key !== "coordinatorExecutableSha256",
      ),
    );
    expect(migrationJournalSchema.safeParse(without).success).toBe(false);
  });

  it("is immutable: a successor that changes it is refused (immutable-field-changed)", () => {
    const planned = {
      ...sampleJournal({ maintenanceBuild: null }),
      coordinatorExecutableSha256: HASH,
    };
    const next = { ...planned, revision: 2, phase: "quiescing" as const };
    expect(checkJournalSuccessor(planned, next)).toBeNull();
    expect(
      checkJournalSuccessor(planned, {
        ...next,
        coordinatorExecutableSha256: "b".repeat(64),
      })?.code,
    ).toBe("immutable-field-changed");
    expect(
      checkJournalSuccessor(planned, {
        ...next,
        coordinatorExecutableSha256: null,
      })?.code,
    ).toBe("immutable-field-changed");
    const unrecorded = { ...planned, coordinatorExecutableSha256: null };
    expect(
      checkJournalSuccessor(unrecorded, {
        ...next,
        coordinatorExecutableSha256: HASH,
      })?.code,
    ).toBe("immutable-field-changed");
  });
});
