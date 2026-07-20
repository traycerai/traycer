import { describe, expect, it } from "vitest";
import {
  parseNativeClipboardFilePaths,
  readNativeClipboardFilePaths,
} from "../native-clipboard-file-paths";

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
