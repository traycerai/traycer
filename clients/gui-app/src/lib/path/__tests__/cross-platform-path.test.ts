import { describe, expect, it } from "vitest";
import { resolveAbsolutePath } from "@/lib/path/cross-platform-path";

describe("resolveAbsolutePath", () => {
  it("resolves an ordinary escaping relative path within a POSIX base", () => {
    expect(resolveAbsolutePath("/repo-a/nested", "../app.ts")).toBe(
      "/repo-a/app.ts",
    );
  });

  it("clamps traversal at a Windows drive root instead of stripping the drive", () => {
    expect(resolveAbsolutePath("D:/repo", "../../secret.txt")).toBe(
      "D:/secret.txt",
    );
  });

  it("clamps traversal at a UNC share root instead of escaping the share authority", () => {
    expect(resolveAbsolutePath("//server/share", "../x.ts")).toBe(
      "//server/share/x.ts",
    );
  });

  it("clamps traversal at the POSIX root instead of producing a non-absolute result", () => {
    expect(resolveAbsolutePath("/", "../x.ts")).toBe("/x.ts");
  });

  it("clamps traversal that overshoots a nested Windows drive path", () => {
    expect(resolveAbsolutePath("D:/repo/nested", "../../../secret.txt")).toBe(
      "D:/secret.txt",
    );
  });

  it("clamps traversal that overshoots a nested UNC share path", () => {
    expect(resolveAbsolutePath("//server/share/nested", "../../x.ts")).toBe(
      "//server/share/x.ts",
    );
  });

  it("recognizes a native-backslash Windows drive base as the authority, not a POSIX root", () => {
    expect(resolveAbsolutePath("D:\\repo\\nested", "..\\x.ts")).toBe(
      "D:/repo/x.ts",
    );
  });

  it("recognizes a mixed-separator Windows drive base as the authority", () => {
    expect(resolveAbsolutePath("D:\\work/repo", "../x.ts")).toBe(
      "D:/work/x.ts",
    );
  });

  it("recognizes a native-backslash UNC share base as the authority", () => {
    expect(
      resolveAbsolutePath("\\\\server\\share\\nested", "..\\..\\x.ts"),
    ).toBe("//server/share/x.ts");
  });

  it("recognizes a mixed-separator UNC share base as the authority", () => {
    expect(resolveAbsolutePath("\\\\server/share\\nested", "../x.ts")).toBe(
      "//server/share/x.ts",
    );
  });
});
