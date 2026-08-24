import { describe, expect, it } from "vitest";

import {
  commonBasePath,
  leafOf,
  relativeTo,
  rootLengthOf,
  segmentsOf,
  separatorOf,
  tildeCollapse,
} from "../path-display";

describe("separatorOf", () => {
  it("picks / for a POSIX absolute path even if it contains a backslash", () => {
    expect(separatorOf("/srv/foo\\bar")).toBe("/");
  });

  it("picks \\ for a Windows-style path with no leading /", () => {
    expect(separatorOf("C:\\Users\\t\\work")).toBe("\\");
  });

  it("falls back to / for a relative path with no backslash", () => {
    expect(separatorOf("work/a")).toBe("/");
  });
});

describe("rootLengthOf", () => {
  it("treats a bare / as the whole root", () => {
    expect(rootLengthOf("/Users/t/work")).toBe(1);
  });

  it("treats a drive letter plus separator as the root", () => {
    expect(rootLengthOf("C:\\Users\\t")).toBe(3);
    expect(rootLengthOf("C:/Users/t")).toBe(3);
  });

  it("treats \\\\server\\share as the root, not just the leading slashes", () => {
    const path = "\\\\server\\share\\a\\b";
    expect(rootLengthOf(path)).toBe("\\\\server\\share".length);
  });
});

describe("segmentsOf", () => {
  it("splits a POSIX path into segments below the root", () => {
    expect(segmentsOf("/Users/t/work/a")).toEqual(["Users", "t", "work", "a"]);
  });

  it("returns no segments for a bare root", () => {
    expect(segmentsOf("/")).toEqual([]);
  });

  it("splits segments below a UNC root", () => {
    expect(segmentsOf("\\\\server\\share\\a\\b")).toEqual(["a", "b"]);
  });

  it("splits segments below a drive root", () => {
    expect(segmentsOf("C:\\Users\\t\\work")).toEqual(["Users", "t", "work"]);
  });

  // A backslash is an ordinary filename character on POSIX - it must not be
  // treated as a second separator once the path is already known to be /-rooted.
  it("keeps a backslash inside a POSIX filename as one segment, not two", () => {
    expect(segmentsOf("/srv/foo\\bar")).toEqual(["srv", "foo\\bar"]);
  });
});

describe("leafOf", () => {
  it("returns the last segment", () => {
    expect(leafOf("/Users/t/work/a")).toBe("a");
  });

  it("falls back to the whole path when there are no segments", () => {
    expect(leafOf("/")).toBe("/");
  });
});

describe("commonBasePath", () => {
  it("refuses a single path - there is no *shared* base to state", () => {
    expect(commonBasePath(["/Users/t/work/a"])).toBeNull();
  });

  it("returns the shared parent of two sibling paths", () => {
    expect(commonBasePath(["/Users/t/work/a", "/Users/t/work/b"])).toBe(
      "/Users/t/work",
    );
  });

  it("returns the shared parent even when depths differ", () => {
    expect(commonBasePath(["/Users/t/work/a/x", "/Users/t/work/b"])).toBe(
      "/Users/t/work",
    );
  });

  it("backs off one segment when the raw base would equal one of the paths, so every row keeps a name", () => {
    expect(commonBasePath(["/Users/t/work", "/Users/t/work/a"])).toBe(
      "/Users/t",
    );
  });

  it("refuses a base at the filesystem root - / is not news", () => {
    expect(commonBasePath(["/opt/a", "/srv/b"])).toBeNull();
  });

  it("refuses when the paths sit on different Windows drives", () => {
    expect(commonBasePath(["C:\\x\\a", "D:\\x\\b"])).toBeNull();
  });

  it("keeps a backslash inside a POSIX directory name as part of the base, not a split point", () => {
    const paths = ["/srv/foo\\bar/a", "/srv/foo\\bar/b"];
    const base = commonBasePath(paths);
    expect(base).toBe("/srv/foo\\bar");
    expect(base).not.toBeNull();
    const nonNullBase = base ?? "";
    expect(relativeTo(paths[0], nonNullBase)).toBe("a");
    expect(relativeTo(paths[1], nonNullBase)).toBe("b");
  });
});

describe("relativeTo", () => {
  it("strips the base and its separator from a path under it", () => {
    expect(relativeTo("/Users/t/work/a", "/Users/t/work")).toBe("a");
  });

  it("returns null for a path that does not sit under the base", () => {
    expect(relativeTo("/Users/t/other/a", "/Users/t/work")).toBeNull();
  });

  it("returns null for a path equal to the base - there is no remainder", () => {
    expect(relativeTo("/Users/t/work", "/Users/t/work")).toBeNull();
  });
});

describe("tildeCollapse", () => {
  it("collapses a path under home to a ~/ prefix", () => {
    expect(tildeCollapse("/Users/t/work/a", "/Users/t")).toBe("~/work/a");
  });

  it("collapses a path exactly equal to home to just ~", () => {
    expect(tildeCollapse("/Users/t", "/Users/t")).toBe("~");
  });

  it("leaves a path not under home unchanged", () => {
    expect(tildeCollapse("/opt/a", "/Users/t")).toBe("/opt/a");
  });

  it("leaves the path unchanged when home is null", () => {
    expect(tildeCollapse("/Users/t/work/a", null)).toBe("/Users/t/work/a");
  });
});

describe("commonBasePath on a UNC share", () => {
  it("keeps a separator between the share root and the first segment", () => {
    // A UNC root carries no trailing separator, unlike `/` and `C:\\`, so
    // joining segments straight onto it would fuse the share name to the
    // first segment and name a share that does not exist.
    const base = commonBasePath([
      "\\\\server\\share\\a\\x",
      "\\\\server\\share\\a\\y",
    ]);
    expect(base).toBe("\\\\server\\share\\a");
    expect(relativeTo("\\\\server\\share\\a\\x", base ?? "")).toBe("x");
    expect(relativeTo("\\\\server\\share\\a\\y", base ?? "")).toBe("y");
  });
});
