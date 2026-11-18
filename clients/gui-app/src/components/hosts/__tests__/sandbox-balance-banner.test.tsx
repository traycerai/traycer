import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SandboxListResponse } from "@traycer/protocol/host/sandbox-control";
import type { SandboxRunwayWarning } from "@/lib/sandboxes/sandbox-balance";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

const mocks = vi.hoisted(() => ({
  list: undefined as SandboxListResponse | undefined,
  warning: { kind: "none" } as SandboxRunwayWarning,
  warningReads: vi.fn(),
  /** Mounts of the balance poll (the cost-reading half the banner gates). */
  refreshMounts: vi.fn(),
  /** Reads of the cost view: a user with no sandboxes must make none. */
  costReads: vi.fn(),
}));
const AUTH = vi.hoisted(() => ({ marker: "auth-service" }));

vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({ data: mocks.list }),
}));
// The observer and the card's combined hook stay REAL (they are what the
// row-set tests below exercise); only the balance poll is a mount counter.
vi.mock(
  "@/hooks/sandboxes/use-refresh-sandbox-costs",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/sandboxes/use-refresh-sandbox-costs")
    >()),
    useSandboxBalancePoll: () => {
      mocks.refreshMounts();
    },
  }),
);
vi.mock(
  "@/hooks/sandboxes/use-sandbox-costs-query",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-costs-query")
    >()),
    useSandboxCosts: () => {
      mocks.costReads();
      return { data: undefined, isError: false };
    },
  }),
);
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useAuthService: () => AUTH,
  // The observer half reads auth through the nullable binding.
  useHostBinding: () => ({ auth: AUTH }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-runway-warning", () => ({
  useSandboxRunwayWarning: () => {
    mocks.warningReads();
    return mocks.warning;
  },
}));

import {
  SandboxBalanceBanner,
  SandboxRunwayWarningLine,
} from "@/components/hosts/sandbox-balance-banner";
import { useRefreshSandboxCosts } from "@/hooks/sandboxes/use-refresh-sandbox-costs";

const COSTS_KEY = ["auth", "sandbox-costs"];
const USER_KEY = ["auth", "user", AUTH];

function renderBanner(): { readonly container: HTMLElement } {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <SandboxBalanceBanner />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.list = undefined;
  mocks.warning = { kind: "none" };
  mocks.warningReads.mockClear();
  mocks.refreshMounts.mockClear();
  mocks.costReads.mockClear();
});
afterEach(cleanup);

describe("<SandboxRunwayWarningLine />", () => {
  it("renders nothing while the balance covers more than two hours", () => {
    const { container } = render(
      <SandboxRunwayWarningLine warning={{ kind: "none" }} />,
    );
    expect(container.textContent).toBe("");
  });

  it("warns that credits cover about the runway at the current burn (under two hours)", () => {
    render(
      <SandboxRunwayWarningLine
        warning={{ kind: "low", runwayMinutes: 100 }}
      />,
    );
    const line = screen.getByTestId("sandbox-balance-warning");
    expect(line.getAttribute("data-level")).toBe("low");
    expect(line.getAttribute("role")).toBe("status");
    expect(line.textContent).toBe(
      "Credits cover about 1 h 40 min at your sandboxes' current burn. Add credits to keep them running.",
    );
  });

  it("warns louder, and says what freezes, under thirty minutes", () => {
    render(
      <SandboxRunwayWarningLine
        warning={{ kind: "critical", runwayMinutes: 25 }}
      />,
    );
    const line = screen.getByTestId("sandbox-balance-warning");
    expect(line.getAttribute("data-level")).toBe("critical");
    expect(line.textContent).toBe(
      "Credits run out in 25 min at your sandboxes' current burn. Awake sandboxes freeze when they do; add credits to keep them running.",
    );
  });
});

describe("<SandboxBalanceBanner />", () => {
  it("reads no cost, mounts no refresher and renders nothing for a user with no sandboxes", () => {
    mocks.list = { sandboxes: [] };
    mocks.warning = { kind: "critical", runwayMinutes: 5 };
    const { container } = renderBanner();
    expect(container.textContent).toBe("");
    expect(mocks.warningReads).not.toHaveBeenCalled();
    expect(mocks.refreshMounts).not.toHaveBeenCalled();
  });

  it("reads no cost before the sandbox list has answered", () => {
    mocks.list = undefined;
    renderBanner();
    expect(mocks.warningReads).not.toHaveBeenCalled();
  });

  it("shows the live warning once the user has a sandbox, and refreshes the figures", () => {
    mocks.list = { sandboxes: [sandboxSummaryFixture({})] };
    mocks.warning = { kind: "low", runwayMinutes: 90 };
    renderBanner();
    expect(mocks.refreshMounts).toHaveBeenCalled();
    expect(screen.getByTestId("sandbox-balance-warning").textContent).toContain(
      "1 h 30 min",
    );
  });

  it("shows nothing for a user with sandboxes whose balance is comfortable", () => {
    mocks.list = { sandboxes: [sandboxSummaryFixture({})] };
    mocks.warning = { kind: "none" };
    renderBanner();
    expect(screen.queryByTestId("sandbox-balance-warning")).toBeNull();
  });
});

/**
 * The row set is watched by the banner WRAPPER, which stays mounted when the
 * last sandbox goes. The card that showed the sandbox unmounts with it, so
 * if the wrapper watched nothing the cost view and the balance would keep the
 * destroyed sandbox's burn until a focus event.
 */
describe("<SandboxBalanceBanner /> watching the row set", () => {
  function setup() {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue(undefined);
    const tree = (children: ReactNode): ReactNode => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return { invalidate, tree };
  }

  function keysInvalidated(
    invalidate: Mock<QueryClient["invalidateQueries"]>,
  ): unknown[] {
    return invalidate.mock.calls.map(([filters]) => filters?.queryKey);
  }

  function RefreshingCard(): ReactNode {
    useRefreshSandboxCosts();
    return null;
  }

  it("refreshes the cost view and the balance once when the last sandbox disappears and the banner unmounts its live half", () => {
    const { invalidate, tree } = setup();
    mocks.list = {
      sandboxes: [sandboxSummaryFixture({ id: "a", state: "awake" })],
    };
    const view = render(tree(<SandboxBalanceBanner />));
    expect(invalidate).not.toHaveBeenCalled();

    mocks.list = { sandboxes: [] };
    view.rerender(tree(<SandboxBalanceBanner />));

    expect(keysInvalidated(invalidate)).toEqual([COSTS_KEY, USER_KEY]);
    expect(view.container.textContent).toBe("");
  });

  it("on the 202 path refreshes on the move to destroying and again when the row is gone", () => {
    const { invalidate, tree } = setup();
    mocks.list = {
      sandboxes: [sandboxSummaryFixture({ id: "a", state: "awake" })],
    };
    const view = render(tree(<SandboxBalanceBanner />));

    mocks.list = {
      sandboxes: [sandboxSummaryFixture({ id: "a", state: "destroying" })],
    };
    view.rerender(tree(<SandboxBalanceBanner />));
    expect(keysInvalidated(invalidate)).toEqual([COSTS_KEY, USER_KEY]);

    mocks.list = { sandboxes: [] };
    view.rerender(tree(<SandboxBalanceBanner />));
    expect(keysInvalidated(invalidate)).toEqual([
      COSTS_KEY,
      USER_KEY,
      COSTS_KEY,
      USER_KEY,
    ]);
  });

  it("reads no cost and refreshes nothing for a user whose list stays empty, refetches included", () => {
    const { invalidate, tree } = setup();
    mocks.list = { sandboxes: [] };
    const view = render(tree(<SandboxBalanceBanner />));

    mocks.list = { sandboxes: [] };
    view.rerender(tree(<SandboxBalanceBanner />));
    mocks.list = { sandboxes: [] };
    view.rerender(tree(<SandboxBalanceBanner />));

    expect(mocks.costReads).not.toHaveBeenCalled();
    expect(mocks.refreshMounts).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("does not refresh when the first sandbox appears: the cost view mounts and fetches then", () => {
    const { invalidate, tree } = setup();
    mocks.list = { sandboxes: [] };
    const view = render(tree(<SandboxBalanceBanner />));

    mocks.list = {
      sandboxes: [sandboxSummaryFixture({ id: "a", state: "awake" })],
    };
    view.rerender(tree(<SandboxBalanceBanner />));

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("control: with the banner and a card both mounted, one row-set change refreshes once, not twice", () => {
    const { invalidate, tree } = setup();
    mocks.list = {
      sandboxes: [sandboxSummaryFixture({ id: "a", state: "awake" })],
    };
    // A fresh element each time: React skips re-rendering an identical one.
    const both = (): ReactNode => (
      <>
        <SandboxBalanceBanner />
        <RefreshingCard />
      </>
    );
    const view = render(tree(both()));
    expect(invalidate).not.toHaveBeenCalled();

    mocks.list = {
      sandboxes: [sandboxSummaryFixture({ id: "a", state: "suspended" })],
    };
    view.rerender(tree(both()));

    expect(keysInvalidated(invalidate)).toEqual([COSTS_KEY, USER_KEY]);
  });
});
