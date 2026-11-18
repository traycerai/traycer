import { describe, expect, it } from "vitest";
import { deriveHostWorkspaceChipLabel } from "../use-host-workspace-chip-label";

describe("deriveHostWorkspaceChipLabel", () => {
  it("returns null primary label when no folders are linked", () => {
    const result = deriveHostWorkspaceChipLabel({
      hostLabel: "macbook",
      folderNames: [],
    });
    expect(result).toEqual({
      hostLabel: "macbook",
      primaryFolderLabel: null,
      extraFolderCount: 0,
    });
  });

  it("returns primary without +N for a single folder", () => {
    const result = deriveHostWorkspaceChipLabel({
      hostLabel: "macbook",
      folderNames: ["my-project"],
    });
    expect(result).toEqual({
      hostLabel: "macbook",
      primaryFolderLabel: "my-project",
      extraFolderCount: 0,
    });
  });

  it("returns primary with +N for multi-folder bindings", () => {
    const result = deriveHostWorkspaceChipLabel({
      hostLabel: "build-box",
      folderNames: ["my-project", "docs", "marketing"],
    });
    expect(result).toEqual({
      hostLabel: "build-box",
      primaryFolderLabel: "my-project",
      extraFolderCount: 2,
    });
  });
});
