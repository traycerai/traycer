import { describe, expect, it } from "vitest";
import { isTextHistoryShortcut } from "../text-history-shortcut";

function event(fields: {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
}): {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
} {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...fields,
  };
}

describe("isTextHistoryShortcut", () => {
  it("recognises Cmd+Z as undo on mac, case-insensitively", () => {
    expect(
      isTextHistoryShortcut(event({ key: "z", metaKey: true }), true),
    ).toBe(true);
    expect(
      isTextHistoryShortcut(event({ key: "Z", metaKey: true }), true),
    ).toBe(true);
  });

  it("recognises Shift+Cmd+Z as redo on mac", () => {
    expect(
      isTextHistoryShortcut(
        event({ key: "z", metaKey: true, shiftKey: true }),
        true,
      ),
    ).toBe(true);
  });

  it("does not recognise Ctrl+Z on mac (Control is not the mac history modifier)", () => {
    expect(
      isTextHistoryShortcut(event({ key: "z", ctrlKey: true }), true),
    ).toBe(false);
  });

  it("does not recognise Cmd+Ctrl+Z on mac (an extra modifier changes the chord)", () => {
    expect(
      isTextHistoryShortcut(
        event({ key: "z", metaKey: true, ctrlKey: true }),
        true,
      ),
    ).toBe(false);
  });

  it("does not recognise a bare Cmd+Y on mac (not the mac redo spelling)", () => {
    expect(
      isTextHistoryShortcut(event({ key: "y", metaKey: true }), true),
    ).toBe(false);
  });

  it("recognises Ctrl+Z as undo off mac", () => {
    expect(
      isTextHistoryShortcut(event({ key: "z", ctrlKey: true }), false),
    ).toBe(true);
  });

  it("recognises Ctrl+Shift+Z as redo off mac", () => {
    expect(
      isTextHistoryShortcut(
        event({ key: "z", ctrlKey: true, shiftKey: true }),
        false,
      ),
    ).toBe(true);
  });

  it("recognises bare Ctrl+Y as redo off mac", () => {
    expect(
      isTextHistoryShortcut(event({ key: "y", ctrlKey: true }), false),
    ).toBe(true);
  });

  it("does not recognise Shift+Ctrl+Y off mac (Ctrl+Y is only unshifted)", () => {
    expect(
      isTextHistoryShortcut(
        event({ key: "y", ctrlKey: true, shiftKey: true }),
        false,
      ),
    ).toBe(false);
  });

  it("does not recognise Cmd+Z off mac (Meta is not the non-mac history modifier)", () => {
    expect(
      isTextHistoryShortcut(event({ key: "z", metaKey: true }), false),
    ).toBe(false);
  });

  it("never recognises an Alt-modified chord, on either platform", () => {
    expect(
      isTextHistoryShortcut(
        event({ key: "z", metaKey: true, altKey: true }),
        true,
      ),
    ).toBe(false);
    expect(
      isTextHistoryShortcut(
        event({ key: "z", ctrlKey: true, altKey: true }),
        false,
      ),
    ).toBe(false);
  });

  it("does not recognise an unrelated key under the history modifier", () => {
    expect(
      isTextHistoryShortcut(event({ key: "a", metaKey: true }), true),
    ).toBe(false);
    expect(
      isTextHistoryShortcut(event({ key: "a", ctrlKey: true }), false),
    ).toBe(false);
  });

  it("is case-insensitive on the redo-Y spelling off mac", () => {
    expect(
      isTextHistoryShortcut(event({ key: "Y", ctrlKey: true }), false),
    ).toBe(true);
  });
});
