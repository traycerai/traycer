import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { prependPlainTextToComposerDoc } from "@/lib/orchestration/inject-orchestration-prelude";

describe("prependPlainTextToComposerDoc", () => {
  it("prepends one paragraph per line ahead of the user doc", () => {
    const user: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "hello user" }],
        },
      ],
    };
    const out = prependPlainTextToComposerDoc(user, "line1\n\nline3");
    expect(out.type).toBe("doc");
    expect(out.content).toHaveLength(4);
    expect(out.content?.[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "line1" }],
    });
    expect(out.content?.[1]).toEqual({ type: "paragraph" });
    expect(out.content?.[2]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "line3" }],
    });
    expect(out.content?.[3]).toEqual(user.content?.[0]);
  });
});
