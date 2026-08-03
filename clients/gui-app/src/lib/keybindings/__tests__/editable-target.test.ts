import "../../../../__tests__/test-browser-apis";
import { describe, expect, it } from "vitest";
import { isDiffsEditorEvent } from "@/lib/keybindings/editable-target";

describe("isDiffsEditorEvent", () => {
  it("recognizes a contenteditable reached through Diffs' composed shadow path", () => {
    const boundary = document.createElement("div");
    boundary.setAttribute("data-diffs-editor-boundary", "");
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    shadow.append(editor);
    boundary.append(host);
    document.body.append(boundary);
    const event = new KeyboardEvent("keydown", { key: "f", metaKey: true });
    Object.defineProperty(event, "composedPath", {
      value: () => [
        editor,
        shadow,
        host,
        boundary,
        document.body,
        document,
        window,
      ],
    });

    expect(isDiffsEditorEvent(event)).toBe(true);
    boundary.remove();
  });

  it("does not suppress keys from a regular contenteditable", () => {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    const event = new KeyboardEvent("keydown", { key: "f" });
    Object.defineProperty(event, "composedPath", {
      value: () => [editor, document.body, document, window],
    });
    expect(isDiffsEditorEvent(event)).toBe(false);
  });
});
