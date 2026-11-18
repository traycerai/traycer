import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasElement } from "@/lib/sandbox/canvas-bridge";
import { canvasKnobValue } from "../canvas-tweak-value";
import {
  CanvasTweakKnob,
  CanvasTweaksPanel,
  CanvasTweaksSection,
} from "../canvas-tweaks-panel";
import {
  ARTIFACT_ID,
  BOARD_PATH,
  boardDocument,
  canvasElement,
  disposeBridges,
  pendingSaves,
  realBridge,
  REFUSED,
  registryServing,
  SAVED,
  settleSave,
} from "./canvas-edit-test-support";

vi.mock("../use-artboard-edit", async () =>
  (await import("./canvas-edit-test-support")).artboardEditModule(),
);

vi.mock("@/components/ui/agent-spinning-dots", () => ({
  AgentSpinningDots: () => <span data-testid="saving-spinner" />,
}));

const DELAY_MS = 450;

describe("canvasKnobValue", () => {
  it.each([
    ["#ff8800", { kind: "color", input: "#ff8800", unit: "" }],
    ["#F80", { kind: "color", input: "#FF8800", unit: "" }],
    ["12px", { kind: "number", input: "12", unit: "px" }],
    ["-1.5rem", { kind: "number", input: "-1.5", unit: "rem" }],
    [".5", { kind: "number", input: ".5", unit: "" }],
    ["50%", { kind: "number", input: "50", unit: "%" }],
    ["Georgia, serif", { kind: "text", input: "Georgia, serif", unit: "" }],
    ["calc(1px + 2px)", { kind: "text", input: "calc(1px + 2px)", unit: "" }],
    ["#12345", { kind: "text", input: "#12345", unit: "" }],
    ["1.2.3", { kind: "text", input: "1.2.3", unit: "" }],
    ["", { kind: "text", input: "", unit: "" }],
  ])("reads %j as the right kind of control", (value, expected) => {
    expect(canvasKnobValue(value)).toEqual(expected);
  });
});

describe("CanvasTweakKnob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function mount(value: string, onCommit: (value: string) => Promise<boolean>) {
    const view = render(
      <CanvasTweakKnob
        name="--gap"
        value={value}
        disabled={false}
        onCommit={onCommit}
      />,
    );
    return {
      ...view,
      show: (next: string, disabled: boolean): void =>
        view.rerender(
          <CanvasTweakKnob
            name="--gap"
            value={next}
            disabled={disabled}
            onCommit={onCommit}
          />,
        ),
    };
  }
  function field(): HTMLInputElement {
    const found = screen.getByLabelText("--gap");
    if (!(found instanceof HTMLInputElement)) throw new Error("not an input");
    return found;
  }
  function advance(ms: number): void {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }
  const accept = () => vi.fn((_value: string) => Promise.resolve(true));

  it("shows a number without its unit, and the unit beside it", () => {
    mount("12px", accept());
    expect(field().type).toBe("number");
    expect(field().value).toBe("12");
    expect(screen.getByText("px")).toBeDefined();
  });

  it("offers a colour picker for a colour, and a text box for anything else", () => {
    const { unmount } = mount("#ff0000", accept());
    expect(field().type).toBe("color");
    expect(field().value).toBe("#ff0000");
    unmount();
    mount("Georgia, serif", accept());
    expect(field().type).toBe("text");
  });

  it("commits the typed number with its unit after the typing pause, not before", () => {
    const onCommit = accept();
    mount("12px", onCommit);
    fireEvent.change(field(), { target: { value: "16" } });

    advance(DELAY_MS - 1);
    expect(onCommit).not.toHaveBeenCalled();
    advance(1);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("16px");
  });

  it("restarts the pause with every keystroke and commits only the last value", () => {
    const onCommit = accept();
    mount("12px", onCommit);
    fireEvent.change(field(), { target: { value: "16" } });
    advance(300);
    fireEvent.change(field(), { target: { value: "18" } });
    advance(300);
    expect(onCommit).not.toHaveBeenCalled();
    advance(150);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("18px");
  });

  it("commits at once on Enter and does not commit again when the pause ends", () => {
    const onCommit = accept();
    mount("12px", onCommit);
    fireEvent.change(field(), { target: { value: "20" } });
    fireEvent.keyDown(field(), { code: "Enter" });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("20px");

    advance(DELAY_MS * 2);
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("commits when focus leaves", () => {
    const onCommit = accept();
    mount("12px", onCommit);
    fireEvent.change(field(), { target: { value: "24" } });
    fireEvent.blur(field());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("24px");
  });

  it("commits nothing when the value did not change", () => {
    const onCommit = accept();
    mount("12px", onCommit);
    fireEvent.keyDown(field(), { code: "Enter" });
    fireEvent.blur(field());
    advance(DELAY_MS);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits a colour as picked, a text value as typed, and a cleared number as empty", () => {
    const onColour = accept();
    const colour = mount("#ff0000", onColour);
    fireEvent.change(field(), { target: { value: "#00ff00" } });
    fireEvent.blur(field());
    expect(onColour).toHaveBeenCalledWith("#00ff00");
    colour.unmount();

    const onText = accept();
    const text = mount("Georgia", onText);
    fireEvent.change(field(), { target: { value: "Helvetica, sans-serif" } });
    fireEvent.blur(field());
    expect(onText).toHaveBeenCalledWith("Helvetica, sans-serif");
    text.unmount();

    const onNumber = accept();
    mount("12px", onNumber);
    fireEvent.change(field(), { target: { value: "" } });
    fireEvent.blur(field());
    expect(onNumber).toHaveBeenCalledWith("");
  });

  it("drops a pending commit and the draft on Escape", () => {
    const onCommit = accept();
    mount("12px", onCommit);
    fireEvent.change(field(), { target: { value: "99" } });
    fireEvent.keyDown(field(), { code: "Escape" });
    advance(DELAY_MS * 2);

    expect(onCommit).not.toHaveBeenCalled();
    expect(field().value).toBe("12");
  });

  it("does not commit after it has left the screen", () => {
    const onCommit = accept();
    const view = mount("12px", onCommit);
    fireEvent.change(field(), { target: { value: "30" } });
    view.unmount();
    advance(DELAY_MS * 2);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("keeps the typed value when the host refuses it, and lets it be tried again", async () => {
    const onCommit = vi
      .fn((_value: string) => Promise.resolve(true))
      .mockResolvedValueOnce(false);
    mount("12px", onCommit);
    fireEvent.change(field(), { target: { value: "40" } });
    fireEvent.keyDown(field(), { code: "Enter" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(field().value).toBe("40");

    fireEvent.keyDown(field(), { code: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("treats a thrown commit like a refusal", async () => {
    const onCommit = vi
      .fn((_value: string) => Promise.resolve(true))
      .mockRejectedValueOnce(new Error("boom"));
    mount("12px", onCommit);
    fireEvent.change(field(), { target: { value: "40" } });
    fireEvent.keyDown(field(), { code: "Enter" });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.keyDown(field(), { code: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("follows the value the page reports once an edit is acknowledged", async () => {
    const view = mount("12px", accept());
    fireEvent.change(field(), { target: { value: "16" } });
    fireEvent.keyDown(field(), { code: "Enter" });
    await act(async () => {
      await Promise.resolve();
    });
    view.show("16px", false);
    expect(field().value).toBe("16");
  });

  it("keeps typing made after a submit when the earlier value is acknowledged", async () => {
    const view = mount("12px", accept());
    fireEvent.change(field(), { target: { value: "16" } });
    fireEvent.keyDown(field(), { code: "Enter" });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.change(field(), { target: { value: "20" } });
    view.show("16px", false);
    expect(field().value).toBe("20");
  });

  it("disables the control while the panel says so", () => {
    const view = mount("12px", accept());
    view.show("12px", true);
    expect(field().disabled).toBe(true);
  });
});

describe("CanvasTweaksPanel", () => {
  const page = (css: string): string =>
    `<!doctype html><html><head><style>${css}</style></head><body><p>hi</p></body></html>`;
  const TEXT = page(":root{--accent:#ff0000;--gap:12px;--font:Georgia}");
  const SHA = "sha-served";
  const rootMarker = (text: string): number => text.indexOf("<html");

  beforeEach(() => {
    vi.useFakeTimers();
    pendingSaves.length = 0;
  });
  afterEach(() => {
    cleanup();
    disposeBridges();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function mount(
    text: string,
    options: { readonly bridge: boolean; readonly sha: string | null },
  ) {
    const bridge = options.bridge ? realBridge() : null;
    const described = bridge
      ? vi.spyOn(bridge, "describeElement").mockImplementation((locator) =>
          Promise.resolve(
            "marker" in locator
              ? canvasElement({
                  marker: locator.marker,
                  tid: null,
                  tagName: "html",
                })
              : null,
          ),
        )
      : null;
    const board = boardDocument(text);
    render(
      <CanvasTweaksPanel
        artifactId={ARTIFACT_ID}
        boardPath={BOARD_PATH}
        document={{ ...board, sha256: SHA }}
        registry={registryServing(bridge, options.sha)}
      />,
    );
    return { described };
  }
  function knob(name: string): HTMLInputElement {
    const found = screen.getByLabelText(name);
    if (!(found instanceof HTMLInputElement)) throw new Error("not an input");
    return found;
  }
  async function commitByBlur(name: string, value: string): Promise<void> {
    fireEvent.change(knob(name), { target: { value } });
    await act(async () => {
      fireEvent.blur(knob(name));
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("lists the page's root custom properties as controls", () => {
    mount(TEXT, { bridge: true, sha: SHA });
    expect(screen.getByRole("region", { name: "Tweaks" })).toBeDefined();
    expect(knob("--accent").type).toBe("color");
    expect(knob("--gap").value).toBe("12");
    expect(knob("--font").type).toBe("text");
  });

  it.each([
    ["no :root rule", `<!doctype html><html><head></head><body></body></html>`],
    ["a :root with no custom properties", page(":root{color:red}")],
  ])("shows nothing for %s", (_label, text) => {
    mount(text, { bridge: true, sha: SHA });
    expect(screen.queryByRole("region", { name: "Tweaks" })).toBeNull();
  });

  it("saves a changed value against the document root, in the shape the host expects", async () => {
    const { described } = mount(TEXT, { bridge: true, sha: SHA });
    await commitByBlur("--gap", "16");

    expect(described).toHaveBeenCalledWith({ marker: rootMarker(TEXT) });
    expect(pendingSaves).toHaveLength(1);
    const { selection, edit } = pendingSaves[0].variables;
    expect(selection).toMatchObject({
      artifactId: ARTIFACT_ID,
      boardPath: BOARD_PATH,
      servedSha256: SHA,
      element: { marker: rootMarker(TEXT), tagName: "html" },
      textRange: null,
    });
    expect(edit).toEqual({
      kind: "set-css-variable",
      name: "--gap",
      value: "16px",
    });
    await settleSave(0, SAVED);
  });

  it("saves the typing pause's value too, not only a blur", async () => {
    mount(TEXT, { bridge: true, sha: SHA });
    fireEvent.change(knob("--font"), { target: { value: "Helvetica" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DELAY_MS);
    });
    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "set-css-variable",
      name: "--font",
      value: "Helvetica",
    });
    await settleSave(0, SAVED);
  });

  it("removes a property when its control is cleared", async () => {
    mount(TEXT, { bridge: true, sha: SHA });
    await commitByBlur("--gap", "");
    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "set-css-variable",
      name: "--gap",
      value: null,
    });
    await settleSave(0, SAVED);
  });

  it("keeps every control enabled, and says the panel is busy, while a change saves", async () => {
    mount(TEXT, { bridge: true, sha: SHA });
    expect(
      screen.getByRole("region", { name: "Tweaks" }).getAttribute("aria-busy"),
    ).toBe("false");
    expect(screen.queryByTestId("saving-spinner")).toBeNull();

    await commitByBlur("--gap", "16");
    for (const name of ["--accent", "--gap", "--font"])
      expect(knob(name).disabled).toBe(false);
    expect(
      screen.getByRole("region", { name: "Tweaks" }).getAttribute("aria-busy"),
    ).toBe("true");
    expect(screen.getByTestId("saving-spinner")).toBeDefined();

    await settleSave(0, SAVED);
    expect(
      screen.getByRole("region", { name: "Tweaks" }).getAttribute("aria-busy"),
    ).toBe("false");
    expect(screen.queryByTestId("saving-spinner")).toBeNull();
  });

  it("keeps focus and newer typing in the control that is being saved", async () => {
    mount(TEXT, { bridge: true, sha: SHA });
    knob("--gap").focus();
    await commitByBlur("--gap", "16");
    knob("--gap").focus();
    expect(document.activeElement).toBe(knob("--gap"));

    fireEvent.change(knob("--gap"), { target: { value: "18" } });
    expect(knob("--gap").value).toBe("18");
    expect(document.activeElement).toBe(knob("--gap"));

    await settleSave(0, SAVED);
    expect(knob("--gap").value).toBe("18");
    expect(document.activeElement).toBe(knob("--gap"));
  });

  it("lets a second control be saved while the first is still saving", async () => {
    mount(TEXT, { bridge: true, sha: SHA });
    await commitByBlur("--gap", "16");
    await commitByBlur("--font", "Helvetica");

    expect(pendingSaves.map((save) => save.variables.edit)).toEqual([
      { kind: "set-css-variable", name: "--gap", value: "16px" },
      { kind: "set-css-variable", name: "--font", value: "Helvetica" },
    ]);
  });

  it("shows the host's reason when it refuses, and keeps the typed value", async () => {
    mount(TEXT, { bridge: true, sha: SHA });
    await commitByBlur("--gap", "16");
    await settleSave(0, REFUSED);

    expect(screen.getByRole("status").textContent).toBe(
      REFUSED.ok ? "" : REFUSED.detail,
    );
    expect(knob("--gap").value).toBe("16");
  });

  it.each([
    ["the board has no bridge yet", { bridge: false, sha: SHA }],
    [
      "the board is showing a different revision",
      { bridge: true, sha: "sha-other" },
    ],
  ])(
    "asks the person to wait when %s, and saves nothing",
    async (_label, options) => {
      mount(TEXT, options);
      await commitByBlur("--gap", "16");
      expect(pendingSaves).toHaveLength(0);
      expect(screen.getByRole("status").textContent).toBe(
        "Wait for the artboard to finish loading.",
      );
    },
  );

  it("asks the person to wait when the page answers for a different element", async () => {
    const { described } = mount(TEXT, { bridge: true, sha: SHA });
    described?.mockImplementation(() =>
      Promise.resolve<CanvasElement>(
        canvasElement({ marker: 999, tagName: "html" }),
      ),
    );
    await commitByBlur("--gap", "16");
    expect(pendingSaves).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe(
      "Wait for the artboard to finish loading.",
    );
  });

  it("shows a plain message when the page cannot be asked", async () => {
    const { described } = mount(TEXT, { bridge: true, sha: SHA });
    described?.mockImplementation(() => Promise.reject(new Error("gone")));
    await commitByBlur("--gap", "16");
    expect(pendingSaves).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe(
      "The change could not be saved. Try again.",
    );
  });
});

describe("CanvasTweaksSection", () => {
  const properties = [
    { name: "--accent", value: "#ff0000", important: false },
    { name: "--gap", value: "12px", important: false },
  ] as const;
  const accept = (): ((name: string, value: string) => Promise<boolean>) =>
    vi.fn((_name: string, _value: string) => Promise.resolve(true));

  afterEach(cleanup);

  function mount(options: {
    readonly pending: boolean;
    readonly message: string | null;
    readonly onCommit: (name: string, value: string) => Promise<boolean>;
  }): void {
    render(
      <CanvasTweaksSection
        properties={properties}
        pending={options.pending}
        message={options.message}
        onCommit={options.onCommit}
      />,
    );
  }
  const region = (): HTMLElement =>
    screen.getByRole("region", { name: "Tweaks" });

  it("shows one control per property, enabled", () => {
    mount({ pending: false, message: null, onCommit: accept() });
    expect(screen.getByLabelText("--accent")).toHaveProperty("disabled", false);
    expect(screen.getByLabelText("--gap")).toHaveProperty("disabled", false);
  });

  it("is idle when nothing is saving", () => {
    mount({ pending: false, message: null, onCommit: accept() });
    expect(region().getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByTestId("saving-spinner")).toBeNull();
  });

  it("marks itself busy with a spinner while saving, and keeps its controls enabled", () => {
    mount({ pending: true, message: null, onCommit: accept() });
    expect(region().getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("saving-spinner")).toBeDefined();
    expect(screen.getByLabelText("--accent")).toHaveProperty("disabled", false);
    expect(screen.getByLabelText("--gap")).toHaveProperty("disabled", false);
  });

  it("shows the message it is given", () => {
    mount({ pending: false, message: "Nope.", onCommit: accept() });
    expect(screen.getByRole("status").textContent).toBe("Nope.");
  });

  it("commits a change under the name of the property that changed", async () => {
    const onCommit = accept();
    mount({ pending: true, message: null, onCommit });
    fireEvent.change(screen.getByLabelText("--gap"), {
      target: { value: "20" },
    });
    fireEvent.keyDown(screen.getByLabelText("--gap"), { code: "Enter" });
    await Promise.resolve();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("--gap", "20px");
  });
});
