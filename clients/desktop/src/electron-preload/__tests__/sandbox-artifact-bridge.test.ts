import { describe, expect, it, vi } from "vitest";
import { buildSandboxArtifactBridge } from "../sandbox-artifact-bridge";

vi.mock("electron", () => ({
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

describe("buildSandboxArtifactBridge artifactOrigin", () => {
  it("gives every mount of an artifact the same site, so their frames share a renderer process", () => {
    const bridge = buildSandboxArtifactBridge();
    const first = bridge.artifactOrigin({
      artifactId: "report",
      mountId: "mounta",
    });
    const second = bridge.artifactOrigin({
      artifactId: "report",
      mountId: "mountb",
    });
    expect(first).toBe("traycer-sandbox://artifact-report");
    expect(second).toBe(first);
  });

  it("keeps a site per mount for an artifact id holding '--', which would read back as artifact and mount", () => {
    expect(
      buildSandboxArtifactBridge().artifactOrigin({
        artifactId: "x--y",
        mountId: "mounta",
      }),
    ).toBe("traycer-sandbox://artifact-x--y--mounta");
  });
});
