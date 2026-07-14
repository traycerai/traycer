import "../../../../__tests__/test-browser-apis";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ProfileDropdownUsageEntry } from "../profile-dropdown-usage";
import { ProfileUsageSidecar } from "../profile-usage-sidecar";

const NOW = Date.now();
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
