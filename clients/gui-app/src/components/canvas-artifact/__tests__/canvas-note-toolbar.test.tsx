import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CanvasNote } from "@traycer/protocol/persistence/epic/canvas-layout";
import {
  CanvasNodeContext,
  type CanvasNodeActions,
} from "../canvas-node-context";
import { CanvasNoteProperties } from "../canvas-note-toolbar";

const NOTE_ID = "note-7";

type UpdateNote = (id: string, patch: CanvasNote) => void;

function mountProperties(note: CanvasNote): Mock<UpdateNote> {
  const updateNote = vi.fn<UpdateNote>();
  const actions: CanvasNodeActions = {
    viewOnly: false,
    selectionEnabled: true,
    panMode: false,
    onAddError: () => undefined,
    sourceForBoard: () => null,
    frameEvents: null,
    renameBoard: () => undefined,
    startPlay: () => undefined,
    play: false,
    fullscreenPath: null,
    navigation: {},
    resize: () => undefined,
    setNoteText: () => undefined,
    updateNote,
    editingNote: null,
    setEditingNote: () => undefined,
    fitBoardHeight: () => undefined,
    fullscreen: () => undefined,
  };
  render(
    <CanvasNodeContext.Provider value={actions}>
      <CanvasNoteProperties id={NOTE_ID} note={note} />
    </CanvasNodeContext.Provider>,
  );
  return updateNote;
}

const SIZE_BUTTONS = [
  "Small text",
  "Medium text",
  "Large text",
  "Extra large text",
] as const;

afterEach(cleanup);

describe("CanvasNoteProperties text size", () => {
  it.each([
    ["sticky", [14, 18, 24, 32]],
    ["title", [20, 30, 40, 56]],
  ] as const)("maps S, M, L and XL to the %s point sizes", (type, sizes) => {
    const updateNote = mountProperties({ type, text: "Hi" });
    SIZE_BUTTONS.forEach((name, index) => {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(updateNote).toHaveBeenLastCalledWith(NOTE_ID, {
        size: sizes[index],
      });
    });
    expect(updateNote).toHaveBeenCalledTimes(SIZE_BUTTONS.length);
  });

  it.each(["rect", "oval", "line", "arrow", "pen", "image"] as const)(
    "offers no text size for a %s",
    (type) => {
      mountProperties({ type });
      for (const name of SIZE_BUTTONS)
        expect(screen.queryByRole("button", { name })).toBeNull();
    },
  );
});

describe("CanvasNoteProperties colour", () => {
  // The same swatch means a different thing per note: a sticky is filled, a
  // title is text, a shape is stroked. Default resets to the surface's own
  // colour, which is the card for a sticky and the foreground otherwise.
  it.each([
    ["sticky", "Note colour", "var(--card)"],
    ["title", "Text colour", "var(--foreground)"],
    ["rect", "Stroke colour", "var(--foreground)"],
  ] as const)(
    "labels a %s's swatches %s and writes only the colour",
    (type, role, defaultColor) => {
      const updateNote = mountProperties({ type });
      fireEvent.click(screen.getByRole("button", { name: `${role}: Blue` }));
      fireEvent.click(screen.getByRole("button", { name: /Default$/ }));
      expect(updateNote).toHaveBeenCalledTimes(2);
      const [blue, reset] = updateNote.mock.calls;
      expect(blue[0]).toBe(NOTE_ID);
      expect(Object.keys(blue[1])).toEqual(["color"]);
      expect(blue[1].color).not.toBe(defaultColor);
      expect(reset).toEqual([NOTE_ID, { color: defaultColor }]);
    },
  );

  it("offers no colour for an image", () => {
    mountProperties({ type: "image" });
    expect(screen.queryByRole("button", { name: /colour:/ })).toBeNull();
  });
});
