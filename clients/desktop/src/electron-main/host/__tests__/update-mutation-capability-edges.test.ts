import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostStopIntentPath } from "@traycer/protocol/config/host-stop-intent";
import {
  withUpdateContender,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";
import {
  publishRestartTombstoneWithAttempt,
  writeSubstrateOwnerWithAttempt,
} from "../update-mutation";
import type { HostFsLayout } from "../host-paths";
import { freshHostFsLayout } from "./host-fs-layout-test-support";

// The tombstone-ordering contract (design §3.4): the caller must never boot
// the SMAppService job out unless `publishRestartTombstoneWithAttempt`
// reports that the record durably landed - a call-order-only assertion would
// pass a build that "calls publish" but never actually flushes anything to
// disk. Every negative here is paired with a positive on the SAME fixture,
// so a permanently no-op writer cannot satisfy the suite by never landing
// anything (see the "negative assertion satisfied by permanent inaction"
// class of bug).

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function freshLayout(): Promise<HostFsLayout> {
  return freshHostFsLayout(roots, "update-mutation-tombstone-test-");
}

describe("publishRestartTombstoneWithAttempt", () => {
  it("publishes reason: restart at hostStopIntentPath, with content present the moment it returns", async () => {
    const layout = await freshLayout();

    const outcome = await withUpdateContender(
      {
        hostHomeDir: layout.rootDir,
        reason: "tombstone-publish-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) =>
        publishRestartTombstoneWithAttempt(capability, layout),
    );

    expect(outcome).toMatchObject({
      kind: "ran",
      result: { kind: "published" },
    });

    const target = hostStopIntentPath(layout.rootDir);
    const raw = await readFile(target, "utf8");
    const parsed = JSON.parse(raw) as {
      v: number;
      reason: string;
      requestedByPid: number;
      requestedAt: string;
    };
    expect(parsed.v).toBe(1);
    // `reason: "restart"` is the only value that promises a comeback; the
    // host branches on this exact literal.
    expect(parsed.reason).toBe("restart");
    expect(parsed.requestedByPid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(parsed.requestedAt))).toBe(false);
  });

  it("reports not-published and leaves no tombstone when the durable rename cannot land - the SAME fixture publishes fine once the obstruction is removed", async () => {
    const layout = await freshLayout();
    const target = hostStopIntentPath(layout.rootDir);
    // Obstruct the rename target with a non-empty directory so the final
    // `rename(temp, target)` fails, regardless of process privilege - a
    // portable stand-in for "the durable write did not land".
    await mkdir(target, { recursive: true });
    await mkdir(join(target, "occupied"), { recursive: true });

    const blocked = await withUpdateContender(
      {
        hostHomeDir: layout.rootDir,
        reason: "tombstone-blocked-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) =>
        publishRestartTombstoneWithAttempt(capability, layout),
    );

    expect(blocked).toMatchObject({ kind: "ran" });
    if (blocked.kind === "ran") {
      expect(blocked.result.kind).toBe("not-published");
    }
    // The obstruction is still a directory - no bytes replaced it - which is
    // the caller's positive evidence that no bootout may proceed.
    const stillADirectory = await stat(target);
    expect(stillADirectory.isDirectory()).toBe(true);

    await rm(join(target, "occupied"), { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });

    const published = await withUpdateContender(
      {
        hostHomeDir: layout.rootDir,
        reason: "tombstone-unblocked-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) =>
        publishRestartTombstoneWithAttempt(capability, layout),
    );
    expect(published).toMatchObject({
      kind: "ran",
      result: { kind: "published" },
    });
    const raw = await readFile(target, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ reason: "restart" });
  });

  it("refuses a forged/unissued capability outright and writes nothing", async () => {
    const layout = await freshLayout();
    const forged = { hostHomeDir: layout.rootDir } as UpdateMutationCapability;

    await expect(
      publishRestartTombstoneWithAttempt(forged, layout),
    ).rejects.toMatchObject({ verdict: "not-issued" });

    await expect(stat(hostStopIntentPath(layout.rootDir))).rejects.toThrow();
  });
});

describe("writeSubstrateOwnerWithAttempt", () => {
  it("commits a substrate.json recording the given owner and reason", async () => {
    const layout = await freshLayout();

    const outcome = await withUpdateContender(
      {
        hostHomeDir: layout.rootDir,
        reason: "substrate-write-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "desktop-activation-maintenance",
      },
      async (capability) =>
        writeSubstrateOwnerWithAttempt(
          capability,
          layout,
          "smappservice",
          "healthy-launch-backfill:enabled",
        ),
    );

    expect(outcome.kind).toBe("ran");
    const raw = await readFile(layout.substrateFile, "utf8");
    const parsed = JSON.parse(raw) as {
      v: number;
      active: string;
      reason: string;
      since: string;
    };
    expect(parsed.v).toBe(1);
    expect(parsed.active).toBe("smappservice");
    expect(parsed.reason).toBe("healthy-launch-backfill:enabled");
    expect(Number.isNaN(Date.parse(parsed.since))).toBe(false);
  });

  it("refuses a forged/unissued capability outright and writes nothing", async () => {
    const layout = await freshLayout();
    const forged = { hostHomeDir: layout.rootDir } as UpdateMutationCapability;

    await expect(
      writeSubstrateOwnerWithAttempt(
        forged,
        layout,
        "smappservice",
        "should-not-land",
      ),
    ).rejects.toMatchObject({ verdict: "not-issued" });

    await expect(stat(layout.substrateFile)).rejects.toThrow();
  });

  it("leaves no .substrate temp behind when the publishing rename cannot land", async () => {
    // The temp name carries a pid and a timestamp, so a failure that skips the
    // unlink leaks a NEW file every time rather than overwriting the last —
    // and launch-time backfill retries this publication, so they accumulate in
    // the host root.
    //
    // The rename is obstructed the same way the tombstone suite obstructs its
    // own, which reaches the throw AFTER the temp exists. That ordering is the
    // whole point: a failure before the write has nothing to clean up.
    const layout = await freshLayout();
    await mkdir(layout.substrateFile, { recursive: true });

    const outcome = await withUpdateContender(
      {
        hostHomeDir: layout.rootDir,
        reason: "substrate-rename-obstructed-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "desktop-activation-maintenance",
      },
      async (capability) =>
        writeSubstrateOwnerWithAttempt(
          capability,
          layout,
          "smappservice",
          "rename-obstructed",
        ).then(
          () => "resolved",
          () => "rejected",
        ),
    );

    expect(outcome).toMatchObject({ kind: "ran", result: "rejected" });
    const leaked = (await readdir(dirname(layout.substrateFile))).filter(
      (entry) => entry.startsWith(".substrate.") && entry.endsWith(".tmp"),
    );
    expect(leaked).toEqual([]);
  });
});
