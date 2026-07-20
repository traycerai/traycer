import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ProfileDropdownUsageEntry } from "../profile-dropdown-usage";
import { ProfileUsageCompactMeter } from "../profile-usage-compact-meter";

const NOW = Date.now();

function compactWindow(usedPercent: number) {
  return {
    id: "primary",
    role: "primary" as const,
    name: null,
    severity: "running_low" as const,
    window: {
      usedPercent,
      resetsAt: NOW + 60 * 60 * 1_000,
      durationMinutes: 300,
    },
  };
}

function entry(
  projection: ProfileDropdownUsageEntry["projection"],
): ProfileDropdownUsageEntry {
  return {
    profileId: "p-a",
    refreshStatus: "idle",
    refresh: vi.fn(() => Promise.resolve()),
    ensureFresh: vi.fn(() => Promise.resolve()),
    projection,
  };
}

describe("ProfileUsageCompactMeter", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a filled bar at the compact window's percent for a detail projection", () => {
    const { getByTestId } = render(
      <ProfileUsageCompactMeter
        entry={entry({
          kind: "detail",
          severity: "running_low",
          checkedAt: NOW,
          unavailableReason: null,
          compactWindow: compactWindow(84),
          windows: [compactWindow(84)],
        })}
      />,
    );
    const track = getByTestId("profile-usage-bar-p-a");
    expect(track.className).not.toContain("opacity-50");
    const fill = track.firstElementChild;
    expect(fill?.getAttribute("style")).toContain("84%");
    expect(fill?.className).toContain("bg-amber-500");
  });

  it("dims the retained bar for a stale projection without dropping it", () => {
    const { getByTestId } = render(
      <ProfileUsageCompactMeter
        entry={entry({
          kind: "stale",
          severity: "limited",
          checkedAt: NOW,
          unavailableReason: null,
          compactWindow: compactWindow(97),
          windows: [compactWindow(97)],
        })}
      />,
    );
    const track = getByTestId("profile-usage-bar-p-a");
    expect(track.className).toContain("opacity-50");
    const fill = track.firstElementChild;
    expect(fill?.getAttribute("style")).toContain("97%");
    expect(fill?.className).toContain("bg-red-500");
  });

  it("renders an empty, dimmed track for unavailable - never a fabricated fill", () => {
    const { getByTestId } = render(
      <ProfileUsageCompactMeter
        entry={entry({
          kind: "unavailable",
          severity: "unknown",
          checkedAt: null,
          windows: [],
          compactWindow: null,
          reason: "insufficient_permissions",
        })}
      />,
    );
    const track = getByTestId("profile-usage-bar-p-a");
    expect(track.className).toContain("opacity-50");
    expect(track.children.length).toBe(0);
  });

  it("renders a tinted empty track for semantic-only warnings without fabricating a fill", () => {
    const { getByTestId } = render(
      <ProfileUsageCompactMeter
        entry={entry({
          kind: "semantic_only",
          severity: "limited",
          checkedAt: NOW,
          windows: [],
          compactWindow: null,
          unavailableReason: null,
        })}
      />,
    );
    const track = getByTestId("profile-usage-bar-p-a");
    expect(track.className).toContain("bg-red-500/25");
    expect(track.className).not.toContain("opacity-50");
    expect(track.children.length).toBe(0);
  });

  it("renders an empty, untinted track for not_checked", () => {
    const { getByTestId } = render(
      <ProfileUsageCompactMeter
        entry={entry({
          kind: "not_checked",
          severity: "unknown",
          checkedAt: null,
          windows: [],
          compactWindow: null,
        })}
      />,
    );
    const track = getByTestId("profile-usage-bar-p-a");
    expect(track.className).not.toContain("opacity-50");
    expect(track.children.length).toBe(0);
  });
});
