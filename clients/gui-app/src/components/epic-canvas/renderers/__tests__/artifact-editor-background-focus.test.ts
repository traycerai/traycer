import { describe, expect, it, vi } from "vitest";
import {
  resolveArtifactEditorBackgroundFocusPosition,
  shouldHandleArtifactEditorBackgroundFocus,
} from "../artifact-editor-background-focus";

interface MakeEditorParams {
  readonly isDestroyed: boolean;
  readonly isEmpty: boolean;
  readonly mappedPosition: {
    readonly pos: number;
    readonly inside: number;
  } | null;
  readonly rectTop: number;
  readonly rectBottom: number;
}

function makeEditor(params: MakeEditorParams) {
  const dom = document.createElement("div");
  Object.defineProperty(dom, "getBoundingClientRect", {
    value: () => ({
      x: 0,
      y: params.rectTop,
      width: 500,
      height: params.rectBottom - params.rectTop,
      top: params.rectTop,
      right: 500,
      bottom: params.rectBottom,
      left: 0,
      toJSON: () => ({}),
    }),
  });

  const posAtCoords = vi.fn(() => params.mappedPosition);

  return {
    editor: {
      isDestroyed: params.isDestroyed,
      isEmpty: params.isEmpty,
      view: {
        dom,
        posAtCoords,
      },
    },
    posAtCoords,
  };
}

describe("artifact editor background focus", () => {
  it("handles primary clicks on blank tile space", () => {
    const root = document.createElement("div");
    const blank = document.createElement("div");
    root.append(blank);
    const { editor } = makeEditor({
      isDestroyed: false,
      isEmpty: false,
      mappedPosition: null,
      rectTop: 10,
      rectBottom: 110,
    });
    root.append(editor.view.dom);

    expect(
      shouldHandleArtifactEditorBackgroundFocus({
        editor,
        eventButton: 0,
        eventTarget: blank,
        rootElement: root,
        clientX: 40,
      }),
    ).toBe(true);
  });

  it("ignores clicks already handled by the editor or editor controls", () => {
    const root = document.createElement("div");
    const toolbar = document.createElement("div");
    toolbar.className = "tc-editor-toolbar";
    const button = document.createElement("button");
    toolbar.append(button);
    root.append(toolbar);

    const { editor } = makeEditor({
      isDestroyed: false,
      isEmpty: false,
      mappedPosition: null,
      rectTop: 10,
      rectBottom: 110,
    });
    const paragraph = document.createElement("p");
    editor.view.dom.append(paragraph);
    root.append(editor.view.dom);

    expect(
      shouldHandleArtifactEditorBackgroundFocus({
        editor,
        eventButton: 0,
        eventTarget: paragraph,
        rootElement: root,
        clientX: 40,
      }),
    ).toBe(false);
    expect(
      shouldHandleArtifactEditorBackgroundFocus({
        editor,
        eventButton: 0,
        eventTarget: button,
        rootElement: root,
        clientX: 40,
      }),
    ).toBe(false);
  });

  it("ignores clicks in the scroll container's vertical scrollbar gutter", () => {
    const root = document.createElement("div");
    Object.defineProperties(root, {
      clientHeight: { value: 100 },
      clientWidth: { value: 180 },
      scrollHeight: { value: 400 },
    });
    Object.defineProperty(root, "getBoundingClientRect", {
      value: () => ({
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        top: 0,
        right: 200,
        bottom: 100,
        left: 0,
        toJSON: () => ({}),
      }),
    });
    const { editor } = makeEditor({
      isDestroyed: false,
      isEmpty: false,
      mappedPosition: null,
      rectTop: 10,
      rectBottom: 110,
    });
    root.append(editor.view.dom);

    expect(
      shouldHandleArtifactEditorBackgroundFocus({
        editor,
        eventButton: 0,
        eventTarget: root,
        rootElement: root,
        clientX: 190,
      }),
    ).toBe(false);
    expect(
      shouldHandleArtifactEditorBackgroundFocus({
        editor,
        eventButton: 0,
        eventTarget: root,
        rootElement: root,
        clientX: 120,
      }),
    ).toBe(true);
  });

  it("uses the placeholder start for empty documents", () => {
    const { editor, posAtCoords } = makeEditor({
      isDestroyed: false,
      isEmpty: true,
      mappedPosition: { pos: 8, inside: -1 },
      rectTop: 10,
      rectBottom: 110,
    });

    expect(resolveArtifactEditorBackgroundFocusPosition(editor, 40, 50)).toBe(
      "start",
    );
    expect(posAtCoords).not.toHaveBeenCalled();
  });

  it("uses ProseMirror coordinate mapping for populated documents", () => {
    const { editor, posAtCoords } = makeEditor({
      isDestroyed: false,
      isEmpty: false,
      mappedPosition: { pos: 42, inside: -1 },
      rectTop: 10,
      rectBottom: 110,
    });

    expect(resolveArtifactEditorBackgroundFocusPosition(editor, 40, 50)).toBe(
      42,
    );
    expect(posAtCoords).toHaveBeenCalledWith({
      left: 40,
      top: 50,
    });
  });

  it("falls back to document boundaries when blank space is outside content", () => {
    const { editor } = makeEditor({
      isDestroyed: false,
      isEmpty: false,
      mappedPosition: null,
      rectTop: 10,
      rectBottom: 110,
    });

    expect(resolveArtifactEditorBackgroundFocusPosition(editor, 40, 5)).toBe(
      "start",
    );
    expect(resolveArtifactEditorBackgroundFocusPosition(editor, 40, 140)).toBe(
      "end",
    );
  });
});
