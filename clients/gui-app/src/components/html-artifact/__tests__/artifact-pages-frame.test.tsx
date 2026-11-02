import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxFrameProps } from "@/components/sandbox/sandbox-frame";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { ArtifactManifest } from "@/lib/sandbox/artifact-serving";

/**
 * The page is a sandboxed iframe on a custom scheme, which jsdom will not
 * load, so this keeps the props the frame was last given and lets a test play
 * the part of the served document. Both halves of the contract are there: what
 * the document reports, and what the frame is asked for next — which is the
 * only way to see a retry, since the reader asks for the SAME page again and
 * the ask therefore shows up in `visit` rather than in `path`.
 */
const frames = vi.hoisted(() => ({ latest: null as SandboxFrameProps | null }));

vi.mock("@/components/sandbox/sandbox-frame", () => ({
  SandboxFrame: (props: SandboxFrameProps) => {
    frames.latest = props;
    return <div data-testid="page-frame" />;
  },
}));

import { ArtifactPagesFrame } from "@/components/html-artifact/artifact-pages-frame";
import {
  disposeBridges,
  realBridge,
} from "@/components/canvas-artifact/__tests__/canvas-edit-test-support";

function manifestOf(pages: readonly string[]): ArtifactManifest {
  const files: Record<string, ArtifactManifest["files"][string]> = {};
  for (const page of pages) {
    files[page] = {
      sha256: `sha-${page}`,
      byteLength: 10,
      mediaType: "text/html; charset=utf-8",
      status: "published",
    };
  }
  return { files };
}

interface PagesOptions {
  /** Every page of the artifact; the first is the entry page. */
  readonly pages: readonly string[];
  /** `null` fills the tile; a number is a row in the chat. */
  readonly height: number | null;
  readonly pageZoom: boolean;
  /** The caller's rows for the chip's "More actions" menu. */
  readonly menuItems: ReactNode;
}

const FILLING_ONE_PAGE: PagesOptions = {
  pages: ["index.html"],
  height: null,
  pageZoom: false,
  menuItems: undefined,
};

function renderPages(overrides: Partial<PagesOptions>) {
  const options = { ...FILLING_ONE_PAGE, ...overrides };
  render(
    <ArtifactPagesFrame
      source={{
        kind: "artifact",
        artifactId: "artifact-a1",
        treePath: "site",
        entryPath: options.pages[0],
        manifest: manifestOf(options.pages),
        // Never called: the frame that would mount a server is the stand-in
        // above. What a refused read SERVES is the artifact server's own test.
        readSpan: () => Promise.resolve({ unavailable: "failed" }),
        resolveOutsideReference: () => null,
      }}
      title="Report"
      className=""
      height={options.height}
      pageZoom={options.pageZoom}
      onSize={() => undefined}
      onStatus={() => undefined}
      onBridge={null}
      onTextSelection={null}
      onFrame={null}
      renderOverlay={null}
      sourceEquivalent={undefined}
      menuItems={options.menuItems}
    />,
  );
  const navigation = (): NonNullable<SandboxFrameProps["pageNavigation"]> => {
    const value = frames.latest?.pageNavigation ?? null;
    if (value === null) throw new Error("expected a page navigation");
    return value;
  };
  /** What the served document reports, committed before the test looks. */
  const report = (
    what: (
      navigation: NonNullable<SandboxFrameProps["pageNavigation"]>,
    ) => void,
  ): void => {
    act(() => what(navigation()));
  };
  return { navigation, report };
}

const UNREACHABLE = "Couldn't load this page from its host.";
const MISSING = "This page is not in the artifact.";

afterEach(() => {
  cleanup();
  disposeBridges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  frames.latest = null;
});

describe("a served page the host would not hand over", () => {
  /**
   * The defect: the shell answers an unreadable artifact body with its error
   * status, whose body is the wire reason, and the frame renders that — the
   * reader is shown the bare word "failed" where the page should be.
   */
  it("says the page could not be loaded, and names where from", () => {
    const { report } = renderPages({});

    report((navigation) => navigation.onPageUnreachable());

    expect(screen.getByText(UNREACHABLE)).toBeTruthy();
  });

  /**
   * Retry has to ask for the page the reader wanted, not send them home: the
   * page that failed is usually the entry page, so Home is the same broken
   * document. `visit` is what carries the ask, because `path` has not changed.
   */
  it("asks for the same page again on Retry, and clears the overlay", async () => {
    const user = userEvent.setup();
    const { navigation, report } = renderPages({});
    // Off the entry page first, which is what lets this tell Retry from Home:
    // on the entry page the two are indistinguishable - Home's path, empty
    // back stack and bumped visit are all what Retry leaves behind.
    report((page) => page.onNavigate("report.html"));
    report((page) => page.onPageUnreachable());
    const before = navigation();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(navigation().path).toBe("report.html");
    expect(navigation().visit).toBe(before.visit + 1);
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
  });

  /**
   * A page the folder LACKS and a page whose bytes did not arrive are
   * different answers, and the reader gets a different sentence and a
   * different offer for each. One load has one answer, so the second report
   * must displace the first rather than stack a second overlay over it.
   */
  it("replaces the missing-page answer when a later load is unreachable instead", () => {
    const { report } = renderPages({});

    report((page) => page.onPageMissing());
    expect(screen.getByText(MISSING)).toBeTruthy();

    report((page) => page.onPageUnreachable());

    expect(screen.getByText(UNREACHABLE)).toBeTruthy();
    expect(screen.queryByText(MISSING)).toBeNull();
    expect(screen.queryByRole("button", { name: "Go home" })).toBeNull();
  });

  it("clears the overlay once a page does load", () => {
    const { report } = renderPages({});
    report((page) => page.onPageUnreachable());
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

    report((page) => page.onNavigate("index.html"));

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

const TWO_PAGES = ["index.html", "report.html"];

function button(name: string): HTMLButtonElement {
  const found = screen.getByRole("button", { name });
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`${name} is not a button`);
  }
  return found;
}

function openMoreActions(): void {
  // Radix opens the menu on pointerdown, not on the click event.
  fireEvent.pointerDown(button("More actions"), { button: 0 });
}

function menuItemNames(): string[] {
  return screen.getAllByRole("menuitem").map((item) => item.textContent.trim());
}

function frameProps(): SandboxFrameProps {
  if (frames.latest === null) throw new Error("expected a mounted frame");
  return frames.latest;
}

describe("the floating controls chip", () => {
  it("asks the page for a typed zoom level, and shows the level the page then reports", () => {
    renderPages({ pageZoom: true });
    const bridge = realBridge();
    const setHtmlView = vi.spyOn(bridge, "setHtmlView");
    act(() => frameProps().onBridge?.(bridge));
    act(() => frameProps().onStatus("ready"));
    setHtmlView.mockClear();
    const zoomLevel = screen.getByLabelText<HTMLInputElement>("Zoom level");

    fireEvent.change(zoomLevel, { target: { value: "150" } });
    fireEvent.keyDown(zoomLevel, { key: "Enter" });

    expect(setHtmlView).toHaveBeenCalledTimes(1);
    expect(setHtmlView).toHaveBeenCalledWith(true, 1.5);
    // The field follows the page, not the draft: it reads 100% until the page reports 1.5.
    expect(zoomLevel.value).toBe("100%");
    act(() => frameProps().onHtmlZoom?.(1.5));
    expect(zoomLevel.value).toBe("150%");
  });

  it("offers no Back or Home on an artifact with one page", () => {
    renderPages({ pageZoom: true });

    expect(
      screen.getByRole("toolbar", { name: "HTML artifact controls" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
  });

  it("offers Back and Home from the first page of an artifact with several, both disabled on the entry page", () => {
    renderPages({ pages: TWO_PAGES });

    expect(button("Back").disabled).toBe(true);
    expect(button("Home").disabled).toBe(true);
  });

  it("keeps a way out on a one-page artifact whose link led to a page it lacks", () => {
    const { report } = renderPages({});

    report((page) => page.onNavigate("gone.html"));
    report((page) => page.onPageMissing());

    expect(button("Back").disabled).toBe(false);
    expect(button("Home").disabled).toBe(false);
  });

  it("enables Back and Home away from the entry page, and disables both again on return", async () => {
    const user = userEvent.setup();
    const { navigation, report } = renderPages({ pages: TWO_PAGES });

    report((page) => page.onNavigate("report.html"));

    expect(button("Back").disabled).toBe(false);
    expect(button("Home").disabled).toBe(false);

    await user.click(button("Back"));

    expect(navigation().path).toBe("index.html");
    expect(button("Back").disabled).toBe(true);
    expect(button("Home").disabled).toBe(true);
  });
});

describe("the More actions menu", () => {
  it("keeps Actual size for a page that fills its tile, enabled only once the page is ready and off 100%", () => {
    renderPages({ pageZoom: true });
    openMoreActions();
    const actualSize = (): string | null =>
      screen
        .getByRole("menuitem", { name: "Actual size" })
        .getAttribute("aria-disabled");
    expect(actualSize()).toBe("true");

    act(() => frameProps().onStatus("ready"));
    expect(actualSize()).toBe("true");

    act(() => frameProps().onHtmlZoom?.(1.2));
    expect(actualSize()).toBeNull();

    // The readout rounds, so a scale that reads 100% is at actual size.
    act(() => frameProps().onHtmlZoom?.(1.004));
    expect(actualSize()).toBe("true");
  });

  it("lists the caller's rows after Actual size", () => {
    renderPages({
      pageZoom: true,
      menuItems: <DropdownMenuItem>Download</DropdownMenuItem>,
    });

    openMoreActions();

    // The item's text starts with its "1:1" glyph.
    expect(menuItemNames()).toEqual([
      expect.stringContaining("Actual size"),
      "Download",
    ]);
  });

  it("offers neither zoom nor a menu in the chat, where the row has a fixed height", () => {
    renderPages({ pages: TWO_PAGES, height: 240, pageZoom: true });

    expect(
      screen.getByRole("toolbar", { name: "HTML artifact controls" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Zoom out" })).toBeNull();
  });

  it("holds only the caller's rows in the chat", () => {
    renderPages({
      pages: TWO_PAGES,
      height: 240,
      pageZoom: true,
      menuItems: <DropdownMenuItem>Download</DropdownMenuItem>,
    });

    openMoreActions();

    expect(menuItemNames()).toEqual(["Download"]);
  });
});

describe("the room a filling page keeps for the controls", () => {
  /**
   * jsdom lays nothing out and its observer never reports, so this declares
   * the layout (the chip sits 8px down and is 30px tall) and gives the page
   * the observer a browser has: it reports once as it starts observing, and
   * again when told the chip changed size.
   */
  function layOutControlsChip(): { readonly growTo: (height: number) => void } {
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(8);
    const chipHeight = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockReturnValue(30);
    const observing = new Set<ReportingResizeObserver>();
    class ReportingResizeObserver implements ResizeObserver {
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(): void {
        observing.add(this);
        this.report();
      }
      unobserve(): void {}
      disconnect(): void {
        observing.delete(this);
      }
      report(): void {
        this.callback([], this);
      }
    }
    vi.stubGlobal("ResizeObserver", ReportingResizeObserver);
    return {
      growTo: (height) => {
        chipHeight.mockReturnValue(height);
        act(() => {
          for (const observer of observing) observer.report();
        });
      },
    };
  }

  it("is the chip's bottom edge, so the page opens clear of it", () => {
    layOutControlsChip();

    renderPages({ pageZoom: true });

    expect(frameProps().pageInsetTop).toBe(38);
  });

  it("follows the chip when its controls wrap onto another row", () => {
    const layout = layOutControlsChip();
    renderPages({ pageZoom: true });

    layout.growTo(66);

    expect(frameProps().pageInsetTop).toBe(74);
  });

  it.each([
    [
      "in the chat, where the chip only comes up on hover",
      { pages: TWO_PAGES, height: 240, pageZoom: true },
    ],
    ["where the page has no controls at all", { pageZoom: false }],
  ])("is none %s", (_where, options) => {
    layOutControlsChip();

    renderPages(options);

    expect(frameProps().pageInsetTop).toBe(0);
  });
});
