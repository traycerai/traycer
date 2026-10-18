import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasBoardDocument } from "../canvas-board-document";
import type { CanvasSelection } from "../canvas-selection-store";
import { CanvasTextToolbar } from "../canvas-text-toolbar";
import {
  boardDocument,
  pendingSaves,
  quotedSelection,
  REFUSED,
  SAVED,
  settleSave,
  textSelection,
  withTextRange,
} from "./canvas-edit-test-support";

vi.mock("../use-artboard-edit", async () =>
  (await import("./canvas-edit-test-support")).artboardEditModule(),
);

const WAIT = "Wait for the artboard to finish loading.";
const CHANGED =
  "This text was changed by a script. Ask the agent to change it.";

// "Hello " 0-6, "big" 6-9, " world" 9-15.
const PLAIN_TEXT = "Hello big world";
const PLAIN = boardDocument(`<p data-tid="t">Hello big world</p>`);
const BOLD = boardDocument(`<p data-tid="t">Hello <b>big</b> world</p>`);
// "Go " 0-3, "here" 3-7, " now" 7-11.
const LINKED_TEXT = "Go here now";
const LINKED = boardDocument(`<p data-tid="t">Go <a href="x">here</a> now</p>`);

/** "big", the range every format test selects. */
const BIG = quotedSelection(PLAIN_TEXT, 6, 9, {});

function mount(
  selection: CanvasSelection,
  document: CanvasBoardDocument | null,
): { readonly outerPointerDown: () => void } {
  const outerPointerDown = vi.fn();
  render(
    <div role="presentation" onPointerDown={outerPointerDown}>
      <CanvasTextToolbar selection={selection} document={document} />
    </div>,
  );
  return { outerPointerDown };
}

function button(name: string): HTMLButtonElement {
  const found = screen.getByRole("button", { name });
  if (!(found instanceof HTMLButtonElement)) throw new Error("not a button");
  return found;
}

const CONTROLS = [
  "Bold",
  "Italic",
  "Underline",
  "Add link",
  "Align left",
  "Align centre",
  "Align right",
] as const;

beforeEach(() => {
  pendingSaves.length = 0;
});

afterEach(cleanup);

describe("CanvasTextToolbar visibility", () => {
  it.each([
    ["no text selection", textSelection(null, {})],
    ["a collapsed selection", textSelection({ start: 4, end: 4 }, {})],
    [
      "text in an element the page generated",
      textSelection({ start: 0, end: 4 }, { generated: true }),
    ],
  ])("shows nothing for %s", (_label, selection) => {
    mount(selection, PLAIN);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("floats above the first selected rectangle", () => {
    mount(BIG, PLAIN);
    const frame = screen.getByRole("toolbar", {
      name: "Text formatting",
    }).parentElement;
    expect(frame?.style.left).toBe("40px");
    expect(frame?.style.top).toBe("64px");
  });

  it("offers every control, all enabled for a range the source confirms", () => {
    mount(BIG, PLAIN);
    for (const name of CONTROLS) expect(button(name).disabled).toBe(false);
    expect(screen.queryByText(WAIT)).toBeNull();
    expect(screen.queryByText(CHANGED)).toBeNull();
  });
});

describe("CanvasTextToolbar only acts on text it has confirmed", () => {
  function expectAllDisabled(): void {
    for (const name of CONTROLS) expect(button(name).disabled).toBe(true);
  }

  it("waits for the board's source before offering anything", () => {
    mount(BIG, null);
    expectAllDisabled();
    expect(screen.getByText(WAIT)).toBeDefined();
  });

  it("waits when the source is a different revision from the one the page shows", () => {
    mount(BIG, { ...PLAIN, sha256: "sha-older" });
    expectAllDisabled();
    expect(screen.getByText(WAIT)).toBeDefined();
  });

  it("refuses a range whose quote is not what the source holds there", () => {
    mount(withTextRange(BIG, { quote: "bug" }), PLAIN);
    expectAllDisabled();
    expect(screen.getByText(CHANGED)).toBeDefined();
  });

  it("refuses a range that runs past the end of the source text", () => {
    mount(quotedSelection(PLAIN_TEXT, 10, 40, {}), PLAIN);
    expectAllDisabled();
    expect(screen.getByText(CHANGED)).toBeDefined();
  });

  it("refuses a range whose offsets are shifted by one", () => {
    mount(withTextRange(BIG, { start: 7, end: 10 }), PLAIN);
    expectAllDisabled();
  });

  it("sends nothing when a disabled control is pressed", () => {
    mount(BIG, null);
    for (const name of CONTROLS) fireEvent.click(button(name));
    expect(pendingSaves).toHaveLength(0);
  });

  it("checks the quote against the text as the page reads it, entities decoded", () => {
    const entity = boardDocument(`<p data-tid="t">a &amp; b</p>`);
    mount(quotedSelection("a & b", 2, 5, {}), entity);
    for (const name of CONTROLS) expect(button(name).disabled).toBe(false);
  });

  it("checks against the whole element's text across nested formatting", () => {
    mount(quotedSelection(PLAIN_TEXT, 3, 12, {}), BOLD);
    for (const name of CONTROLS) expect(button(name).disabled).toBe(false);
  });
});

describe("CanvasTextToolbar formatting", () => {
  it.each([
    ["Bold", "b"],
    ["Italic", "i"],
    ["Underline", "u"],
  ])(
    "%s wraps the selected range in <%s>, naming the text it expects",
    async (name, tag) => {
      mount(BIG, PLAIN);
      fireEvent.click(button(name));

      expect(pendingSaves).toHaveLength(1);
      expect(pendingSaves[0].variables.edit).toEqual({
        kind: "wrap-text-range",
        tag,
        start: 6,
        end: 9,
        href: null,
        expectedText: "big",
      });
      await settleSave(0, SAVED);
    },
  );

  it("shows which formats already cover the range", () => {
    mount(BIG, BOLD);
    expect(button("Bold").getAttribute("aria-pressed")).toBe("true");
    expect(button("Italic").getAttribute("aria-pressed")).toBe("false");
    expect(button("Underline").getAttribute("aria-pressed")).toBe("false");
  });

  it("removes a format the range already has instead of nesting another", async () => {
    mount(BIG, BOLD);
    fireEvent.click(button("Bold"));

    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "unwrap-text-range",
      tag: "b",
      start: 6,
      end: 9,
      expectedText: "big",
    });
    await settleSave(0, SAVED);
  });

  it("does not claim a format that covers only part of the range", () => {
    mount(quotedSelection(PLAIN_TEXT, 0, 9, {}), BOLD);
    expect(button("Bold").getAttribute("aria-pressed")).toBe("false");
  });

  it("sends the selection it was shown for, not whatever is selected later", () => {
    mount(BIG, PLAIN);
    fireEvent.click(button("Italic"));
    expect(pendingSaves[0].variables.selection).toBe(BIG);
  });

  it.each([
    ["Align left", "left"],
    ["Align centre", "center"],
    ["Align right", "right"],
  ])(
    "%s sets the element's text alignment, which needs no expected text",
    async (name, value) => {
      mount(BIG, PLAIN);
      fireEvent.click(button(name));

      expect(pendingSaves[0].variables.edit).toEqual({
        kind: "set-style",
        property: "text-align",
        value,
      });
      await settleSave(0, SAVED);
    },
  );

  it("disables every control while a change is being saved", async () => {
    mount(BIG, PLAIN);
    fireEvent.click(button("Bold"));
    for (const name of CONTROLS) expect(button(name).disabled).toBe(true);

    await settleSave(0, SAVED);
    expect(button("Bold").disabled).toBe(false);
  });

  it("shows the host's reason when it refuses and lets the person try again", async () => {
    mount(BIG, PLAIN);
    fireEvent.click(button("Bold"));
    await settleSave(0, REFUSED);

    expect(screen.getByRole("status").textContent).toBe(
      REFUSED.ok ? "" : REFUSED.detail,
    );
    expect(button("Bold").disabled).toBe(false);
  });
});

describe("CanvasTextToolbar links", () => {
  function openLinkForm(): HTMLFormElement {
    fireEvent.click(button("Add link"));
    const form = screen.getByRole("form", { name: "Link address" });
    if (!(form instanceof HTMLFormElement)) throw new Error("not a form");
    return form;
  }
  function typeAddress(value: string): void {
    fireEvent.change(screen.getByRole("textbox", { name: "Link URL" }), {
      target: { value },
    });
  }

  it("asks for an address, then wraps the range in a link to it", async () => {
    mount(BIG, PLAIN);
    const form = openLinkForm();
    typeAddress("https://example.com/page?q=1");
    fireEvent.submit(form);

    expect(pendingSaves).toHaveLength(1);
    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "wrap-text-range",
      tag: "a",
      start: 6,
      end: 9,
      href: "https://example.com/page?q=1",
      expectedText: "big",
    });
    expect(screen.queryByRole("form", { name: "Link address" })).toBeNull();
    await settleSave(0, SAVED);
  });

  it("accepts plain http", () => {
    mount(BIG, PLAIN);
    const form = openLinkForm();
    typeAddress("http://example.com");
    fireEvent.submit(form);
    expect(pendingSaves[0].variables.edit).toMatchObject({
      href: "http://example.com",
    });
  });

  it.each([
    ["a script address", "javascript:alert(1)"],
    ["a file address", "file:///etc/passwd"],
    ["an ftp address", "ftp://example.com"],
    ["a data address", "data:text/html,<p>x</p>"],
    ["something that is not an address", "not a url"],
    ["nothing", ""],
  ])("refuses %s and keeps the form open", (_label, address) => {
    mount(BIG, PLAIN);
    const form = openLinkForm();
    typeAddress(address);
    fireEvent.submit(form);

    expect(pendingSaves).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe(
      "Enter an http or https address.",
    );
    expect(screen.getByRole("form", { name: "Link address" })).toBeDefined();
  });

  it("clears the address error once a good address is applied", () => {
    mount(BIG, PLAIN);
    const form = openLinkForm();
    typeAddress("nope");
    fireEvent.submit(form);
    expect(screen.getByRole("status")).toBeDefined();

    typeAddress("https://example.com");
    fireEvent.submit(form);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("closes the form on Cancel without saving or complaining", () => {
    mount(BIG, PLAIN);
    openLinkForm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("form", { name: "Link address" })).toBeNull();
    expect(pendingSaves).toHaveLength(0);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("removes an existing link in one click, naming the text it expects", async () => {
    mount(quotedSelection(LINKED_TEXT, 3, 7, {}), LINKED);
    expect(button("Remove link").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button("Remove link"));

    expect(screen.queryByRole("form", { name: "Link address" })).toBeNull();
    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "unwrap-text-range",
      tag: "a",
      start: 3,
      end: 7,
      expectedText: "here",
    });
    await settleSave(0, SAVED);
  });
});

describe("CanvasTextToolbar and the text selection", () => {
  it("keeps a press on a button from collapsing the page's selection or reaching the board", () => {
    const { outerPointerDown } = mount(BIG, PLAIN);
    // false means preventDefault ran, so the frame keeps its selection.
    expect(fireEvent.pointerDown(button("Bold"))).toBe(false);
    expect(outerPointerDown).not.toHaveBeenCalled();
  });

  it("lets a press in the address field place a caret", () => {
    mount(BIG, PLAIN);
    fireEvent.click(button("Add link"));
    expect(
      fireEvent.pointerDown(screen.getByRole("textbox", { name: "Link URL" })),
    ).toBe(true);
  });
});
