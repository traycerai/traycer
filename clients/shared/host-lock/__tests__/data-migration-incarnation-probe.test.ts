// Pins clientProcessIncarnationProbe.verdict: a pid that exited between the liveness and identity reads (alive, identity null, re-read dead) is dead, and this process's own pid keeps verifyProcessIdentityAsync.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeProcessLivenessAsync } from "@traycer/protocol/config/process-liveness";
import { clientProcessIncarnationProbe } from "../data-migration-admission";
import {
  observeProcessStartAsync,
  verifyProcessIdentityAsync,
} from "../process-identity";

vi.mock(
  "@traycer/protocol/config/process-liveness",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@traycer/protocol/config/process-liveness")
    >()),
    probeProcessLivenessAsync: vi.fn(),
  }),
);
vi.mock("../process-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process-identity")>()),
  observeProcessStartAsync: vi.fn(),
  verifyProcessIdentityAsync: vi.fn(),
}));

const PID = 5540;
const RECORDED = "linux:boot-id-fixed 100";
const liveness = vi.mocked(probeProcessLivenessAsync);
const observe = vi.mocked(observeProcessStartAsync);
const verifyOwn = vi.mocked(verifyProcessIdentityAsync);

beforeEach(() => {
  liveness.mockReset();
  observe.mockReset();
  verifyOwn.mockReset();
});

describe("clientProcessIncarnationProbe.verdict", () => {
  it("alive, identity null, re-read dead -> dead", async () => {
    liveness.mockResolvedValueOnce("alive").mockResolvedValueOnce("dead");
    observe.mockResolvedValue(null);
    await expect(
      clientProcessIncarnationProbe.verdict(PID, RECORDED),
    ).resolves.toBe("dead");
    expect(liveness).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledWith(PID, RECORDED);
  });

  it("alive, identity null, re-read alive -> indeterminate", async () => {
    liveness.mockResolvedValueOnce("alive").mockResolvedValueOnce("alive");
    observe.mockResolvedValue(null);
    await expect(
      clientProcessIncarnationProbe.verdict(PID, RECORDED),
    ).resolves.toBe("indeterminate");
    expect(liveness).toHaveBeenCalledTimes(2);
  });

  it("alive, identity null, re-read indeterminate -> indeterminate", async () => {
    liveness
      .mockResolvedValueOnce("alive")
      .mockResolvedValueOnce("indeterminate");
    observe.mockResolvedValue(null);
    await expect(
      clientProcessIncarnationProbe.verdict(PID, RECORDED),
    ).resolves.toBe("indeterminate");
    expect(liveness).toHaveBeenCalledTimes(2);
  });

  it("alive with a matching identity -> alive-same, no re-read", async () => {
    liveness.mockResolvedValueOnce("alive");
    observe.mockResolvedValue({ kind: "identity", identity: RECORDED });
    await expect(
      clientProcessIncarnationProbe.verdict(PID, RECORDED),
    ).resolves.toBe("alive-same");
    expect(liveness).toHaveBeenCalledTimes(1);
  });

  it("alive with a different identity -> alive-different, no re-read", async () => {
    liveness.mockResolvedValueOnce("alive");
    observe.mockResolvedValue({
      kind: "identity",
      identity: "linux:boot-id-fixed 200",
    });
    await expect(
      clientProcessIncarnationProbe.verdict(PID, RECORDED),
    ).resolves.toBe("alive-different");
    expect(liveness).toHaveBeenCalledTimes(1);
  });

  it("this process's own pid still routes to verifyProcessIdentityAsync", async () => {
    verifyOwn.mockResolvedValue("alive-same");
    await expect(
      clientProcessIncarnationProbe.verdict(process.pid, RECORDED),
    ).resolves.toBe("alive-same");
    expect(verifyOwn).toHaveBeenCalledTimes(1);
    expect(verifyOwn).toHaveBeenCalledWith({
      pid: process.pid,
      startedAtMs: null,
      startIdentity: RECORDED,
    });
    expect(liveness).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });
});
