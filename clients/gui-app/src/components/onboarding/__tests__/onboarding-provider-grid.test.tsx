import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ProviderListRow } from "@/components/providers/provider-list";
import { OnboardingProviderGrid } from "@/components/onboarding/onboarding-provider-grid";

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
      phoneDescription: null,
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

function scroller(): HTMLDivElement {
  return screen.getByTestId<HTMLDivElement>("onboarding-provider-grid");
}

/** jsdom lays nothing out, so the scroll box's geometry is declared here. */
function setGeometry(input: {
  readonly scrollHeight: number;
  readonly scrollTop: number;
}): void {
  const element = scroller();
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: 300,
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: input.scrollHeight,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    writable: true,
    value: input.scrollTop,
  });
}

function settle(): void {
  act(() => {
    for (const observer of resizeObservers) observer.trigger();
  });
}

function fades(): {
  readonly top: string | null;
  readonly bottom: string | null;
} {
  const element = scroller();
  return {
    top: element.getAttribute("data-fade-top"),
    bottom: element.getAttribute("data-fade-bottom"),
  };
}

beforeEach(() => {
  resizeObservers.length = 0;
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: TestResizeObserver,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (resizeObserverDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  } else {
    Object.defineProperty(
      globalThis,
      "ResizeObserver",
      resizeObserverDescriptor,
    );
  }
  resizeObservers.length = 0;
});

describe("<OnboardingProviderGrid />", () => {
  it("renders every provider at once, with no pagination chrome", () => {
    render(<OnboardingProviderGrid rows={rows} />);
    setGeometry({ scrollHeight: 900, scrollTop: 0 });
    settle();

    for (const providerId of providerIds) {
      expect(screen.getByRole("button", { name: providerId })).toBeTruthy();
    }
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /next providers/i }),
    ).toBeNull();
  });

  it("fades only the edges that still hide a card", () => {
    render(<OnboardingProviderGrid rows={rows} />);

    setGeometry({ scrollHeight: 900, scrollTop: 0 });
    settle();
    expect(fades()).toEqual({ top: "false", bottom: "true" });

    setGeometry({ scrollHeight: 900, scrollTop: 300 });
    act(() => {
      fireEvent.scroll(scroller());
    });
    expect(fades()).toEqual({ top: "true", bottom: "true" });

    setGeometry({ scrollHeight: 900, scrollTop: 600 });
    act(() => {
      fireEvent.scroll(scroller());
    });
    expect(fades()).toEqual({ top: "true", bottom: "false" });
  });

  it("fades neither edge when nothing overflows", () => {
    render(<OnboardingProviderGrid rows={rows} />);
    setGeometry({ scrollHeight: 300, scrollTop: 0 });
    settle();

    expect(fades()).toEqual({ top: "false", bottom: "false" });
  });
});
