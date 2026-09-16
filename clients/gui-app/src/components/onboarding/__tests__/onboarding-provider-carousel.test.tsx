import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ProviderListRow } from "@/components/providers/provider-list";
import { OnboardingProviderCarousel } from "@/components/onboarding/onboarding-provider-carousel";

const providerIds = [
  "codex",
  "claude-code",
  "opencode",
  "traycer",
  "openrouter",
] as const;

const rows = providerIds.map(
  (providerId) =>
    ({
      providerId,
      active: false,
      dimmed: false,
      enabled: true,
      badge: null,
      description: null,
      trailing: null,
      disabledReason: null,
      onSelect: null,
    }) satisfies ProviderListRow,
);

vi.mock("@/components/providers/provider-list", () => ({
  ProviderList: (props: {
    readonly rows: ReadonlyArray<ProviderListRow>;
    readonly ariaLabel: string;
    readonly className: string;
  }) => (
    <ul
      aria-label={props.ariaLabel}
      className={props.className}
      data-testid="provider-list"
      style={{ columnGap: "20px" }}
    >
      {props.rows.map((row) => (
        <li key={row.providerId}>
          <button type="button" aria-label={row.providerId}>
            {row.providerId}
          </button>
        </li>
      ))}
    </ul>
  ),
}));

interface ControllableResizeObserver {
  trigger(): void;
}

const resizeObservers: ControllableResizeObserver[] = [];
const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "ResizeObserver",
);
const scrollToDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo",
);

let scrollCalls: ScrollToOptions[] = [];

class TestResizeObserver implements ResizeObserver, ControllableResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  observe(_target: Element): void {}

  unobserve(_target: Element): void {}

  disconnect(): void {}

  trigger(): void {
    this.callback([], this);
  }
}

function installBrowserStubs(): void {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: TestResizeObserver,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: function scrollTo(
      this: HTMLElement,
      options: ScrollToOptions | number,
    ): void {
      if (typeof options === "number") return;
      scrollCalls.push(options);
      this.scrollLeft = options.left ?? this.scrollLeft;
      this.dispatchEvent(new Event("scroll"));
    },
  });
}

function restoreBrowserStubs(): void {
  if (resizeObserverDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  } else {
    Object.defineProperty(
      globalThis,
      "ResizeObserver",
      resizeObserverDescriptor,
    );
  }
  if (scrollToDescriptor === undefined) {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  } else {
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollTo",
      scrollToDescriptor,
    );
  }
}

function scrollerElement(): HTMLDivElement {
  const scroller = document.querySelector<HTMLDivElement>(
    ".onboarding-provider-scroller",
  );
  if (scroller === null) throw new Error("Expected the provider scroller");
  return scroller;
}

function setScrollerGeometry(scrollWidth: number): void {
  const scroller = scrollerElement();
  Object.defineProperty(scroller, "clientWidth", {
    configurable: true,
    value: 300,
  });
  Object.defineProperty(scroller, "scrollWidth", {
    configurable: true,
    value: scrollWidth,
  });
  Object.defineProperty(scroller, "scrollLeft", {
    configurable: true,
    writable: true,
    value: scroller.scrollLeft,
  });

  const card = screen.getByTestId("provider-list").firstElementChild;
  if (card === null) throw new Error("Expected a provider card");
  Object.defineProperty(card, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      width: 100,
      height: 100,
      top: 0,
      right: 100,
      bottom: 100,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

function triggerResize(): void {
  act(() => {
    for (const observer of resizeObservers) observer.trigger();
  });
}

function renderCarousel(scrollWidth: number): HTMLDivElement {
  render(<OnboardingProviderCarousel rows={rows} />);
  setScrollerGeometry(scrollWidth);
  triggerResize();
  return scrollerElement();
}

function pageLabel(): string {
  const status = screen.getByRole("status");
  return status.getAttribute("aria-label") ?? "";
}

beforeEach(() => {
  resizeObservers.length = 0;
  scrollCalls = [];
  installBrowserStubs();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  restoreBrowserStubs();
  resizeObservers.length = 0;
});

describe("<OnboardingProviderCarousel />", () => {
  it("keeps offscreen providers reachable and pages through the measured width", () => {
    const scroller = renderCarousel(700);

    expect(pageLabel()).toBe("Provider page 1 of 3");
    expect(
      screen
        .getByRole("button", { name: "Previous providers" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Next providers" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.getByRole("button", { name: "openrouter" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next providers" }), {
      detail: 1,
    });
    expect(scrollCalls.at(-1)).toEqual({ left: 240, behavior: "smooth" });
    expect(scroller.scrollLeft).toBe(240);
    expect(pageLabel()).toBe("Provider page 2 of 3");

    fireEvent.click(screen.getByRole("button", { name: "Next providers" }), {
      detail: 1,
    });
    expect(scrollCalls.at(-1)).toEqual({ left: 400, behavior: "smooth" });
    expect(pageLabel()).toBe("Provider page 3 of 3");
    expect(
      screen
        .getByRole("button", { name: "Next providers" })
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Previous providers" }),
      { detail: 1 },
    );
    expect(scrollCalls.at(-1)).toEqual({ left: 240, behavior: "smooth" });
    expect(pageLabel()).toBe("Provider page 2 of 3");
  });

  it("recomputes page count when the scroller's available width changes", () => {
    renderCarousel(500);
    expect(pageLabel()).toBe("Provider page 1 of 2");

    setScrollerGeometry(300);
    triggerResize();

    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("does not expose pagination for one pixel of overflow", () => {
    renderCarousel(301);

    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("moves instantly for keyboard activation and reduced-motion users", () => {
    renderCarousel(700);
    const next = screen.getByRole("button", { name: "Next providers" });

    fireEvent.click(next, { detail: 0 });
    expect(scrollCalls.at(-1)).toEqual({ left: 240, behavior: "instant" });

    const baseMatchMedia = window.matchMedia;
    const matchMedia = vi
      .spyOn(window, "matchMedia")
      .mockImplementation((query) => {
        const result = baseMatchMedia(query);
        Object.defineProperty(result, "matches", {
          configurable: true,
          value: query === "(prefers-reduced-motion: reduce)",
        });
        return result;
      });
    fireEvent.click(next, { detail: 1 });

    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(scrollCalls.at(-1)).toEqual({ left: 400, behavior: "instant" });
  });
});
