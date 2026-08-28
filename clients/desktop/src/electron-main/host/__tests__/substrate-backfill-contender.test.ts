import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const loginItemMocks = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("../../app/host-login-item", () => ({
  readHostLoginItemStatus: loginItemMocks.status,
}));

import { backfillSubstrateOwnerAtLaunch } from "../substrate-backfill-contender";
import type { HostFsLayout } from "../host-paths";

// Unconditional healthy-launch ownership backfill (design §3.1 obligations
// 1-2): `enabled`/`requires-approval` commit `smappservice`; every other
// login-item status writes nothing and leaves the previous valid owner
// standing. `substrate.json` is absent across the whole installed base
// today, so the common case this exercises IS the migration write.

const roots: string[] = [];
const LABELS = {
  agentLabelId: "ai.traycer.host.agent",
  cliLabelId: "ai.traycer.host",
};

afterEach(async () => {
  loginItemMocks.status.mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function freshLayout(): Promise<HostFsLayout> {
  const root = await mkdtemp(join(tmpdir(), "substrate-backfill-test-"));
  roots.push(root);
  const rootDir = join(root, "host-home");
  await mkdir(rootDir, { recursive: true });
  return {
    rootDir,
    pidMetadataFile: join(rootDir, "pid.json"),
    identityEnrollmentFile: join(rootDir, "identity", "enrollment.json"),
    logFile: join(rootDir, "host.log"),
    installDir: join(rootDir, "install"),
    installRecordFile: join(rootDir, "install", "install.json"),
    stagedDir: join(rootDir, "staged"),
    stagedRecordFile: join(rootDir, "staged", "staged.json"),
    pendingLoginItemRevisionFile: join(
      rootDir,
      "pending-login-item-revision.json",
    ),
    substrateFile: join(rootDir, "substrate.json"),
    transitionJournalFile: join(rootDir, "transition.json"),
    environment: "production",
  };
}

async function writeSubstrate(
  layout: HostFsLayout,
  active: "smappservice" | "raw-fallback",
): Promise<void> {
  await writeFile(
    layout.substrateFile,
    JSON.stringify({
      v: 1,
      active,
      since: "2026-01-01T00:00:00.000Z",
      reason: "fixture",
      attestation: null,
    }),
  );
}

describe.each(["enabled", "requires-approval"] as const)(
  "backfillSubstrateOwnerAtLaunch - status=%s commits smappservice",
  (status) => {
    it("commits {active: smappservice} when substrate.json is absent (the installed-base migration case)", async () => {
      loginItemMocks.status.mockReturnValue(status);
      const layout = await freshLayout();

      const outcome = await backfillSubstrateOwnerAtLaunch({
        layout,
        lockPath: join(layout.rootDir, "cli-lock"),
        waitMs: 0,
        pollIntervalMs: 10,
        ...LABELS,
      });

      expect(outcome).toEqual({ kind: "committed" });
      const raw = await readFile(layout.substrateFile, "utf8");
      const parsed = JSON.parse(raw) as { active: string; reason: string };
      expect(parsed.active).toBe("smappservice");
      expect(parsed.reason).toBe(`healthy-launch-backfill:${status}`);
    });

    it("is a no-op (already-recorded) when smappservice is already the recorded owner", async () => {
      loginItemMocks.status.mockReturnValue(status);
      const layout = await freshLayout();
      await writeSubstrate(layout, "smappservice");
      const before = await readFile(layout.substrateFile, "utf8");

      const outcome = await backfillSubstrateOwnerAtLaunch({
        layout,
        lockPath: join(layout.rootDir, "cli-lock"),
        waitMs: 0,
        pollIntervalMs: 10,
        ...LABELS,
      });

      expect(outcome).toEqual({ kind: "already-recorded" });
      await expect(readFile(layout.substrateFile, "utf8")).resolves.toBe(
        before,
      );
    });

    it("defers rather than overwriting when raw-fallback is already recorded - retiring that is the register cycle's job, not launch-time backfill's", async () => {
      loginItemMocks.status.mockReturnValue(status);
      const layout = await freshLayout();
      await writeSubstrate(layout, "raw-fallback");
      const before = await readFile(layout.substrateFile, "utf8");

      const outcome = await backfillSubstrateOwnerAtLaunch({
        layout,
        lockPath: join(layout.rootDir, "cli-lock"),
        waitMs: 0,
        pollIntervalMs: 10,
        ...LABELS,
      });

      expect(outcome).toEqual({
        kind: "deferred",
        cause: "raw-fallback-recorded",
      });
      await expect(readFile(layout.substrateFile, "utf8")).resolves.toBe(
        before,
      );
    });
  },
);

describe.each(["not-registered", "not-found", "not-supported"] as const)(
  "backfillSubstrateOwnerAtLaunch - status=%s writes nothing",
  (status) => {
    it("resolves not-attested and leaves substrate.json untouched (absent stays absent)", async () => {
      loginItemMocks.status.mockReturnValue(status);
      const layout = await freshLayout();

      const outcome = await backfillSubstrateOwnerAtLaunch({
        layout,
        lockPath: join(layout.rootDir, "cli-lock"),
        waitMs: 0,
        pollIntervalMs: 10,
        ...LABELS,
      });

      expect(outcome).toEqual({ kind: "not-attested", status });
      await expect(readFile(layout.substrateFile, "utf8")).rejects.toThrow();
    });

    it("leaves an existing recorded owner standing untouched", async () => {
      loginItemMocks.status.mockReturnValue(status);
      const layout = await freshLayout();
      await writeSubstrate(layout, "smappservice");
      const before = await readFile(layout.substrateFile, "utf8");

      const outcome = await backfillSubstrateOwnerAtLaunch({
        layout,
        lockPath: join(layout.rootDir, "cli-lock"),
        waitMs: 0,
        pollIntervalMs: 10,
        ...LABELS,
      });

      expect(outcome).toEqual({ kind: "not-attested", status });
      await expect(readFile(layout.substrateFile, "utf8")).resolves.toBe(
        before,
      );
    });
  },
);

describe("backfillSubstrateOwnerAtLaunch - fail-closed evidence", () => {
  it("defers rather than overwriting a corrupt substrate record", async () => {
    loginItemMocks.status.mockReturnValue("enabled");
    const layout = await freshLayout();
    await writeFile(layout.substrateFile, "not json");

    const outcome = await backfillSubstrateOwnerAtLaunch({
      layout,
      lockPath: join(layout.rootDir, "cli-lock"),
      waitMs: 0,
      pollIntervalMs: 10,
      ...LABELS,
    });

    expect(outcome).toEqual({
      kind: "deferred",
      cause: "substrate-record-faulted",
    });
  });

  it("defers rather than overwriting while a transition is in flight", async () => {
    loginItemMocks.status.mockReturnValue("enabled");
    const layout = await freshLayout();
    await writeFile(
      layout.transitionJournalFile,
      JSON.stringify({
        v: 1,
        transitionId: "t1",
        probeNonce: "n1",
        from: "raw-fallback",
        to: "smappservice",
        phase: "reclaim-probing",
        startedAt: "2026-01-01T00:00:00.000Z",
        expectedIdentities: [],
        compensation: null,
        governor: null,
      }),
    );

    const outcome = await backfillSubstrateOwnerAtLaunch({
      layout,
      lockPath: join(layout.rootDir, "cli-lock"),
      waitMs: 0,
      pollIntervalMs: 10,
      ...LABELS,
    });

    expect(outcome).toEqual({
      kind: "deferred",
      cause: "transition-in-flight",
    });
    await expect(readFile(layout.substrateFile, "utf8")).rejects.toThrow();
  });
});
