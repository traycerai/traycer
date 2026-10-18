import { describe, expect, it } from "vitest";
import { mcpAppDownloadCopy } from "@/lib/sandbox/mcp-app-download-copy";

describe("mcpAppDownloadCopy", () => {
  const SAVE = "The linear app wants to save:";
  const OPEN = "The linear app wants to open:";
  const BOTH = "The linear app wants to save and open:";
  it.each([
    {
      files: 1,
      links: 0,
      title: "Save this file?",
      description: SAVE,
      confirm: "Save",
    },
    {
      files: 3,
      links: 0,
      title: "Save 3 files?",
      description: SAVE,
      confirm: "Save",
    },
    {
      files: 0,
      links: 1,
      title: "Open this link?",
      description: OPEN,
      confirm: "Open",
    },
    {
      files: 0,
      links: 2,
      title: "Open 2 links?",
      description: OPEN,
      confirm: "Open",
    },
    {
      files: 3,
      links: 2,
      title: "Save 3 files and open 2 links?",
      description: BOTH,
      confirm: "Save and open",
    },
    {
      files: 1,
      links: 1,
      title: "Save this file and open this link?",
      description: BOTH,
      confirm: "Save and open",
    },
  ])("$files file(s) and $links link(s) read $title", (row) => {
    expect(mcpAppDownloadCopy("linear", row.files, row.links)).toEqual({
      title: row.title,
      description: row.description,
      confirm: row.confirm,
    });
  });

  it("groups a large count the reader's way", () => {
    expect(mcpAppDownloadCopy("linear", 1284, 0).title).toBe(
      `Save ${new Intl.NumberFormat().format(1284)} files?`,
    );
  });
});
