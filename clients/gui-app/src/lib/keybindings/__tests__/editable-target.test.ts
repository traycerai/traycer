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
    // jsdom does not compute `isContentEditable` from the attribute (it has
    // no layout/editing-host implementation), so stub the browser-computed
    // property directly - `isDiffsEditorEvent` reads only that, not the raw
    // attribute, so a real browser's `true` here must be simulated by hand.
    Object.defineProperty(editor, "isContentEditable", {
      value: true,
      configurable: true,
    });
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

  it('does not treat an explicit contenteditable="false" node inside the boundary as editable', () => {
    // Regression for treating attribute PRESENCE as editable: a Diffs
    // boundary can contain non-editable chrome (line numbers, gutters) that
    // explicitly opts out via contenteditable="false". Reserved shortcut
    // handling (e.g. digit chords) must stay active for those nodes instead
    // of being swallowed as if they were inside the real editor surface.
    const boundary = document.createElement("div");
    boundary.setAttribute("data-diffs-editor-boundary", "");
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const nonEditable = document.createElement("div");
    nonEditable.setAttribute("contenteditable", "false");
    Object.defineProperty(nonEditable, "isContentEditable", {
      value: false,
      configurable: true,
    });
    shadow.append(nonEditable);
    boundary.append(host);
    document.body.append(boundary);
    const event = new KeyboardEvent("keydown", { key: "1", metaKey: true });
    Object.defineProperty(event, "composedPath", {
      value: () => [
        nonEditable,
        shadow,
        host,
        boundary,
        document.body,
        document,
        window,
      ],
    });

    expect(isDiffsEditorEvent(event)).toBe(false);
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
