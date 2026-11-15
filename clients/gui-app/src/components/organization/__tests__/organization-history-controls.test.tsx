import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrganizationView } from "@traycer/protocol/host/organization/contracts";
import { OrganizationHistoryFilters } from "@/components/organization/organization-history-controls";
import {
  DEFAULT_HISTORY_SEARCH,
  type HistorySearchPatch,
  type HistorySearchState,
} from "@/lib/history-search";

const state = vi.hoisted(() => {
  let view: OrganizationView = {
    catalog: [],
    groups: {
      version: "0",
      groups: [
        { groupId: "group-1", name: "Backend", color: "#445566", position: 0 },
      ],
      memberships: [],
    },
    appearances: [],
    taskLabels: {},
    ready: true,
    authenticationRequired: false,
    pending: [],
    failures: [],
  };
  const organization = {
    supported: true,
    userId: "user-1",
    readView: () => view,
    subscribeView: () => () => undefined,
    client: {},
    register: vi.fn(
      (_key: string, _taskIds: readonly string[]) => () => undefined,
    ),
    openDialog: vi.fn(),
    command: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
  };
  const facets = {
    organizationFacets: {
      labelNames: ["Imported", "Review", "Automation"],
    },
  };
  return {
    organization,
    facets,
    setView: (next: OrganizationView) => {
      view = next;
    },
  };
});

vi.mock("@/hooks/organization/organization-context", async (load) => {
  const actual =
    await load<typeof import("@/hooks/organization/organization-context")>();
  const { organizationViewHookOverrides } =
    await import("@/__tests__/organization-view-source");
  return {
    ...actual,
    useOrganization: () => state.organization,
    ...organizationViewHookOverrides(
      () => state.organization.readView(),
      actual.taskOrganization,
    ),
  };
});

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => ({
    data: state.facets,
    isPending: false,
    isError: false,
  }),
}));

function renderFilters(
  search: HistorySearchState | undefined,
  onSearchChange: ((patch: HistorySearchPatch) => void) | undefined,
) {
  return render(
    <OrganizationHistoryFilters
      search={search ?? DEFAULT_HISTORY_SEARCH}
      onSearchChange={onSearchChange ?? vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  state.setView({
    ...state.organization.readView(),
    groups: {
      ...state.organization.readView().groups,
      groups: [
        {
          groupId: "group-1",
          name: "Backend",
          color: "#445566",
          position: 0,
        },
      ],
    },
  });
});

describe("organization history filters", () => {
  it("uses shared facets without adding per-section search fields", () => {
    renderFilters(undefined, undefined);

    expect(screen.getByText("Labels")).toBeTruthy();
    expect(screen.getByText("Groups")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Imported" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Automation" })).toBeTruthy();
    expect(screen.queryByPlaceholderText("Search labels…")).toBeNull();
    expect(screen.queryByPlaceholderText("Search groups…")).toBeNull();
  });

  it("keeps label match mode and group/no-group patches independent", async () => {
    const user = userEvent.setup();
    const onSearchChange = vi.fn<(patch: HistorySearchPatch) => void>();
    renderFilters(
      {
        ...DEFAULT_HISTORY_SEARCH,
        labelNames: ["Imported", "Review"],
        groupIds: [],
        includeUngrouped: false,
      },
      onSearchChange,
    );

    expect(screen.getAllByRole("button", { name: "AND" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "AND" }));
    expect(onSearchChange.mock.calls[0]?.[0]).toEqual({ labelMode: "all" });

    await user.click(screen.getByRole("checkbox", { name: "No group" }));
    expect(onSearchChange.mock.calls[1]?.[0]).toEqual({
      includeUngrouped: true,
    });
    await user.click(screen.getByRole("checkbox", { name: "Backend" }));
    expect(onSearchChange.mock.calls[2]?.[0]).toEqual({
      groupIds: ["group-1"],
    });
  });

  it("keeps a selected group that disappeared from the catalog deselectable", async () => {
    const user = userEvent.setup();
    const onSearchChange = vi.fn<(patch: HistorySearchPatch) => void>();
    renderFilters(
      {
        ...DEFAULT_HISTORY_SEARCH,
        labelNames: ["Imported"],
        groupIds: ["missing-group"],
        includeUngrouped: true,
      },
      onSearchChange,
    );

    const unavailable = screen.getByRole("checkbox", {
      name: "Unavailable group",
    });
    expect(unavailable.getAttribute("aria-checked")).toBe("true");
    await user.click(unavailable);
    expect(onSearchChange.mock.calls[0]?.[0]).toEqual({ groupIds: [] });

    await user.click(screen.getByRole("checkbox", { name: "No group" }));
    expect(onSearchChange.mock.calls[1]?.[0]).toEqual({
      includeUngrouped: false,
    });
    expect(
      screen
        .getByRole("checkbox", { name: "Imported" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});
