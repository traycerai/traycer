import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ArtboardEdit } from "@traycer/protocol/host/epic/artboard-edit";
import { CanvasCodeTab } from "../canvas-code-tab";

// The scanner is the code under test; what the browser accepts is injected so
// the outcome does not depend on the test environment's CSS parser.
vi.mock("../artboard-css-validation", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../artboard-css-validation")>();
  return {
    ...original,
    browserSupportsCss: (_property: string, value: string): boolean =>
      value !== "banana",
  };
});

interface TabOptions {
  inlineStyle: string;
  disabled: boolean;
  pending: boolean;
}

function renderTab(overrides: Partial<TabOptions>) {
  const options: TabOptions = {
    inlineStyle: "",
    disabled: false,
    pending: false,
    ...overrides,
  };
  const onApply = vi.fn((_edits: readonly ArtboardEdit[]) =>
    Promise.resolve(true),
  );
  const onMessage = vi.fn((_message: string | null) => undefined);
  render(
    <CanvasCodeTab
      inlineStyle={options.inlineStyle}
      disabled={options.disabled}
      pending={options.pending}
      onApply={onApply}
      onMessage={onMessage}
    />,
  );
  const textarea = screen.getByLabelText("Element styles");
  const applyButton = screen.getByRole("button", { name: "Apply styles" });
  return {
    onApply,
    onMessage,
    textarea,
    applyButton,
    write: (text: string) =>
      fireEvent.change(textarea, { target: { value: text } }),
    apply: () => fireEvent.click(applyButton),
  };
}

function styleWrite(value: string | null): readonly ArtboardEdit[] {
  return [{ kind: "set-attribute", name: "style", value }];
}

describe("CanvasCodeTab", () => {
  afterEach(cleanup);

  describe("validation happens before anything is written", () => {
    it("applies nothing and names the first invalid declaration when a later one is bad", () => {
      const subject = renderTab({});
      subject.write("color: red; width: banana; height: banana");
      subject.apply();

      expect(subject.onApply).not.toHaveBeenCalled();
      expect(subject.onMessage.mock.calls).toEqual([
        ["Invalid declaration: width: banana"],
      ]);
    });

    it("refuses an unbalanced value the same way", () => {
      const subject = renderTab({});
      subject.write("color: red; width: calc(1px");
      subject.apply();

      expect(subject.onApply).not.toHaveBeenCalled();
      expect(subject.onMessage.mock.calls).toEqual([
        ["Invalid declaration: width: calc(1px"],
      ]);
    });
  });

  describe("a valid style is written as one whole attribute", () => {
    it("sends a single style write holding exactly the typed text, and clears the message", async () => {
      const subject = renderTab({ inlineStyle: "color: red" });
      subject.write("color: blue; width: 10px");
      subject.apply();

      await waitFor(() => expect(subject.onApply).toHaveBeenCalledTimes(1));
      expect(subject.onApply.mock.calls[0][0]).toEqual(
        styleWrite("color: blue; width: 10px"),
      );
      expect(subject.onMessage.mock.calls).toEqual([[null]]);
    });

    it("keeps the author's order, duplicates, comments and spacing byte for byte", async () => {
      const text =
        "margin-left: 5px;\n  margin: 10px; /* reset */\ncolor: red;\ncolor: blue !important";
      const subject = renderTab({
        inlineStyle: "margin: 10px; margin-left: 5px",
      });
      subject.write(text);
      subject.apply();

      await waitFor(() => expect(subject.onApply).toHaveBeenCalledTimes(1));
      expect(subject.onApply.mock.calls[0][0]).toEqual(styleWrite(text));
    });

    it("sends a reordered style as written, not as a per-property plan", async () => {
      const subject = renderTab({
        inlineStyle: "margin: 10px; margin-left: 5px",
      });
      subject.write("margin-left: 5px; margin: 10px");
      subject.apply();

      await waitFor(() => expect(subject.onApply).toHaveBeenCalledTimes(1));
      expect(subject.onApply.mock.calls[0][0]).toEqual(
        styleWrite("margin-left: 5px; margin: 10px"),
      );
    });

    it("sends the whole smaller style when a declaration was deleted, not a removal edit", async () => {
      const subject = renderTab({ inlineStyle: "color: red; width: 10px" });
      subject.write("color: red");
      subject.apply();

      await waitFor(() => expect(subject.onApply).toHaveBeenCalledTimes(1));
      expect(subject.onApply.mock.calls[0][0]).toEqual(
        styleWrite("color: red"),
      );
    });

    it("removes the style attribute when the text is emptied", async () => {
      const subject = renderTab({ inlineStyle: "color: red" });
      subject.write("");
      subject.apply();

      await waitFor(() => expect(subject.onApply).toHaveBeenCalledTimes(1));
      expect(subject.onApply.mock.calls[0][0]).toEqual(styleWrite(null));
    });

    it("treats whitespace-only text as empty", async () => {
      const subject = renderTab({ inlineStyle: "color: red" });
      subject.write(" \n ");
      subject.apply();

      await waitFor(() => expect(subject.onApply).toHaveBeenCalledTimes(1));
      expect(subject.onApply.mock.calls[0][0]).toEqual(styleWrite(null));
    });
  });

  describe("disabled and pending", () => {
    it("keeps the textarea editable, and only the Apply button locked, while a save is pending", () => {
      const subject = renderTab({ pending: true });
      expect(subject.textarea).toHaveProperty("disabled", false);
      expect(subject.applyButton).toHaveProperty("disabled", true);
    });

    it("locks both when the element has no editable source", () => {
      const subject = renderTab({ disabled: true });
      expect(subject.textarea).toHaveProperty("disabled", true);
      expect(subject.applyButton).toHaveProperty("disabled", true);
    });

    it("leaves both usable when idle and editable", () => {
      const subject = renderTab({});
      expect(subject.textarea).toHaveProperty("disabled", false);
      expect(subject.applyButton).toHaveProperty("disabled", false);
    });
  });
});

// The host answers a save in two notifications that can arrive in either order:
// the mutation settling (`pending` falls, `onApply` resolves) and the frame
// refreshing the element's style (`inlineStyle` changes). Text typed while the
// first save was in flight must survive both orders.
describe("CanvasCodeTab after a save is acknowledged while newer text is typed", () => {
  afterEach(cleanup);

  const OLD = "color: red";
  const TEXT_A = "color:blue";
  const TEXT_B = "color: green";

  interface HeldTab {
    readonly onApply: Mock<
      (edits: readonly ArtboardEdit[]) => Promise<boolean>
    >;
    readonly textarea: () => HTMLTextAreaElement;
    readonly write: (text: string) => void;
    readonly apply: () => void;
    readonly props: (inlineStyle: string, pending: boolean) => void;
    readonly settleSave: (index: number, ok: boolean) => Promise<void>;
  }

  function renderHeldTab(): HeldTab {
    const settlers: ((ok: boolean) => void)[] = [];
    const onApply = vi.fn(
      (_edits: readonly ArtboardEdit[]) =>
        new Promise<boolean>((resolve) => {
          settlers.push(resolve);
        }),
    );
    const element = (inlineStyle: string, pending: boolean) => (
      <CanvasCodeTab
        inlineStyle={inlineStyle}
        disabled={false}
        pending={pending}
        onApply={onApply}
        onMessage={() => undefined}
      />
    );
    const view = render(element(OLD, false));
    const textarea = (): HTMLTextAreaElement => {
      const found = screen.getByLabelText("Element styles");
      if (!(found instanceof HTMLTextAreaElement))
        throw new Error("not a textarea");
      return found;
    };
    return {
      onApply,
      textarea,
      write: (text) =>
        fireEvent.change(textarea(), { target: { value: text } }),
      apply: () =>
        fireEvent.click(screen.getByRole("button", { name: "Apply styles" })),
      props: (inlineStyle, pending) =>
        view.rerender(element(inlineStyle, pending)),
      settleSave: async (index, ok) => {
        await act(async () => {
          settlers[index](ok);
          await Promise.resolve();
        });
      },
    };
  }

  /** Sends A, then types B while A is in flight. */
  function sendAThenTypeB(subject: HeldTab): HTMLTextAreaElement {
    const box = subject.textarea();
    box.focus();
    subject.write(TEXT_A);
    subject.apply();
    subject.props(OLD, true);
    expect(subject.onApply.mock.calls.map(([edits]) => edits)).toEqual([
      styleWrite(TEXT_A),
    ]);
    subject.write(TEXT_B);
    return box;
  }

  const ORDERS = [
    {
      label: "the frame refreshes before the save settles",
      acknowledge: async (subject: HeldTab, refreshed: string) => {
        subject.props(refreshed, true);
        await subject.settleSave(0, true);
        subject.props(refreshed, false);
      },
    },
    {
      label: "the save settles before the frame refreshes",
      acknowledge: async (subject: HeldTab, refreshed: string) => {
        await subject.settleSave(0, true);
        subject.props(OLD, false);
        subject.props(refreshed, false);
      },
    },
  ] as const;

  for (const order of ORDERS) {
    it(`keeps the newer text and applies it once against the refreshed baseline when ${order.label}`, async () => {
      const subject = renderHeldTab();
      const box = sendAThenTypeB(subject);

      await order.acknowledge(subject, TEXT_A);

      expect(subject.textarea()).toBe(box);
      expect(document.activeElement).toBe(box);
      expect(box.value).toBe(TEXT_B);

      subject.apply();
      expect(subject.onApply.mock.calls.map(([edits]) => edits)).toEqual([
        styleWrite(TEXT_A),
        styleWrite(TEXT_B),
      ]);
    });

    it(`shows the refreshed style when nothing newer was typed and ${order.label}`, async () => {
      const subject = renderHeldTab();
      const box = subject.textarea();
      box.focus();
      subject.write(TEXT_A);
      subject.apply();
      subject.props(OLD, true);

      // The frame reports the normalised spelling of what was sent.
      await order.acknowledge(subject, "color: blue");

      expect(subject.textarea()).toBe(box);
      expect(document.activeElement).toBe(box);
      expect(box.value).toBe("color: blue");
      // Nothing changed since, so Apply sends nothing more.
      subject.apply();
      expect(subject.onApply).toHaveBeenCalledTimes(1);
    });
  }

  it("keeps the newer text and lets it be retried when the first save fails", async () => {
    const subject = renderHeldTab();
    sendAThenTypeB(subject);

    await subject.settleSave(0, false);
    subject.props(OLD, false);

    expect(subject.textarea().value).toBe(TEXT_B);
    subject.apply();
    expect(subject.onApply.mock.calls.map(([edits]) => edits)).toEqual([
      styleWrite(TEXT_A),
      styleWrite(TEXT_B),
    ]);
  });
});
