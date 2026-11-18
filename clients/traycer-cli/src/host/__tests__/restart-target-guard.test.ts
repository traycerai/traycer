import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_ERROR_CODES } from "../../runner/errors";
import { refuseUnlessRestartTarget } from "../restart-target-guard";

// The guard reads `pid.json` as the last await before a caller acts. A record
// naming another instance is classified by a liveness probe, which awaits, and
// a host can publish while it runs - so the record is read again after the
// probe. Both seams are replaced: the record by a stand-in the test steps
// through, the probe by an answer that may publish.

const state = vi.hoisted(() => ({
  record: null as { pid: number; processStartIdentity: string } | null,
  reads: 0,
  probes: [] as number[],
  probe: null as ((pid: number) => "dead" | "current") | null,
}));

vi.mock("../pid-metadata", () => ({
  readHostPidMetadataEvidence: async () => {
    state.reads += 1;
    return state.record === null
      ? { kind: "absent" }
      : { kind: "read", metadata: state.record };
  },
}));

vi.mock(
  "@traycer-clients/shared/host-lock/process-identity",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-lock/process-identity")
      >();
    return {
      ...actual,
      getPublishedProcessIdentityVerdict: async (pid: number) => {
        state.probes.push(pid);
        if (state.probe === null) throw new Error("probe not staged");
        return state.probe(pid);
      },
    };
  },
);

const CONFIRMED_HOST = { pid: 4242, startIdentity: "linux:boot-a 4242" };
const STALE = { pid: 31337, processStartIdentity: "linux:boot-z 31337" };
const REPLACEMENT = { pid: 5353, processStartIdentity: "linux:boot-b 5353" };

describe("refuseUnlessRestartTarget", () => {
  beforeEach(() => {
    state.record = STALE;
    state.reads = 0;
    state.probes = [];
    state.probe = null;
  });

  afterEach(() => {
    state.probe = null;
  });

  it("proceeds, with one probe and one re-read, when a stale record stays the same record across its probe", async () => {
    state.probe = () => "dead";

    await expect(
      refuseUnlessRestartTarget(
        "host restart",
        "production",
        CONFIRMED_HOST,
        null,
      ),
    ).resolves.toBeUndefined();

    expect(state.probes).toEqual([STALE.pid]);
    expect(state.reads).toBe(2);
  });

  it("refuses when a host publishes while the stale record's probe runs", async () => {
    state.probe = (pid) => {
      if (pid !== STALE.pid) return "current";
      state.record = REPLACEMENT;
      return "dead";
    };

    await expect(
      refuseUnlessRestartTarget(
        "host restart",
        "production",
        CONFIRMED_HOST,
        null,
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_RESTART_TARGET_CHANGED,
    });

    // The first record was classified dead; the record that replaced it is
    // classified live and is what refuses.
    expect(state.probes).toEqual([STALE.pid, REPLACEMENT.pid]);
  });

  it("refuses a record that keeps changing under its probes, after three reads of it", async () => {
    let published = 0;
    state.probe = () => {
      published += 1;
      state.record = {
        pid: STALE.pid + published,
        processStartIdentity: `linux:boot-z ${String(STALE.pid + published)}`,
      };
      return "dead";
    };

    await expect(
      refuseUnlessRestartTarget(
        "host restart",
        "production",
        CONFIRMED_HOST,
        null,
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_RESTART_TARGET_CHANGED,
    });

    expect(state.probes).toHaveLength(3);
  });

  it("does not probe at all when the record names the confirmed host", async () => {
    state.record = {
      pid: CONFIRMED_HOST.pid,
      processStartIdentity: CONFIRMED_HOST.startIdentity,
    };

    await expect(
      refuseUnlessRestartTarget(
        "host restart",
        "production",
        CONFIRMED_HOST,
        null,
      ),
    ).resolves.toBeUndefined();

    expect(state.probes).toEqual([]);
    expect(state.reads).toBe(1);
  });
});
