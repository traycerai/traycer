import { describe, expect, it } from "vitest";
import { mentionAttachmentFromSuggestion } from "../attachments";
import type { BrowserTabMentionEntry } from "@/lib/composer/types";

function browserTabEntry(
  fields: Partial<BrowserTabMentionEntry>,
): BrowserTabMentionEntry {
  return {
    kind: "browser-tab",
    id: "browser-tab:chat-host:s1:tab-1",
    tabId: "tab-1",
    sessionId: "s1",
    hostId: "chat-host",
    hostLabel: null,
    coordinatorKey: "coord-1",
    contextOnly: false,
    label: "Example",
    url: "https://example.com",
    coLocated: false,
    lastActivityAt: 0,
    dormant: false,
    ...fields,
  };
}

describe("mentionAttachmentFromSuggestion browser-tab entries", () => {
  it("emits a browser-tab: drive token for a same-host entry", () => {
    const attachment = mentionAttachmentFromSuggestion(
      browserTabEntry({ contextOnly: false }),
    );
    expect(attachment).toEqual({
      kind: "mention",
      contextType: "browser-tab",
      path: "browser-tab:tab-1",
      pathKind: null,
      relPath: null,
      absolutePath: null,
      workspacePath: null,
      label: "Example",
      description: "",
      tabId: "tab-1",
      sessionId: "s1",
      url: "https://example.com",
    });
  });

  // The serializer renders a tab mention's `tabId` unconditionally, so a
  // cross-host pick must never reach it as a `browser-tab:` token - the agent
  // could never attach to a tab living on another host. Cross-host picks go
  // through `browserTabPreviewRequest` instead (spec decision #10); this null
  // is the backstop for any other call site that reaches a contextOnly entry.
  it("returns null for a contextOnly (cross-host) entry", () => {
    const attachment = mentionAttachmentFromSuggestion(
      browserTabEntry({ contextOnly: true, hostId: "other-host" }),
    );
    expect(attachment).toBeNull();
  });
});
