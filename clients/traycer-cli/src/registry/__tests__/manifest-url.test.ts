import { describe, expect, it } from "vitest";
import { resolveManifestUrl } from "../manifest-url";
import { hostRegistryUrl } from "../../config";

describe("resolveManifestUrl", () => {
  it("returns the single source-controlled registry URL", () => {
    expect(resolveManifestUrl().url).toBe(hostRegistryUrl);
  });

  it("is the single canonical production registry path (no per-environment segment)", () => {
    expect(resolveManifestUrl().url).toBe(
      "https://github.com/traycerai/traycer/releases/download/released-host-versions/versions.json",
    );
  });
});
