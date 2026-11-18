import { describe, expect, it } from "vitest";
import { classifyCliSlot } from "../shared/cli-slot";
import type { CliSlotProbeInput } from "../shared/cli-slot";

const BASE: CliSlotProbeInput = {
  slotExists: true,
  isLinkOrFile: true,
  resolvedTarget: "/opt/traycer/bin/host",
  expectedTarget: "/opt/traycer/bin/host",
  executable: true,
  invocationAttested: true,
  probeError: null,
};

describe("classifyCliSlot", () => {
  it("is valid when every check passes", () => {
    expect(classifyCliSlot(BASE)).toEqual({ kind: "valid", attested: true });
  });

  it("is indeterminate when the probe itself failed, regardless of other fields", () => {
    expect(
      classifyCliSlot({ ...BASE, probeError: "EIO reading slot" }),
    ).toEqual({ kind: "indeterminate", cause: "EIO reading slot" });
  });

  it("is absent when the slot path does not exist", () => {
    expect(classifyCliSlot({ ...BASE, slotExists: false })).toEqual({
      kind: "absent",
    });
  });

  it("is indeterminate when the slot exists but is neither a file nor a link", () => {
    expect(classifyCliSlot({ ...BASE, isLinkOrFile: false })).toEqual({
      kind: "indeterminate",
      cause: "slot-path-not-file-or-link",
    });
  });

  it("is dangling when the symlink target cannot be resolved", () => {
    expect(classifyCliSlot({ ...BASE, resolvedTarget: null })).toEqual({
      kind: "dangling",
    });
  });

  it("is wrong-target when the resolved target differs from the expected target", () => {
    expect(
      classifyCliSlot({ ...BASE, resolvedTarget: "/some/other/path" }),
    ).toEqual({ kind: "wrong-target" });
  });

  it("skips the wrong-target check when the expected target is unknown", () => {
    expect(
      classifyCliSlot({
        ...BASE,
        expectedTarget: null,
        resolvedTarget: "/some/other/path",
      }),
    ).toEqual({ kind: "valid", attested: true });
  });

  it("is not-executable when the resolved target lacks the execute bit", () => {
    expect(classifyCliSlot({ ...BASE, executable: false })).toEqual({
      kind: "not-executable",
    });
  });

  it("is indeterminate when the optional invocation probe explicitly failed", () => {
    expect(classifyCliSlot({ ...BASE, invocationAttested: false })).toEqual({
      kind: "indeterminate",
      cause: "invocation-probe-failed",
    });
  });

  // `attested` reports the invocation probe, not the structural verdict. It
  // used to be a literal `true`, which said "attested" for a slot whose
  // invocation probe had never run — collapsing exactly the distinction the
  // F8 phase-2 probe exists to draw.
  it("is valid but NOT attested when the invocation probe was not run (null)", () => {
    expect(classifyCliSlot({ ...BASE, invocationAttested: null })).toEqual({
      kind: "valid",
      attested: false,
    });
  });

  it("is valid and attested only when the invocation probe positively passed", () => {
    expect(classifyCliSlot({ ...BASE, invocationAttested: true })).toEqual({
      kind: "valid",
      attested: true,
    });
  });
});
