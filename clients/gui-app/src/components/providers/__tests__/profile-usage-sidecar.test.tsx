import "../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ProfileDropdownUsageEntry } from "../profile-dropdown-usage";
import { ProfileUsageSidecar } from "../profile-usage-sidecar";

const NOW = Date.now();
const UNPOSITIONED_TRANSFORM = "translate(0px, -200%)";
const POSITIONED_TRANSFORM = "translate(228px, 100px)";
const PROFILE: ProviderProfile = {
  profileId: "work",
  kind: "managed",
  authType: "oauth",
  label: "Work",
  auth: {
    status: "authenticated",
    badgeText: null,
    label: null,
    detail: null,
  },
  identity: null,
  usageUpdatedAt: null,
  rateLimitStatus: "unknown",
  duplicateOfProfileId: null,
  accentColor: null,
  ambientDriftNotice: null,
};

function entry(
  overrides: Pick<ProfileDropdownUsageEntry, "projection" | "refreshStatus">,
): ProfileDropdownUsageEntry {
  return {
    profileId: "work",
    refresh: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function staleEntry(): ProfileDropdownUsageEntry {
  const window = {
    id: "primary",
    role: "primary" as const,
    name: null,
    severity: "running_low" as const,
    window: {
      usedPercent: 84,
      resetsAt: NOW + 60_000,
      durationMinutes: 300,
    },
  };
  return entry({
    refreshStatus: "idle",
    projection: {
      kind: "stale",
      severity: "running_low",
      compactWindow: window,
      windows: [window],
      checkedAt: NOW - 60_000,
      unavailableReason: "fetch_failed",
    },
  });
}

function expectDisabledButton(name: string): void {
  const button = screen.getByRole("button", { name });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${name} to render as a button.`);
  }
  expect(button.disabled).toBe(true);
}

describe("ProfileUsageSidecar states", () => {
  let anchor: HTMLButtonElement;

  beforeEach(() => {
    anchor = document.createElement("button");
    document.body.append(anchor);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function mockRect(this: HTMLElement) {
        if (this === anchor) return new DOMRect(100, 100, 240, 32);
        if (this.hasAttribute("data-profile-usage-sidecar")) {
          return new DOMRect(0, 0, 300, 220);
        }
        return new DOMRect(0, 0, 0, 0);
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    anchor.remove();
    Reflect.deleteProperty(document, "getAnimations");
  });

  it.each([
    {
      name: "never checked",
      entry: entry({
        refreshStatus: "idle",
        projection: {
          kind: "not_checked",
          severity: "unknown",
          compactWindow: null,
          windows: [],
          checkedAt: null,
        },
      }),
      copy: "Not checked yet",
      action: "Refresh usage for Work",
    },
    {
      name: "semantic warning",
      entry: entry({
        refreshStatus: "idle",
        projection: {
          kind: "semantic_only",
          severity: "limited",
          compactWindow: null,
          windows: [],
          checkedAt: NOW,
          unavailableReason: null,
        },
      }),
      copy: "Detailed usage not loaded.",
      action: "Refresh usage for Work",
    },
    {
      name: "failed without last-good",
      entry: entry({
        refreshStatus: "idle",
        projection: {
          kind: "unavailable",
          severity: "unknown",
          reason: "fetch_failed",
          compactWindow: null,
          windows: [],
          checkedAt: null,
        },
      }),
      copy: "Couldn't refresh usage",
      action: "Retry usage for Work",
    },
  ])("renders the $name treatment", async ({ entry: state, copy, action }) => {
    render(
      <ProfileUsageSidecar
        anchor={anchor}
        profile={PROFILE}
        entry={state}
        isHostReady
      />,
    );
    expect(await screen.findByText(copy)).toBeDefined();
    expect(screen.getByRole("button", { name: action })).toBeDefined();
  });

  it("retains and dims last-good windows after failure with retry", async () => {
    render(
      <ProfileUsageSidecar
        anchor={anchor}
        profile={PROFILE}
        entry={staleEntry()}
        isHostReady
      />,
    );
    expect(
      await screen.findByText("Refresh failed. Showing last-known usage."),
    ).toBeDefined();
    expect(screen.getByText("Current session")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Retry usage for Work" }),
    ).toBeDefined();
  });

  it.each([
    { refreshStatus: "queued" as const, copy: "Queued" },
    { refreshStatus: "refreshing" as const, copy: "Refreshing" },
  ])("keeps cached detail visible while $refreshStatus", async (state) => {
    const retained = staleEntry();
    render(
      <ProfileUsageSidecar
        anchor={anchor}
        profile={PROFILE}
        entry={{ ...retained, refreshStatus: state.refreshStatus }}
        isHostReady
      />,
    );
    expect(await screen.findByText(state.copy)).toBeDefined();
    expect(screen.getByText("Current session")).toBeDefined();
    expect(screen.getByTestId("profile-usage-refresh-spinner")).toBeDefined();
    expectDisabledButton("Retry usage for Work");
  });

  it("disables refresh but preserves cached evidence when the run host is unavailable", async () => {
    render(
      <ProfileUsageSidecar
        anchor={anchor}
        profile={PROFILE}
        entry={staleEntry()}
        isHostReady={false}
      />,
    );
    expect(
      await screen.findByText(
        "Run host unavailable. Cached usage is shown when available.",
      ),
    ).toBeDefined();
    expect(screen.getByText("Current session")).toBeDefined();
    expectDisabledButton("Retry usage for Work");
    await waitFor(() =>
      expect(
        screen.getByRole("complementary", { name: "Usage details for Work" })
          .dataset.visible,
      ).toBe("true"),
    );
  });
});

describe("ProfileUsageSidecar entrance-animation readiness", () => {
  let wrapper: HTMLDivElement;
  let anchor: HTMLButtonElement;

  beforeEach(() => {
    wrapper = document.createElement("div");
    anchor = document.createElement("button");
    wrapper.append(anchor);
    document.body.append(wrapper);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function mockRect(this: HTMLElement) {
        if (this === anchor) return new DOMRect(100, 100, 240, 32);
        if (this.hasAttribute("data-profile-usage-sidecar")) {
          return new DOMRect(0, 0, 300, 220);
        }
        return new DOMRect(0, 0, 0, 0);
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    wrapper.remove();
    Reflect.deleteProperty(document, "getAnimations");
  });

  it("stays hidden while the containing menu is still animating in, then positions correctly once it settles", async () => {
    let releaseAnimation: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      releaseAnimation = resolve;
    });
    Object.defineProperty(document, "getAnimations", {
      configurable: true,
      writable: true,
      value: () => [
        {
          effect: {
            target: wrapper,
            getTiming: () => ({ iterations: 1 }),
          },
          finished,
        },
      ],
    });

    render(
      <ProfileUsageSidecar
        anchor={anchor}
        profile={PROFILE}
        entry={staleEntry()}
        isHostReady
      />,
    );

    const sidecar = screen.getByRole("complementary", {
      name: "Usage details for Work",
    });
    // Flush pending microtasks (but not the animation's `finished` promise,
    // which stays pending) - the sidecar must remain hidden throughout, with
    // no interim position ever committed.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sidecar.dataset.visible).toBe("false");
    expect(sidecar.dataset.side).toBeUndefined();

    releaseAnimation();
    await waitFor(() => expect(sidecar.dataset.visible).toBe("true"));
    expect(sidecar.dataset.side).toBe("right");
  });
});

// Models the real Radix Popper sequence (see `@radix-ui/react-popper`'s
// `PopperContent`, node_modules/.../@radix-ui/react-popper/dist/index.mjs):
// `[data-radix-popper-content-wrapper]` holds the unpositioned sentinel while
// measuring, which CSSOM may serialize as `translate(0px, -200%)`. Content's
// entrance animation is explicitly suppressed (`animation: "none"`) until
// Floating UI's `isPositioned` flips true. In a nested transformed popper the
// sentinel can produce an in-viewport phantom rect, while
// `document.getAnimations()` is genuinely empty, so neither animation state
// nor viewport intersection can prove placement.
describe("ProfileUsageSidecar Radix placement readiness", () => {
  let wrapper: HTMLDivElement;
  let anchor: HTMLButtonElement;
  let currentAnimations: ReadonlyArray<{
    readonly effect: {
      readonly target: Node | null;
      getTiming(): { readonly iterations?: number };
    } | null;
    readonly finished: Promise<unknown>;
  }>;

  beforeEach(() => {
    wrapper = document.createElement("div");
    wrapper.setAttribute("data-radix-popper-content-wrapper", "");
    wrapper.style.transform = UNPOSITIONED_TRANSFORM;
    anchor = document.createElement("button");
    wrapper.append(anchor);
    document.body.append(wrapper);
    currentAnimations = [];
    Object.defineProperty(document, "getAnimations", {
      configurable: true,
      writable: true,
      value: () => currentAnimations,
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function mockRect(this: HTMLElement) {
        if (this === anchor) {
          return wrapper.style.transform === UNPOSITIONED_TRANSFORM
            ? new DOMRect(0, 0, 240, 32)
            : new DOMRect(100, 100, 240, 32);
        }
        if (this.hasAttribute("data-profile-usage-sidecar")) {
          return new DOMRect(0, 0, 300, 220);
        }
        return new DOMRect(0, 0, 0, 0);
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    wrapper.remove();
    Reflect.deleteProperty(document, "getAnimations");
  });

  it("stays hidden through the unpositioned phantom-rect phase, then through the entrance animation, then positions correctly", async () => {
    render(
      <ProfileUsageSidecar
        anchor={anchor}
        profile={PROFILE}
        entry={staleEntry()}
        isHostReady
      />,
    );

    const sidecar = screen.getByRole("complementary", {
      name: "Usage details for Work",
    });

    // Phase 1: Radix's genuine unpositioned window. No animation exists
    // (Radix suppresses it), and the nested-popover failure mode can report
    // an on-screen phantom rect even though the sentinel is still present.
    // This is exactly the condition an animation-only wait cannot detect -
    // it would find `getAnimations()` empty and show immediately using the
    // invalid phantom rect. Flushed via `act` + a real macrotask tick (not
    // just microtasks) so any React work a premature `setPosition` schedules
    // is fully applied before asserting - a bare microtask flush can race a
    // real bug into passing vacuously if React defers the commit.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(sidecar.dataset.visible).toBe("false");
    expect(sidecar.dataset.side).toBeUndefined();

    // Phase 2: Floating UI lands its first real placement - the wrapper's
    // style mutates, the anchor's rect is now on-screen, and Radix's
    // suppression lifts so the entrance animation begins.
    let releaseAnimation: (value: undefined) => void = () => undefined;
    const finished = new Promise<undefined>((resolve) => {
      releaseAnimation = resolve;
    });
    currentAnimations = [
      {
        effect: { target: wrapper, getTiming: () => ({ iterations: 1 }) },
        finished,
      },
    ];
    await act(async () => {
      wrapper.style.transform = POSITIONED_TRANSFORM;
      // Still hidden - the entrance animation itself hasn't settled yet.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(sidecar.dataset.visible).toBe("false");

    releaseAnimation(undefined);
    await waitFor(() => expect(sidecar.dataset.visible).toBe("true"));
    expect(sidecar.dataset.side).toBe("right");
    // Discriminates the stale phantom measurement (anchor at x=0,y=0,
    // width=240 -> left=248 and top clamped to the 12px viewport padding)
    // from the real one (anchor at x=100,y=100,width=240 -> left=348,
    // top=100). `data-side` alone is "right" either way.
    expect(sidecar.getAttribute("style")).toContain("left: 348px");
    expect(sidecar.getAttribute("style")).toContain("top: 100px");
  });

  it("re-anchors instantly to a different row within an already-placed menu (no placement wait)", async () => {
    wrapper.style.transform = POSITIONED_TRANSFORM;
    const { rerender } = render(
      <ProfileUsageSidecar
        anchor={anchor}
        profile={PROFILE}
        entry={staleEntry()}
        isHostReady
      />,
    );
    const sidecar = screen.getByRole("complementary", {
      name: "Usage details for Work",
    });
    await waitFor(() => expect(sidecar.dataset.visible).toBe("true"));

    const otherRow = document.createElement("button");
    wrapper.append(otherRow);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function mockRect(this: HTMLElement) {
        if (this === otherRow) return new DOMRect(100, 160, 240, 32);
        if (this.hasAttribute("data-profile-usage-sidecar")) {
          return new DOMRect(0, 0, 300, 220);
        }
        return new DOMRect(0, 0, 0, 0);
      },
    );

    rerender(
      <ProfileUsageSidecar
        anchor={otherRow}
        profile={PROFILE}
        entry={staleEntry()}
        isHostReady
      />,
    );
    // Already-placed menu, already on-screen row - no artificial wait.
    await waitFor(() =>
      expect(sidecar.getAttribute("style")).toContain("top: 160px"),
    );
  });
});
