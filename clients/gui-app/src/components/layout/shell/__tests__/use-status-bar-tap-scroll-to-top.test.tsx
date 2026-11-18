/**
 * What an iOS status-bar tap does: whatever is in front scrolls back to its
 * top. "In front" is the newest visible modal dialog, else the bare screen,
 * and the scroll area is the OUTERMOST scrolling box under the first probe,
 * top-down, that lands in one.
 *
 * The shell is a fake `statusBarTap` capability; the hook, the request event
 * and the motion gate are real. jsdom lays nothing out, so each scroll area
 * states its own overflow, hit-testing is stubbed per test, and `scrollTo` is
 * a spy on the instance.
 */
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { IStatusBarTapHost } from "@traycer-clients/shared/platform/runner-host";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import { ScrollToTopRequestEvent } from "@/lib/dom/scroll-to-top-request";
import { useStatusBarTapScrollToTop } from "@/components/layout/shell/use-status-bar-tap-scroll-to-top";

class FakeStatusBarTap implements IStatusBarTapHost {
  private readonly handlers = new Set<() => void>();

  onTap(handler: () => void): { dispose: () => void } {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  tap(): void {
    for (const handler of this.handlers) handler();
  }

  get subscriberCount(): number {
    return this.handlers.size;
  }
}

interface ScrollArea {
  readonly element: HTMLElement;
  readonly scrollTo: Mock<(options: ScrollToOptions) => void>;
}

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const CLIENT_HEIGHT = 400;
const OVERFLOWING_SCROLL_HEIGHT = 1200;

/** A box that scrolls vertically; `overflows: false` leaves it nothing to scroll. */
function makeScrollArea(overflows: boolean): ScrollArea {
  const element = document.createElement("div");
  element.style.setProperty("overflow-y", "auto");
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: CLIENT_HEIGHT,
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: overflows ? OVERFLOWING_SCROLL_HEIGHT : CLIENT_HEIGHT,
  });
  const scrollTo = vi.fn<(options: ScrollToOptions) => void>();
  Object.defineProperty(element, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  return { element, scrollTo };
}

/** A rendered dialog layer occupying the given rectangle. */
function makeDialog(rect: Rect): HTMLElement {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  const boundingRect = {
    ...rect,
    x: rect.left,
    y: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
  };
  Object.defineProperty(dialog, "getBoundingClientRect", {
    configurable: true,
    value: () => boundingRect,
  });
  Object.defineProperty(dialog, "getClientRects", {
    configurable: true,
    value: () => [boundingRect],
  });
  return dialog;
}

function contains(rect: Rect, x: number, y: number): boolean {
  return (
    x >= rect.left &&
    x <= rect.left + rect.width &&
    y >= rect.top &&
    y <= rect.top + rect.height
  );
}

function stubHitTest(
  elementAt: (x: number, y: number) => Element | null,
): void {
  vi.spyOn(document, "elementFromPoint").mockImplementation(elementAt);
}

function mount(statusBarTap: IStatusBarTapHost | null) {
  return renderHook(() => useStatusBarTapScrollToTop(), {
    wrapper: ({ children }) => (
      <RunnerHostProvider runnerHost={createFakeRunnerHost({ statusBarTap })}>
        {children}
      </RunnerHostProvider>
    ),
  });
}

function tapStatusBar(statusBarTap: FakeStatusBarTap): void {
  act(() => statusBarTap.tap());
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  useThemeLibraryStore.setState({ panelAnimations: true });
});

describe("useStatusBarTapScrollToTop", () => {
  // A nested scroller (a code block, a tool's output) scrolls inside the
  // transcript, never around it; the user means the screen's own list.
  it("scrolls the outermost scrolling ancestor, not a nested scroller", () => {
    const page = makeScrollArea(true);
    const nested = makeScrollArea(true);
    const target = document.createElement("span");
    page.element.append(nested.element);
    nested.element.append(target);
    document.body.append(page.element);
    stubHitTest(() => target);
    const statusBarTap = new FakeStatusBarTap();
    mount(statusBarTap);

    tapStatusBar(statusBarTap);

    expect(page.scrollTo).toHaveBeenCalledExactlyOnceWith({
      top: 0,
      behavior: "smooth",
    });
    expect(nested.scrollTo).not.toHaveBeenCalled();
  });

  // The keyboard overlays the app, so a long draft pushes the chat's
  // composer far up the screen. Probing top-down meets the transcript first.
  it("meets the screen's list before a composer docked low on the screen", () => {
    const header = document.createElement("header");
    const transcript = makeScrollArea(true);
    const composer = makeScrollArea(true);
    document.body.append(header, transcript.element, composer.element);
    stubHitTest((_x, y) => {
      if (y < window.innerHeight * 0.15) return header;
      if (y < window.innerHeight * 0.35) return transcript.element;
      return composer.element;
    });
    const statusBarTap = new FakeStatusBarTap();
    mount(statusBarTap);

    tapStatusBar(statusBarTap);

    expect(transcript.scrollTo).toHaveBeenCalledTimes(1);
    expect(composer.scrollTo).not.toHaveBeenCalled();
  });

  it("skips an ancestor that has overflow set but nothing to scroll", () => {
    const wrapper = makeScrollArea(false);
    const list = makeScrollArea(true);
    const target = document.createElement("span");
    wrapper.element.append(list.element);
    list.element.append(target);
    document.body.append(wrapper.element);
    stubHitTest(() => target);
    const statusBarTap = new FakeStatusBarTap();
    mount(statusBarTap);

    tapStatusBar(statusBarTap);

    expect(list.scrollTo).toHaveBeenCalledTimes(1);
    expect(wrapper.scrollTo).not.toHaveBeenCalled();
  });

  it("does nothing when nothing on screen scrolls", () => {
    const flat = makeScrollArea(false);
    document.body.append(flat.element);
    stubHitTest(() => flat.element);
    const statusBarTap = new FakeStatusBarTap();
    mount(statusBarTap);

    tapStatusBar(statusBarTap);

    expect(flat.scrollTo).not.toHaveBeenCalled();
  });

  it("scrolls without animation when panel animations are off", () => {
    useThemeLibraryStore.setState({ panelAnimations: false });
    const page = makeScrollArea(true);
    document.body.append(page.element);
    stubHitTest(() => page.element);
    const statusBarTap = new FakeStatusBarTap();
    mount(statusBarTap);

    tapStatusBar(statusBarTap);

    expect(page.scrollTo).toHaveBeenCalledExactlyOnceWith({
      top: 0,
      behavior: "instant",
    });
  });

  describe("with dialogs open", () => {
    const DIALOG_RECT: Rect = { left: 10, top: 200, width: 200, height: 300 };

    /** The page behind, and a dialog whose body scrolls. */
    function mountPageAndDialog(): {
      readonly page: ScrollArea;
      readonly dialog: HTMLElement;
      readonly dialogBody: ScrollArea;
    } {
      const page = makeScrollArea(true);
      const dialogBody = makeScrollArea(true);
      const dialog = makeDialog(DIALOG_RECT);
      dialog.append(dialogBody.element);
      document.body.append(page.element, dialog);
      stubHitTest((x, y) =>
        contains(DIALOG_RECT, x, y) ? dialogBody.element : page.element,
      );
      return { page, dialog, dialogBody };
    }

    it("scrolls the open dialog instead of the screen", () => {
      const { page, dialogBody } = mountPageAndDialog();
      const statusBarTap = new FakeStatusBarTap();
      mount(statusBarTap);

      tapStatusBar(statusBarTap);

      expect(dialogBody.scrollTo).toHaveBeenCalledTimes(1);
      expect(page.scrollTo).not.toHaveBeenCalled();
    });

    // A modal layer seals what is beneath it - the dialog primitives with
    // aria-hidden, the nav drawer with inert - so a sealed dialog is covered.
    it.each([
      ["aria-hidden", "true"],
      ["inert", ""],
    ])("ignores a dialog sealed with %s", (attribute, value) => {
      const { page, dialog, dialogBody } = mountPageAndDialog();
      const sealed = document.createElement("div");
      sealed.setAttribute(attribute, value);
      sealed.append(dialog);
      document.body.append(sealed);
      const statusBarTap = new FakeStatusBarTap();
      mount(statusBarTap);

      tapStatusBar(statusBarTap);

      expect(page.scrollTo).toHaveBeenCalledTimes(1);
      expect(dialogBody.scrollTo).not.toHaveBeenCalled();
    });

    // A coachmark floats over the screen without owning it.
    it("ignores a non-modal dialog", () => {
      const { page, dialog, dialogBody } = mountPageAndDialog();
      dialog.setAttribute("aria-modal", "false");
      const statusBarTap = new FakeStatusBarTap();
      mount(statusBarTap);

      tapStatusBar(statusBarTap);

      expect(page.scrollTo).toHaveBeenCalledTimes(1);
      expect(dialogBody.scrollTo).not.toHaveBeenCalled();
    });

    it("picks the newest rendered dialog", () => {
      const olderRect: Rect = { left: 0, top: 0, width: 100, height: 100 };
      const newerRect: Rect = { left: 300, top: 40, width: 120, height: 80 };
      const olderBody = makeScrollArea(true);
      const newerBody = makeScrollArea(true);
      const olderDialog = makeDialog(olderRect);
      const newerDialog = makeDialog(newerRect);
      // Last in document order but never rendered (display: none): it has no
      // client rects, so the newer visible one in front of it still wins.
      const unrenderedDialog = document.createElement("div");
      unrenderedDialog.setAttribute("role", "alertdialog");
      olderDialog.append(olderBody.element);
      newerDialog.append(newerBody.element);
      document.body.append(olderDialog, newerDialog, unrenderedDialog);
      stubHitTest((x, y) => {
        if (contains(newerRect, x, y)) return newerBody.element;
        if (contains(olderRect, x, y)) return olderBody.element;
        return null;
      });
      const statusBarTap = new FakeStatusBarTap();
      mount(statusBarTap);

      tapStatusBar(statusBarTap);

      expect(newerBody.scrollTo).toHaveBeenCalledTimes(1);
      expect(olderBody.scrollTo).not.toHaveBeenCalled();
    });
  });

  it("finds a scroller inside a shadow root", () => {
    const host = document.createElement("div");
    const shadowRoot = host.attachShadow({ mode: "open" });
    const inner = makeScrollArea(true);
    shadowRoot.append(inner.element);
    document.body.append(host);
    // The document hit-tests to the host; the shadow root answers with the
    // box inside it. jsdom implements neither.
    stubHitTest(() => host);
    Object.defineProperty(shadowRoot, "elementFromPoint", {
      configurable: true,
      value: () => inner.element,
    });
    const statusBarTap = new FakeStatusBarTap();
    mount(statusBarTap);

    tapStatusBar(statusBarTap);

    expect(inner.scrollTo).toHaveBeenCalledTimes(1);
  });

  // The chat transcript owns its position, so it listens on a stable
  // ancestor, answers with preventDefault and moves itself.
  it("leaves the scroll to a listener that prevents the default", () => {
    const container = document.createElement("div");
    const page = makeScrollArea(true);
    container.append(page.element);
    document.body.append(container);
    stubHitTest(() => page.element);
    const requests: ScrollToTopRequestEvent[] = [];
    container.addEventListener(ScrollToTopRequestEvent.type, (event) => {
      if (!(event instanceof ScrollToTopRequestEvent)) return;
      requests.push(event);
      event.preventDefault();
    });
    const statusBarTap = new FakeStatusBarTap();
    mount(statusBarTap);

    tapStatusBar(statusBarTap);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.target).toBe(page.element);
    expect(requests[0]?.animated).toBe(true);
    expect(page.scrollTo).not.toHaveBeenCalled();
  });

  describe("subscription", () => {
    it("attaches nothing when the shell has no status-bar tap", () => {
      const hitTest = vi.spyOn(document, "elementFromPoint");

      expect(() => mount(null)).not.toThrow();

      expect(hitTest).not.toHaveBeenCalled();
    });

    it("subscribes once and detaches on unmount", () => {
      const statusBarTap = new FakeStatusBarTap();
      const page = makeScrollArea(true);
      document.body.append(page.element);
      stubHitTest(() => page.element);

      const view = mount(statusBarTap);
      expect(statusBarTap.subscriberCount).toBe(1);
      view.unmount();
      tapStatusBar(statusBarTap);

      expect(statusBarTap.subscriberCount).toBe(0);
      expect(page.scrollTo).not.toHaveBeenCalled();
    });
  });
});
