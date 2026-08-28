import { describe, expect, it } from "vitest";
import {
  relativizeToWorkspaceRoot,
  resolveAbsolutePath,
} from "@/lib/path/cross-platform-path";

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

describe("relativizeToWorkspaceRoot", () => {
  it("relativizes a path under a single root to a POSIX-style relative path", () => {
    expect(relativizeToWorkspaceRoot(["/repo"], "/repo/src/app.ts")).toBe(
      "src/app.ts",
    );
  });

  it("returns null for a path outside every root", () => {
    expect(
      relativizeToWorkspaceRoot(["/repo"], "/elsewhere/notes.txt"),
    ).toBeNull();
  });

  it("returns null when the path equals a root itself (a directory, not a file under it)", () => {
    expect(relativizeToWorkspaceRoot(["/repo"], "/repo")).toBeNull();
  });

  it("picks the longest (most specific) matching root when roots overlap", () => {
    expect(
      relativizeToWorkspaceRoot(
        ["/repo", "/repo/packages/app"],
        "/repo/packages/app/src/index.ts",
      ),
    ).toBe("src/index.ts");
  });

  it("is order-independent when picking the longest matching root", () => {
    expect(
      relativizeToWorkspaceRoot(
        ["/repo/packages/app", "/repo"],
        "/repo/packages/app/src/index.ts",
      ),
    ).toBe("src/index.ts");
  });

  it("matches a Windows root case-insensitively", () => {
    expect(relativizeToWorkspaceRoot(["D:/Repo"], "d:/repo/src/app.ts")).toBe(
      "src/app.ts",
    );
  });

  it("does not match a POSIX root case-insensitively", () => {
    expect(relativizeToWorkspaceRoot(["/Repo"], "/repo/src/app.ts")).toBeNull();
  });

  // Finding 6: POSIX paths may legally contain a literal `\` in a filename.
  // Strip/relativize must not treat that `\` as a separator (pathe's normalize
  // would fold it into `/` and split the filename into nested segments).
  it("preserves a literal backslash in a POSIX filename under a POSIX root", () => {
    expect(relativizeToWorkspaceRoot(["/repo"], "/repo/foo\\bar.txt")).toBe(
      "foo\\bar.txt",
    );
  });

  it("still normalizes native-backslash Windows drive paths under a drive root", () => {
    expect(
      relativizeToWorkspaceRoot(["D:\\repo"], "D:\\repo\\src\\app.ts"),
    ).toBe("src/app.ts");
  });

  it("still normalizes native-backslash UNC paths under a UNC root", () => {
    expect(
      relativizeToWorkspaceRoot(
        ["\\\\server\\share"],
        "\\\\server\\share\\src\\app.ts",
      ),
    ).toBe("src/app.ts");
  });
});
