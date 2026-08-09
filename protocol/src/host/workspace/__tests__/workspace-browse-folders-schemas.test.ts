import { describe, expect, it } from "vitest";
import {
  workspaceBrowseFolderEntrySchema,
  workspaceBrowseFoldersRequestSchema,
  workspaceBrowseFoldersResponseSchema,
} from "../unary-schemas";

/**
 * `workspace.browseFolders` carries HOST-native absolute paths in both
 * directions. The wire contract enforces that rather than trusting the
 * endpoints: a relative request resolves against the host service's working
 * directory, and a relative response path can be submitted straight to
 * `workspace.prepareFolders` without passing the picker's typed-path check.
 */
describe("workspace.browseFolders absolute-path contract", () => {
  const ABSOLUTE = [
    "/",
    "/srv/app",
    "C:\\",
    "C:\\Users\\alice",
    // Windows accepts forward slashes too, so the picker may send them.
    "C:/Users/alice",
    "\\\\server\\share",
    "\\\\server\\share\\proj",
  ];

  const RELATIVE = ["", ".", "..", "projects", "./projects", "~", "~/projects"];

  it.each(ABSOLUTE)("accepts the absolute host path %j", (path) => {
    expect(workspaceBrowseFoldersRequestSchema.parse({ directoryPath: path }))
      .toEqual({ directoryPath: path });
  });

  it.each(RELATIVE)("rejects the relative path %j on a request", (path) => {
    expect(
      workspaceBrowseFoldersRequestSchema.safeParse({ directoryPath: path })
        .success,
    ).toBe(false);
  });

  it("still allows a null request path, which means the host home", () => {
    expect(
      workspaceBrowseFoldersRequestSchema.parse({ directoryPath: null }),
    ).toEqual({ directoryPath: null });
  });

  it.each(RELATIVE)("rejects the relative entry path %j", (path) => {
    expect(
      workspaceBrowseFolderEntrySchema.safeParse({ path, name: "x" }).success,
    ).toBe(false);
  });

  it("rejects a relative directoryPath on a response", () => {
    expect(
      workspaceBrowseFoldersResponseSchema.safeParse({
        directoryPath: "projects",
        parentPath: null,
        entries: [],
      }).success,
    ).toBe(false);
  });

  it("rejects a relative parentPath on a response", () => {
    expect(
      workspaceBrowseFoldersResponseSchema.safeParse({
        directoryPath: "/srv",
        parentPath: "..",
        entries: [],
      }).success,
    ).toBe(false);
  });

  it("accepts a well-formed response, parentPath null only at a root", () => {
    const response = {
      directoryPath: "\\\\server\\share",
      parentPath: null,
      entries: [{ path: "\\\\server\\share\\web", name: "web" }],
    };
    expect(workspaceBrowseFoldersResponseSchema.parse(response)).toEqual(
      response,
    );
  });
});
