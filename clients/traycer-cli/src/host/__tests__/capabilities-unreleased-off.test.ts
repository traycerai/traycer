import { describe, expect, it, vi } from "vitest";
import { HOST_CAPABILITIES, runHostCapabilities } from "../capabilities";

// The build that ships without sandboxes: the CLI advertises the capability
// set it had before `sandbox-mode` existed, so a registration that probes for
// it is told no.
vi.mock("../../unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

describe("host capabilities without sandboxes", () => {
  it("does not advertise sandbox-mode", () => {
    expect(HOST_CAPABILITIES).toEqual([
      "service-label",
      "host-start-adoption-v2",
      "maintenance-lease-v1",
      "maintenance-lease-v2",
      "lifecycle-policy-v1",
    ]);
    expect(
      runHostCapabilities({ kind: "has", capability: "sandbox-mode" }),
    ).toEqual({ stdout: "", exitCode: 1 });
  });
});
