import "../../../../__tests__/test-browser-apis";

import { describe, expect, it } from "vitest";
import { queryMountedChatFindUnit } from "@/components/chat/chat-find";

describe("queryMountedChatFindUnit", () => {
  it("resolves a unit id containing selector-significant characters", () => {
    const messageRoot = document.createElement("div");
    // Persisted segment/message ids flow into unit ids unescaped, so an id can
    // carry quotes, brackets, and backslashes that would break or mis-target a
    // raw `[data-chat-find-unit="..."]` attribute selector.
    const trickyUnitId = "segment:weird\"]\\:id [data-x='y']";
    const decoy = document.createElement("div");
    decoy.dataset.chatFindUnit = "segment:other";
    decoy.textContent = "decoy";
    const target = document.createElement("div");
    target.dataset.chatFindUnit = trickyUnitId;
    target.textContent = "target";
    messageRoot.append(decoy);
    messageRoot.append(target);

    expect(queryMountedChatFindUnit(messageRoot, trickyUnitId)).toBe(target);
    expect(queryMountedChatFindUnit(messageRoot, "segment:other")).toBe(decoy);
    expect(queryMountedChatFindUnit(messageRoot, "segment:missing")).toBeNull();
  });
});
