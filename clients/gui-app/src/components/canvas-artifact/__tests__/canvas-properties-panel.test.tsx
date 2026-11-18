import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpicEditArtboardResponse } from "@traycer/protocol/host/epic/artboard-edit";
import type { CanvasElement } from "@/lib/sandbox/canvas-bridge";
import { CanvasPropertiesPanel } from "../canvas-properties-panel";
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "../canvas-selection-store";
import type { CanvasEditVariables } from "../use-artboard-edit";

const ARTIFACT_ID = "canvas-1";
const DEBOUNCE_MS = 450;

interface PendingSave {
  readonly variables: CanvasEditVariables;
  readonly settle: (response: EpicEditArtboardResponse) => void;
  readonly fail: (error: Error) => void;
}

// Each save is a promise the test settles by hand, so the panel can be
// observed while the host is still answering.
const pendingSaves = vi.hoisted((): PendingSave[] => []);

vi.mock("../use-artboard-edit", async () => {
  const { useState } = await import("react");
  return {
    useArtboardEdit: () => {
      const [inFlight, setInFlight] = useState(0);
      return {
        isPending: inFlight > 0,
        mutateAsync: (variables: CanvasEditVariables) => {
          setInFlight((count) => count + 1);
          return new Promise<EpicEditArtboardResponse>((resolve, reject) => {
            pendingSaves.push({
              variables,
              settle: (response) => {
                setInFlight((count) => count - 1);
                resolve(response);
              },
              fail: (error) => {
                setInFlight((count) => count - 1);
                reject(error);
              },
            });
          });
        },
      };
    },
  };
});

// What the browser accepts is injected: only "banana" is not a value.
vi.mock("../artboard-css-validation", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../artboard-css-validation")>();
  return {
    ...original,
    browserSupportsCss: (_property: string, value: string): boolean =>
      value !== "banana",
  };
});

vi.mock("@/components/ui/agent-spinning-dots", () => ({
  AgentSpinningDots: () => <span data-testid="saving-spinner" />,
}));

function element(overrides: Partial<CanvasElement>): CanvasElement {
  return {
    marker: 12,
    tid: "t1",
    tagName: "div",
    selector: "div.hero",
    elementId: null,
    classNames: [],
    textPreview: "Hello",
    inlineStyle: "",
    ariaRole: null,
    accessibleName: null,
    box: { x: 0, y: 0, width: 100, height: 40 },
    computedStyles: [{ property: "width", value: "100px" }],
    generated: false,
    ...overrides,
  };
}

function selectionOf(
  elementOverrides: Partial<CanvasElement>,
  servedSha256: string,
): CanvasSelection {
  return {
    artifactId: ARTIFACT_ID,
    boardPath: "boards/home.html",
    page: null,
    servedSha256,
    element: element(elementOverrides),
    textRange: null,
  };
}

function inputLabelled(label: string): HTMLInputElement {
  const found = screen.getByLabelText(label);
  if (!(found instanceof HTMLInputElement)) throw new Error("not an input");
  return found;
}

function panel(): HTMLElement {
  return screen.getByRole("region", { name: "Element properties" });
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

async function settleSave(
  index: number,
  response: EpicEditArtboardResponse,
): Promise<void> {
  await act(async () => {
    pendingSaves[index].settle(response);
    await Promise.resolve();
  });
}

async function failSave(index: number): Promise<void> {
  await act(async () => {
    pendingSaves[index].fail(new Error("host unreachable"));
    await Promise.resolve();
  });
}

const REFUSED: EpicEditArtboardResponse = {
  ok: false,
  reason: "stale",
  detail: "The artboard changed. Select the element again and retry.",
};

const SAVED: EpicEditArtboardResponse = {
  ok: true,
  tid: "t1",
  sha256After: "a".repeat(64),
  splices: [],
};

describe("CanvasPropertiesPanel while a save is pending", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pendingSaves.length = 0;
    act(() => {
      useCanvasSelectionStore.getState().select(selectionOf({}, "sha-old"));
    });
  });

  afterEach(() => {
    cleanup();
    act(() => {
      useCanvasSelectionStore.getState().clear();
    });
    vi.useRealTimers();
  });

  it("keeps the edited field enabled and focused from typing through the save to the refreshed frame", async () => {
    render(<CanvasPropertiesPanel artifactId={ARTIFACT_ID} />);
    const width = inputLabelled("Width");
    width.focus();
    expect(document.activeElement).toBe(width);

    fireEvent.change(width, { target: { value: "200px" } });
    advance(DEBOUNCE_MS);

    // The debounced edit went out once, against the revision that was served.
    expect(pendingSaves).toHaveLength(1);
    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "set-style",
      property: "width",
      value: "200px",
    });
    expect(pendingSaves[0].variables.selection.servedSha256).toBe("sha-old");

    // Pending: the host has not answered, yet the person can keep typing.
    expect(panel().getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByTestId("saving-spinner")).not.toBeNull();
    expect(width.disabled).toBe(false);
    expect(inputLabelled("Height").disabled).toBe(false);
    expect(document.activeElement).toBe(width);

    await settleSave(0, SAVED);
    expect(width.disabled).toBe(false);
    expect(document.activeElement).toBe(width);

    // The replacement frame reports the new style and revision.
    act(() => {
      useCanvasSelectionStore
        .getState()
        .select(
          selectionOf(
            { computedStyles: [{ property: "width", value: "200px" }] },
            "sha-new",
          ),
        );
    });

    expect(inputLabelled("Width")).toBe(width);
    expect(document.activeElement).toBe(width);
    expect(width.value).toBe("200px");
    expect(width.disabled).toBe(false);
    expect(panel().getAttribute("aria-busy")).not.toBe("true");
    expect(screen.queryByTestId("saving-spinner")).toBeNull();
    // Nothing re-sent the committed value on the way.
    advance(DEBOUNCE_MS * 2);
    expect(pendingSaves).toHaveLength(1);
  });

  it("accepts the next edit while the first save is still pending", async () => {
    render(<CanvasPropertiesPanel artifactId={ARTIFACT_ID} />);
    const width = inputLabelled("Width");
    width.focus();

    fireEvent.change(width, { target: { value: "200px" } });
    advance(DEBOUNCE_MS);
    expect(pendingSaves).toHaveLength(1);

    fireEvent.change(width, { target: { value: "300px" } });
    advance(DEBOUNCE_MS);

    expect(pendingSaves).toHaveLength(2);
    expect(pendingSaves[1].variables.edit).toEqual({
      kind: "set-style",
      property: "width",
      value: "300px",
    });
    expect(width.value).toBe("300px");
    expect(document.activeElement).toBe(width);

    await settleSave(0, SAVED);
    expect(panel().getAttribute("aria-busy")).toBe("true");
    await settleSave(1, SAVED);
    expect(panel().getAttribute("aria-busy")).not.toBe("true");
    expect(document.activeElement).toBe(width);
  });

  it("keeps focus and shows the refusal when the host turns the edit down", async () => {
    render(<CanvasPropertiesPanel artifactId={ARTIFACT_ID} />);
    const width = inputLabelled("Width");
    width.focus();

    fireEvent.change(width, { target: { value: "200px" } });
    advance(DEBOUNCE_MS);
    await settleSave(0, {
      ok: false,
      reason: "stale",
      detail: "The artboard changed. Select the element again and retry.",
    });

    expect(screen.getByRole("status").textContent).toBe(
      "The artboard changed. Select the element again and retry.",
    );
    expect(document.activeElement).toBe(width);
    expect(width.disabled).toBe(false);
    expect(panel().getAttribute("aria-busy")).not.toBe("true");
  });

  it("disables the fields only for an element with no editable source", () => {
    act(() => {
      useCanvasSelectionStore
        .getState()
        .select(selectionOf({ marker: null, tid: null }, "sha-old"));
    });
    render(<CanvasPropertiesPanel artifactId={ARTIFACT_ID} />);

    expect(inputLabelled("Width").disabled).toBe(true);
    expect(
      screen.queryByText("Ask the agent to change this element."),
    ).not.toBeNull();
  });
  // A field is "saved" only once the host accepted it. A refusal or a failed
  // request leaves the person's text retryable instead of treating it as sent.
  for (const failure of ["refused", "failed"] as const) {
    const fail = (index: number): Promise<void> =>
      failure === "refused" ? settleSave(index, REFUSED) : failSave(index);
    const message =
      failure === "refused"
        ? REFUSED.detail
        : "The change could not be saved. Try again.";

    it(`shows the ${failure} save and sends the same value again on Enter`, async () => {
      render(<CanvasPropertiesPanel artifactId={ARTIFACT_ID} />);
      const width = inputLabelled("Width");
      width.focus();

      fireEvent.change(width, { target: { value: "200px" } });
      advance(DEBOUNCE_MS);
      expect(pendingSaves).toHaveLength(1);

      await fail(0);
      expect(screen.getByRole("status").textContent).toBe(message);
      expect(width.value).toBe("200px");

      fireEvent.keyDown(width, { key: "Enter" });
      expect(pendingSaves).toHaveLength(2);
      expect(pendingSaves[1].variables.edit).toEqual(
        pendingSaves[0].variables.edit,
      );
      expect(document.activeElement).toBe(width);

      await settleSave(1, SAVED);
      expect(screen.queryByRole("status")).toBeNull();
    });

    it(`sends the same value again on blur after a ${failure} save`, async () => {
      render(<CanvasPropertiesPanel artifactId={ARTIFACT_ID} />);
      const width = inputLabelled("Width");

      fireEvent.change(width, { target: { value: "200px" } });
      advance(DEBOUNCE_MS);
      await fail(0);

      fireEvent.blur(width);
      expect(pendingSaves).toHaveLength(2);
      expect(pendingSaves[1].variables.edit).toEqual({
        kind: "set-style",
        property: "width",
        value: "200px",
      });
    });

    it(`keeps text typed after a ${failure} save, and Escape returns to the saved value without a phantom edit`, async () => {
      render(<CanvasPropertiesPanel artifactId={ARTIFACT_ID} />);
      const width = inputLabelled("Width");
      width.focus();

      fireEvent.change(width, { target: { value: "200px" } });
      fireEvent.keyDown(width, { key: "Enter" });
      expect(pendingSaves).toHaveLength(1);
      // Newer text, typed while the first save is still being answered.
      fireEvent.change(width, { target: { value: "300px" } });
      advance(100);

      await fail(0);
      expect(width.value).toBe("300px");

      fireEvent.keyDown(width, { key: "Escape" });
      // The saved width, not the 200px that never was.
      expect(width.value).toBe("100px");
      fireEvent.blur(width);
      advance(DEBOUNCE_MS * 2);
      expect(pendingSaves).toHaveLength(1);
      expect(width.value).toBe("100px");
    });
  }

  it("refuses a locally invalid value without a save, keeps it, and sends it once it is fixed", () => {
    render(<CanvasPropertiesPanel artifactId={ARTIFACT_ID} />);
    const width = inputLabelled("Width");
    width.focus();

    fireEvent.change(width, { target: { value: "banana" } });
    fireEvent.keyDown(width, { key: "Enter" });

    expect(pendingSaves).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe(
      "Invalid value for width.",
    );
    expect(width.value).toBe("banana");

    // The same refused value is refused again, not remembered as sent.
    fireEvent.keyDown(width, { key: "Enter" });
    expect(pendingSaves).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe(
      "Invalid value for width.",
    );

    fireEvent.change(width, { target: { value: "200px" } });
    fireEvent.keyDown(width, { key: "Enter" });
    expect(pendingSaves).toHaveLength(1);
    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "set-style",
      property: "width",
      value: "200px",
    });
  });
});

// The inspector shows computed styles the way a design tool would, but only
// what the person types is ever written back.
describe("CanvasPropertiesPanel field display", () => {
  function selectComputed(
    computedStyles: readonly { property: string; value: string }[],
  ): void {
    act(() => {
      useCanvasSelectionStore
        .getState()
        .select(
          selectionOf({ computedStyles: [...computedStyles] }, "sha-old"),
        );
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    pendingSaves.length = 0;
  });

  afterEach(() => {
    cleanup();
    act(() => {
      useCanvasSelectionStore.getState().clear();
    });
    vi.useRealTimers();
  });

  it("shows colours as hex, font families and weights by name, and lengths in whole pixels", () => {
    selectComputed([
      { property: "color", value: "rgb(255, 136, 0)" },
      { property: "background-color", value: "rgba(0, 0, 0, 0.2)" },
      { property: "border-color", value: "rgba(0, 0, 0, 0)" },
      { property: "font-family", value: '"Helvetica Neue", Arial, sans-serif' },
      { property: "font-weight", value: "700" },
      { property: "font-size", value: "15.4px" },
      { property: "width", value: "100.6px" },
    ]);
    render(<CanvasPropertiesPanel artifactId={ARTIFACT_ID} />);

    expect(inputLabelled("Text colour").value).toBe("#ff8800");
    expect(inputLabelled("Background colour").value).toBe("#00000033");
    expect(inputLabelled("Border colour").value).toBe("transparent");
    expect(inputLabelled("Font family").value).toBe("Helvetica Neue");
    expect(inputLabelled("Font weight").value).toBe("Bold 700");
    expect(inputLabelled("Font size").value).toBe("15px");
    expect(inputLabelled("Width").value).toBe("101px");
  });

  it("writes nothing when a field that shows a simplified value is focused and left untouched", () => {
    selectComputed([
      { property: "width", value: "100.6px" },
      { property: "color", value: "rgb(255, 136, 0)" },
      { property: "font-weight", value: "400" },
    ]);
    render(<CanvasPropertiesPanel artifactId={ARTIFACT_ID} />);

    for (const label of ["Width", "Text colour", "Font weight"]) {
      const field = inputLabelled(label);
      field.focus();
      fireEvent.blur(field);
    }
    advance(DEBOUNCE_MS * 2);

    expect(pendingSaves).toHaveLength(0);
  });

  it("writes the weight number when a weight name is shown and the person edits it", () => {
    selectComputed([{ property: "font-weight", value: "400" }]);
    render(<CanvasPropertiesPanel artifactId={ARTIFACT_ID} />);
    const weight = inputLabelled("Font weight");
    expect(weight.value).toBe("Regular 400");

    fireEvent.change(weight, { target: { value: "Bold 700" } });
    fireEvent.blur(weight);

    expect(pendingSaves).toHaveLength(1);
    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "set-style",
      property: "font-weight",
      value: "700",
    });
  });

  it("writes what the person typed over a shown hex colour as typed", () => {
    selectComputed([{ property: "color", value: "rgb(255, 136, 0)" }]);
    render(<CanvasPropertiesPanel artifactId={ARTIFACT_ID} />);
    const colour = inputLabelled("Text colour");

    fireEvent.change(colour, { target: { value: "#112233" } });
    fireEvent.blur(colour);

    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "set-style",
      property: "color",
      value: "#112233",
    });
  });

  it("returns an abandoned edit to the shown value, not the raw computed one", () => {
    selectComputed([{ property: "width", value: "100.6px" }]);
    render(<CanvasPropertiesPanel artifactId={ARTIFACT_ID} />);
    const width = inputLabelled("Width");

    fireEvent.change(width, { target: { value: "5" } });
    fireEvent.keyDown(width, { key: "Escape" });
    fireEvent.blur(width);
    advance(DEBOUNCE_MS * 2);

    expect(width.value).toBe("101px");
    expect(pendingSaves).toHaveLength(0);
  });
});

describe("CanvasPropertiesPanel layout", () => {
  beforeEach(() => {
    pendingSaves.length = 0;
    act(() => {
      useCanvasSelectionStore.getState().select(selectionOf({}, "sha-old"));
    });
  });

  afterEach(() => {
    cleanup();
    act(() => {
      useCanvasSelectionStore.getState().clear();
    });
  });

  it("opens with every section expanded and no nested tabs", () => {
    render(<CanvasPropertiesPanel artifactId={ARTIFACT_ID} />);

    for (const name of [
      "Size",
      "Spacing",
      "Text",
      "Fill & border",
      "Visibility",
    ])
      expect(
        screen.getByRole("button", { name }).getAttribute("aria-expanded"),
      ).toBe("true");
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByLabelText("Element styles")).toBeNull();
    expect(screen.getByRole("switch", { name: "Hide element" })).toBeDefined();
    for (const label of ["Width", "Padding", "Font weight", "Alignment"])
      expect(inputLabelled(label)).toBeDefined();
  });

  it("collapses a section on its heading", () => {
    render(<CanvasPropertiesPanel artifactId={ARTIFACT_ID} />);
    const size = screen.getByRole("button", { name: "Size" });

    fireEvent.click(size);

    expect(size.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "Spacing" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("shows the editable CSS instead of the fields on the code tab, and saves it as the style attribute", async () => {
    act(() => {
      useCanvasSelectionStore
        .getState()
        .select(selectionOf({ inlineStyle: "color: red" }, "sha-old"));
    });
    render(<CanvasPropertiesPanel artifactId={ARTIFACT_ID} tab="code" />);

    expect(screen.queryByLabelText("Width")).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    const css = screen.getByLabelText("Element styles");
    expect(css).toHaveProperty("value", "color: red");

    fireEvent.change(css, { target: { value: "color: blue" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply styles" }));

    expect(pendingSaves).toHaveLength(1);
    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "set-attribute",
      name: "style",
      value: "color: blue",
    });
    await settleSave(0, SAVED);
  });
});
