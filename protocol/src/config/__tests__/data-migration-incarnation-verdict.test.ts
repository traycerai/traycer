// Pins composeIncarnationVerdict: one extra liveness read when alive + recorded + identity read null (a pid that exited between the two reads), and nothing else changes.
import { describe, expect, it, vi } from "vitest";
import { composeIncarnationVerdict } from "../data-migration-admission";
import type { AttemptHolderProcessLiveness } from "../host-update-attempt-liveness";
import type {
  ObservedProcessStart,
  ProcessStartIdentity,
} from "@traycer/protocol/host/lifecycle/process-start-identity";

const PID = 5540;
const RECORDED: ProcessStartIdentity = "linux:boot-id-fixed 100";
const SAME: ObservedProcessStart = { kind: "identity", identity: RECORDED };
const DIFFERENT: ObservedProcessStart = {
  kind: "identity",
  identity: "linux:boot-id-fixed 200",
};

function reads(
  liveness: readonly AttemptHolderProcessLiveness[],
  observed: ObservedProcessStart | null,
) {
  const livenessRead =
    vi.fn<(pid: number) => Promise<AttemptHolderProcessLiveness>>();
  for (const answer of liveness) livenessRead.mockResolvedValueOnce(answer);
  const observe = vi.fn<
    (
      pid: number,
      recorded: ProcessStartIdentity,
    ) => Promise<ObservedProcessStart | null>
  >(async () => observed);
  return { livenessRead, observe };
}

describe("composeIncarnationVerdict", () => {
  it("alive, identity null, re-read dead -> dead (read twice)", async () => {
    const { livenessRead, observe } = reads(["alive", "dead"], null);
    await expect(
      composeIncarnationVerdict({
        pid: PID,
        recorded: RECORDED,
        liveness: livenessRead,
        observe,
      }),
    ).resolves.toBe("dead");
    expect(livenessRead).toHaveBeenCalledTimes(2);
    expect(livenessRead).toHaveBeenNthCalledWith(2, PID);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(PID, RECORDED);
  });

  it("alive, identity null, re-read alive -> indeterminate", async () => {
    const { livenessRead, observe } = reads(["alive", "alive"], null);
    await expect(
      composeIncarnationVerdict({
        pid: PID,
        recorded: RECORDED,
        liveness: livenessRead,
        observe,
      }),
    ).resolves.toBe("indeterminate");
    expect(livenessRead).toHaveBeenCalledTimes(2);
  });

  it("alive, identity null, re-read indeterminate -> indeterminate", async () => {
    const { livenessRead, observe } = reads(["alive", "indeterminate"], null);
    await expect(
      composeIncarnationVerdict({
        pid: PID,
        recorded: RECORDED,
        liveness: livenessRead,
        observe,
      }),
    ).resolves.toBe("indeterminate");
    expect(livenessRead).toHaveBeenCalledTimes(2);
  });

  it("alive with a matching identity -> alive-same, no re-read", async () => {
    const { livenessRead, observe } = reads(["alive"], SAME);
    await expect(
      composeIncarnationVerdict({
        pid: PID,
        recorded: RECORDED,
        liveness: livenessRead,
        observe,
      }),
    ).resolves.toBe("alive-same");
    expect(livenessRead).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("alive with a different identity -> alive-different, no re-read", async () => {
    const { livenessRead, observe } = reads(["alive"], DIFFERENT);
    await expect(
      composeIncarnationVerdict({
        pid: PID,
        recorded: RECORDED,
        liveness: livenessRead,
        observe,
      }),
    ).resolves.toBe("alive-different");
    expect(livenessRead).toHaveBeenCalledTimes(1);
  });

  it("indeterminate liveness with identity null -> indeterminate, still consults identity, no re-read", async () => {
    const { livenessRead, observe } = reads(["indeterminate"], null);
    await expect(
      composeIncarnationVerdict({
        pid: PID,
        recorded: RECORDED,
        liveness: livenessRead,
        observe,
      }),
    ).resolves.toBe("indeterminate");
    expect(livenessRead).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("indeterminate liveness with a matching identity -> alive-same", async () => {
    const { livenessRead, observe } = reads(["indeterminate"], SAME);
    await expect(
      composeIncarnationVerdict({
        pid: PID,
        recorded: RECORDED,
        liveness: livenessRead,
        observe,
      }),
    ).resolves.toBe("alive-same");
    expect(livenessRead).toHaveBeenCalledTimes(1);
  });

  it("dead liveness -> dead without reading identity", async () => {
    const { livenessRead, observe } = reads(["dead"], SAME);
    await expect(
      composeIncarnationVerdict({
        pid: PID,
        recorded: RECORDED,
        liveness: livenessRead,
        observe,
      }),
    ).resolves.toBe("dead");
    expect(livenessRead).toHaveBeenCalledTimes(1);
    expect(observe).not.toHaveBeenCalled();
  });

  it("alive with no recorded identity -> indeterminate, no identity read, no re-read", async () => {
    const { livenessRead, observe } = reads(["alive"], SAME);
    await expect(
      composeIncarnationVerdict({
        pid: PID,
        recorded: null,
        liveness: livenessRead,
        observe,
      }),
    ).resolves.toBe("indeterminate");
    expect(livenessRead).toHaveBeenCalledTimes(1);
    expect(observe).not.toHaveBeenCalled();
  });
});
