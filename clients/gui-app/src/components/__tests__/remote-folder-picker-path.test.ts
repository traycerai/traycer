import { describe, expect, it } from "vitest";
import type { WorkspaceBrowseFoldersResponseV11 } from "@traycer/protocol/host/workspace/unary-schemas";
import {
  filterEntries,
  parseBrowseInput,
  readAddTarget,
  readShownInput,
  readUpPath,
  shouldCreateDirectory,
} from "@/components/remote-folder-picker-path";

const POSIX_HOME: WorkspaceBrowseFoldersResponseV11 = {
  directoryPath: "/Users/tester",
  parentPath: "/Users",
  entries: [
    { path: "/Users/tester/.config", name: ".config", hidden: true },
    { path: "/Users/tester/code", name: "code", hidden: false },
  ],
};

const WINDOWS_HOME: WorkspaceBrowseFoldersResponseV11 = {
  directoryPath: "C:\\Users\\tester",
  parentPath: "C:\\Users",
  entries: [
    {
      path: "C:\\Users\\tester\\AppData",
      name: "AppData",
      hidden: true,
    },
    { path: "C:\\Users\\tester\\code", name: "code", hidden: false },
    {
      path: "C:\\Users\\tester\\Documents",
      name: "Documents",
      hidden: false,
    },
  ],
};

describe("remote folder picker path model", () => {
  it("preserves POSIX backslashes and trailing whitespace", () => {
    expect(parseBrowseInput("/Users/tester/foo\\bar", "/Users/tester")).toEqual(
      {
        valid: true,
        directoryPath: "/Users/tester",
        filter: "foo\\bar",
      },
    );
    expect(readAddTarget("/srv/project ", null, undefined)).toBe(
      "/srv/project ",
    );
    expect(readAddTarget("   ", "/Users/tester", POSIX_HOME)).toBeNull();
  });

  it("keeps hidden folders discoverable by preference or dot prefix", () => {
    expect(filterEntries(POSIX_HOME.entries, "", false)).toEqual([
      POSIX_HOME.entries[1],
    ]);
    expect(filterEntries(POSIX_HOME.entries, "", true)).toEqual(
      POSIX_HOME.entries,
    );
    expect(filterEntries(POSIX_HOME.entries, ".c", false)).toEqual([
      POSIX_HOME.entries[0],
    ]);
    expect(filterEntries(WINDOWS_HOME.entries, "", false)).toEqual(
      WINDOWS_HOME.entries.slice(1),
    );
  });

  it("creates only a missing final segment from a successful listing", () => {
    const missing = parseBrowseInput("/Users/tester/new-app", "/Users/tester");
    expect(
      shouldCreateDirectory("/Users/tester/new-app", missing, POSIX_HOME, null),
    ).toBe(true);
    expect(
      shouldCreateDirectory(
        "/Users/tester/code",
        parseBrowseInput("/Users/tester/code", "/Users/tester"),
        POSIX_HOME,
        null,
      ),
    ).toBe(false);
    expect(
      shouldCreateDirectory(
        "/Users/tester/new-app",
        missing,
        undefined,
        new Error("listing failed"),
      ),
    ).toBe(false);
  });

  it("parses Windows drive paths without rewriting separators", () => {
    expect(readShownInput(null, WINDOWS_HOME, null)).toBe(
      "C:\\Users\\tester\\",
    );
    expect(
      parseBrowseInput("C:\\Users\\tester\\co", WINDOWS_HOME.directoryPath),
    ).toEqual({
      valid: true,
      directoryPath: "C:\\Users\\tester",
      filter: "co",
    });
    expect(
      readAddTarget(
        "C:\\Users\\tester\\",
        WINDOWS_HOME.directoryPath,
        WINDOWS_HOME,
      ),
    ).toBe("C:\\Users\\tester");
    expect(
      readAddTarget("C:\\", WINDOWS_HOME.directoryPath, WINDOWS_HOME),
    ).toBe("C:\\");
  });

  it("expands tilde and accepts forward separators for a Windows home", () => {
    expect(parseBrowseInput("~\\co", WINDOWS_HOME.directoryPath)).toEqual({
      valid: true,
      directoryPath: WINDOWS_HOME.directoryPath,
      filter: "co",
    });
    expect(parseBrowseInput("~/co", WINDOWS_HOME.directoryPath)).toEqual({
      valid: true,
      directoryPath: WINDOWS_HOME.directoryPath,
      filter: "co",
    });
  });

  it("treats drive and UNC roots as navigation fixpoints", () => {
    const driveRoot = parseBrowseInput("C:\\", WINDOWS_HOME.directoryPath);
    expect(readUpPath(undefined, driveRoot)).toBe("C:\\");

    for (const root of ["\\\\build\\shared", "//build/shared"]) {
      const parsed = parseBrowseInput(root, WINDOWS_HOME.directoryPath);
      expect(parsed).toEqual({
        valid: true,
        directoryPath: root,
        filter: "",
      });
      expect(readUpPath(undefined, parsed)).toBe(root);
    }
  });

  it("rejects drive-relative paths", () => {
    expect(
      parseBrowseInput("Users\\tester", WINDOWS_HOME.directoryPath),
    ).toEqual({
      valid: false,
      directoryPath: null,
      filter: "",
    });
  });
});
