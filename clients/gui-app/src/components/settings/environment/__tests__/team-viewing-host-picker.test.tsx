import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamViewingHostPicker } from "@/components/settings/environment/team-viewing-host-picker";

// The viewing-host hook is the boundary: what it answers is what the picker
// draws.
const scope = vi.hoisted(
  (): {
    hosts: Array<{ hostId: string; hostLabel: string | null }>;
    viewing: { hostId: string; hostLabel: string | null } | null;
    selectable: Set<string>;
    pending: boolean;
  } => ({ hosts: [], viewing: null, selectable: new Set(), pending: false }),
);
vi.mock("@/hooks/environment/team/use-team-viewing-host", () => ({
  useTeamViewingHost: () => ({
    hosts: {
      isError: false,
      isPending: scope.pending,
      data: scope.pending ? undefined : { hosts: scope.hosts },
      refetch: vi.fn(),
    },
    viewingHost: scope.viewing,
    client: null,
    selectHost: vi.fn(),
    canSelectHost: (hostId: string) => scope.selectable.has(hostId),
  }),
}));

const STUDIO = { hostId: "host-a", hostLabel: "Studio" };
const LAPTOP = { hostId: "host-b", hostLabel: "Laptop" };

function renderPicker(): void {
  render(<TeamViewingHostPicker open={false} onOpenChange={vi.fn()} />);
}

beforeEach(() => {
  scope.hosts = [];
  scope.viewing = null;
  scope.selectable = new Set();
  scope.pending = false;
});

afterEach(cleanup);

describe("<TeamViewingHostPicker />", () => {
  it("names the viewed host and offers Use another host when another eligible host exists", () => {
    scope.hosts = [STUDIO, LAPTOP];
    scope.viewing = STUDIO;
    scope.selectable = new Set(["host-a", "host-b"]);
    renderPicker();

    expect(screen.getByText("as reported by Studio")).toBeTruthy();
    expect(screen.getByRole("combobox").textContent).toBe("Use another host");
  });

  it("is just the viewed host's name when it is the only eligible host", () => {
    scope.hosts = [STUDIO];
    scope.viewing = STUDIO;
    scope.selectable = new Set(["host-a"]);
    renderPicker();

    expect(screen.getByText("as reported by Studio")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("·")).toBeNull();
  });

  it("does not count an offline host as another eligible one", () => {
    scope.hosts = [STUDIO, LAPTOP];
    scope.viewing = STUDIO;
    scope.selectable = new Set(["host-a"]);
    renderPicker();

    expect(screen.getByText("as reported by Studio")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("offers no picker when no listed host is selectable", () => {
    scope.hosts = [STUDIO, LAPTOP];
    renderPicker();

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("Pick a host")).toBeNull();
    expect(screen.queryByText(/as reported by/)).toBeNull();
  });

  it("offers no picker while the host list has not answered", () => {
    scope.pending = true;
    renderPicker();

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("Pick a host")).toBeNull();
  });
});
