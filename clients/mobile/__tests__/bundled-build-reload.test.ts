import { describe, expect, it } from "vitest";
import {
  BUNDLED_BUILD_META_NAME,
  bundledBuildIdFromHtml,
  bundledBuildReloadClient,
} from "../scripts/bundled-build-reload";

describe("bundled build reload", () => {
  it("seeds the reload client with the build that produced its HTML", () => {
    const client = bundledBuildReloadClient("build-one", "/build-revision");

    expect(client).toContain('const activeBuild = "build-one";');
    expect(client).toContain('fetch("/build-revision"');
    expect(client).not.toContain("activeBuild === null");
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
