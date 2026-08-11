import { describe, expect, it } from "vitest";

import { buildImageAssetCacheKey } from "../image-asset-cache-key";

describe("buildImageAssetCacheKey", () => {
  it("joins host, source, path, and content identity in order", () => {
    expect(
      buildImageAssetCacheKey({
        hostId: "host-1",
        source: "workspace",
        path: "/repo::assets/logo.png",
        contentIdentity: "42:1700000000000",
      }),
    ).toBe("host-1|workspace|/repo::assets/logo.png|42:1700000000000");
  });

  it("keeps source and content identity changes distinct", () => {
    const workspaceKey = buildImageAssetCacheKey({
      hostId: "host-1",
      source: "workspace",
      path: "repo::assets/logo.png",
      contentIdentity: "same",
    });
    const gitKey = buildImageAssetCacheKey({
      hostId: "host-1",
      source: "git-old",
      path: "repo::assets/logo.png",
      contentIdentity: "same",
    });
    const changedIdentityKey = buildImageAssetCacheKey({
      hostId: "host-1",
      source: "workspace",
      path: "repo::assets/logo.png",
      contentIdentity: "changed",
    });

    expect(gitKey).not.toBe(workspaceKey);
    expect(changedIdentityKey).not.toBe(workspaceKey);
  });
});
