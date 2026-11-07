import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { SandboxDetailsDrawerHost } from "@/components/hosts/sandbox-details-drawer";
import type {
  SandboxSummary,
  SandboxListResponse,
} from "@traycer/protocol/host/sandbox-control";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { SANDBOX_LIST_FAILED } from "@/lib/sandboxes/sandbox-strings";
import {
  closeSandboxDetails,
  openSandboxDetails,
} from "@/stores/sandboxes/sandbox-details-store";

const list = vi.hoisted(() => ({
  data: undefined as SandboxListResponse | undefined,
  refetch: vi.fn(() => Promise.resolve()),
}));

// The list read failed: no data, and the query says so.
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({
    data: list.data,
    isError: list.data === undefined,
    isFetching: false,
    refetch: list.refetch,
  }),
}));

vi.mock("@/hooks/sandboxes/use-sandbox-costs-query", () => ({
  useSandboxCosts: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-configurations", () => ({
  useSandboxConfigurations: () => ({
    configurations: [{ kind: "personal" }],
    teamEnvironmentIds: new Set<string>(),
    complete: true,
  }),
  sandboxConfigurationOf: () => ({ kind: "personal" }),
  useSandboxWakeString: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-operation", () => ({
  useSandboxOperation: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-settings-status", () => ({
  useSandboxSettingsStatus: () => ({ data: undefined }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-session-report", () => ({
  useSandboxRowSessionReport: () => ({
    report: { kind: "unknown" },
    failed: false,
  }),
}));

afterEach(() => {
  act(() => {
    closeSandboxDetails();
  });
  cleanup();
  list.data = undefined;
});

describe("<SandboxDetailsDrawerHost />", () => {
  it("says a failed list read failed and reads it again on Retry, instead of loading for ever", () => {
    render(<SandboxDetailsDrawerHost />);
    act(() => {
      openSandboxDetails("sbx-1");
    });

    expect(screen.getByText(SANDBOX_LIST_FAILED)).toBeDefined();
    expect(screen.queryByText("Loading this sandbox's details…")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(list.refetch).toHaveBeenCalledTimes(1);
  });

  it("shows the agent, task purpose, sessions and setup evidence kept out of the list", () => {
    const summary: SandboxSummary = sandboxSummaryFixture({
      id: "sbx-details",
      displayName: "Sandbox details fixture",
      state: "awake",
      burst: true,
      guestConfigured: false,
      createdByAgentId: "agent-planner",
      createdByAgentName: "Planner",
      createdByTaskTitle: "Sandbox setup",
    });
    const startedByAgent = sandboxSummaryFixture({
      id: "sbx-started-by-agent",
      displayName: "Kept agent sandbox",
      state: "awake",
      burst: false,
      createdByAgentId: "agent-planner",
      createdByAgentName: "Planner",
    });
    list.data = { sandboxes: [summary, startedByAgent] };
    render(<SandboxDetailsDrawerHost />);
    act(() => {
      openSandboxDetails(summary.id);
    });

    expect(screen.getByText("Created by")).toBeTruthy();
    expect(screen.getByText("Planner")).toBeTruthy();
    expect(screen.getByText("For task")).toBeTruthy();
    expect(screen.getByText("Sandbox setup")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Sessions" })).toBeTruthy();
    // The list row no longer shows the setup failure's reference, so Details
    // names it even when the failure carries no code of its own.
    expect(
      screen.getByRole("region", { name: "Settings delivery" }).textContent,
    ).toBe(
      "Settings deliverySandbox setup did not apply.Support reference: SBX-0520",
    );

    act(() => {
      openSandboxDetails(startedByAgent.id);
    });
    expect(screen.getByText("Started by")).toBeTruthy();
    expect(screen.getByText("Planner")).toBeTruthy();
  });
});
