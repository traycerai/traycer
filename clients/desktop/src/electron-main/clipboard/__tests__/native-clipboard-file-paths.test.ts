import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseNativeClipboardFilePaths,
  readNativeClipboardFilePaths,
} from "../native-clipboard-file-paths";

const MIXED_FILENAME_PATHS = [
  "/tmp/short",
  "/repo/a long ASCII filename.txt",
  "/repo/naïve 文件.txt",
  "/repo/item-01.txt",
  "/repo/item-02.txt",
  "/repo/item-03.txt",
  "/repo/item-04.txt",
  "/repo/item-05.txt",
  "/repo/item-06.txt",
  "/repo/item-07.txt",
  "/repo/item-08.txt",
  "/repo/item-09.txt",
  "/repo/item-10.txt",
  "/repo/item-11.txt",
  "/repo/item-12.txt",
  "/repo/item-13.txt",
  "/repo/item-14.txt",
  "/repo/&lt;literal.txt",
] as const;

const MIXED_FILENAME_BINARY_PLIST = Buffer.from(
  readFileSync(
    resolve(
      process.cwd(),
      "src/electron-main/clipboard/__tests__/fixtures/native-filenames-mixed.bplist.base64",
    ),
    "utf8",
  ).trim(),
  "base64",
);

const MIXED_FILENAME_XML_PLIST = readFileSync(
  resolve(
    process.cwd(),
    "src/electron-main/clipboard/__tests__/fixtures/native-filenames-mixed.xml.plist",
  ),
);

describe("native clipboard file paths", () => {
  it("parses a single VS Code file URI", () => {
    expect(
      parseNativeClipboardFilePaths(
        "code/file-list",
        Buffer.from("file:///repo/notes.txt"),
      ),
    ).toEqual(["/repo/notes.txt"]);
  });

  it("parses newline-separated VS Code multi-select URIs and percent encoding", () => {
    expect(
      parseNativeClipboardFilePaths(
        "code/file-list",
        Buffer.from("file:///repo/beta.txt\nfile:///repo/alpha%20one.txt\n"),
      ),
    ).toEqual(["/repo/beta.txt", "/repo/alpha one.txt"]);
  });

  it("keeps a folder selection from the public file URL flavor", () => {
    expect(
      parseNativeClipboardFilePaths(
        "public.file-url",
        Buffer.from("file:///repo/folder-one"),
      ),
    ).toEqual(["/repo/folder-one"]);
  });

  it("parses NSFilenamesPboardType XML plists", () => {
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><array>',
      "<string>/repo/alpha one.txt</string>",
      "<string>/repo/folder&amp;notes</string>",
      "</array></plist>",
    ].join("");

    expect(
      parseNativeClipboardFilePaths(
        "NSFilenamesPboardType",
        Buffer.from(plist),
      ),
    ).toEqual(["/repo/alpha one.txt", "/repo/folder&notes"]);
  });

  it("parses a plutil-generated binary NSFilenamesPboardType fixture", () => {
    expect(
      parseNativeClipboardFilePaths(
        "NSFilenamesPboardType",
        MIXED_FILENAME_BINARY_PLIST,
      ),
    ).toEqual(MIXED_FILENAME_PATHS);
  });

  it("decodes XML entities in a single pass without corrupting literal entity text", () => {
    expect(
      parseNativeClipboardFilePaths(
        "NSFilenamesPboardType",
        MIXED_FILENAME_XML_PLIST,
      ),
    ).toEqual(MIXED_FILENAME_PATHS);
  });

  it("reads only the bounded native file-flavor allowlist", () => {
    const requestedFormats: string[] = [];
    const clipboard = {
      readBuffer: (format: string): Buffer => {
        requestedFormats.push(format);
        return format === "code/file-list"
          ? Buffer.from("file:///repo/notes.txt")
          : Buffer.alloc(0);
      },
    };

    expect(readNativeClipboardFilePaths(clipboard)).toEqual([
      "/repo/notes.txt",
    ]);
    expect(requestedFormats).toEqual([
      "code/file-list",
      "public.file-url",
      "NSFilenamesPboardType",
    ]);
  });
});
