import { describe, expect, it } from "vitest";
import {
  BUNDLED_BUILD_META_NAME,
  bundledBuildIdFromHtml,
  bundledBuildReloadClient,
  resolveBundledDevelopment,
} from "../scripts/bundled-build-reload";

describe("bundled build reload", () => {
  it("allows bundled mode only for development builds", () => {
    expect(resolveBundledDevelopment("dev", undefined)).toBe(false);
    expect(resolveBundledDevelopment("dev", "vite")).toBe(false);
    expect(resolveBundledDevelopment("dev", "bundled")).toBe(true);
    expect(() => resolveBundledDevelopment("staging", "bundled")).toThrow(
      "requires TRAYCER_MOBILE_ENV=dev",
    );
    expect(() => resolveBundledDevelopment("production", "bundled")).toThrow(
      "requires TRAYCER_MOBILE_ENV=dev",
    );
    expect(() => resolveBundledDevelopment("dev", "invalid")).toThrow(
      "must be vite or bundled",
    );
  });

  it("seeds the reload client with the build that produced its HTML", () => {
    const client = bundledBuildReloadClient("build-one", "/build-revision");

    expect(client).toContain('const activeBuild = "build-one";');
    expect(client).toContain('fetch("/build-revision"');
    expect(client).not.toContain("activeBuild === null");
  });

  it("waits for each build check before scheduling the next one", () => {
    const client = bundledBuildReloadClient("build-one", "/build-revision");

    expect(client).toContain("await checkForBuild();");
    expect(client).toContain("setTimeout(() => void pollForBuild(), 750);");
    expect(client).not.toContain("setInterval(");
  });

  it("reads the build ID from the served HTML marker", () => {
    expect(
      bundledBuildIdFromHtml(
        `<meta content="build-two" name="${BUNDLED_BUILD_META_NAME}">`,
      ),
    ).toBe("build-two");
  });

  it("rejects a missing or empty build marker", () => {
    expect(bundledBuildIdFromHtml("<html></html>")).toBeNull();
    expect(
      bundledBuildIdFromHtml(
        `<meta name="${BUNDLED_BUILD_META_NAME}" content="">`,
      ),
    ).toBeNull();
  });
});
