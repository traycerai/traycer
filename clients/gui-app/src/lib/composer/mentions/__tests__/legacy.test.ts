import { describe, expect, it } from "vitest";
import { createLegacyMentionAttachment } from "../legacy";

describe("createLegacyMentionAttachment browser-tab rehydration", () => {
  it("rebuilds a reference-only browser-tab attachment from the LLM token's title", () => {
    const mention = createLegacyMentionAttachment("browser-tab:GitHub");
    expect(mention).toEqual({
      kind: "mention",
      contextType: "browser-tab",
      path: "browser-tab:GitHub",
      pathKind: null,
      relPath: null,
      absolutePath: null,
      workspacePath: null,
      label: "GitHub",
      description: "",
      tabId: "",
      sessionId: "",
      url: "",
    });
  });

  it("falls back to a plain file mention for an unrelated path", () => {
    const mention = createLegacyMentionAttachment("src/index.ts");
    expect(mention.contextType).toBe("file");
  });
});
