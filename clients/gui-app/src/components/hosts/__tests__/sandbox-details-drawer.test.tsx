import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { SandboxDetailsDrawerHost } from "@/components/hosts/sandbox-details-drawer";
import type {
  SandboxSummary,
  SandboxListResponse,
} from "@traycer/protocol/host/sandbox-control";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import type { SandboxRowOperation } from "@/hooks/sandboxes/use-sandbox-operation";
import { SandboxOperationError } from "@/hooks/sandboxes/sandbox-failure-copy";
import { refusal } from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { SANDBOX_FIRST_BOOT_FAILURE_COPIES } from "@/lib/sandboxes/__tests__/sandbox-first-boot-failure-copies";
import { SANDBOX_LIST_FAILED } from "@/lib/sandboxes/sandbox-strings";
import {
  closeSandboxDetails,
  openSandboxDetails,
} from "@/stores/sandboxes/sandbox-details-store";

interface ListFixture {
  data: SandboxListResponse | undefined;
  refetch: Mock<() => Promise<void>>;
  operation: SandboxRowOperation | null;
}

const list = vi.hoisted((): ListFixture => ({
  data: undefined,
  refetch: vi.fn(() => Promise.resolve()),
  operation: null,
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
  useSandboxOperation: () => list.operation,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-settings-status", () => ({
  useSandboxSettingsStatus: () => ({ data: undefined }),
}));
afterEach(() => {
  act(() => {
    closeSandboxDetails();
  });
  cleanup();
  list.data = undefined;
  list.operation = null;
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

  it.each<{
    verb: "resume" | "start" | "stop";
    state: SandboxSummary["state"];
  }>([
    { verb: "resume", state: "suspended" },
    { verb: "start", state: "stopped" },
    { verb: "stop", state: "destroyed" },
  ])(
    "reports a failed $verb in $state without promising recovery",
    ({ verb, state }) => {
      const summary = sandboxSummaryFixture({
        id: "sbx-operation-failure",
        displayName: "Sandbox action fixture",
        state,
      });
      list.data = { sandboxes: [summary] };
      list.operation = {
        kind: "failed",
        verb,
        error: new SandboxOperationError(refusal(502, "provider_failed")),
        code: "provider_failed",
        reference: verb === "resume" ? "SBX-0507" : "SBX-0508",
        destroyRequest: undefined,
      };

      render(<SandboxDetailsDrawerHost />);
      act(() => {
        openSandboxDetails(summary.id);
      });

      const failure = screen.getByTestId("sandbox-details-operation-failure");
      expect(
        within(failure).getByText("Couldn't complete the sandbox action."),
      ).toBeDefined();
      expect(failure.textContent).not.toMatch(/destroy|try again/i);
    },
  );

  it("keeps lifecycle details and setup diagnostics available in the drawer", () => {
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

    const status = screen.getByTestId("sandbox-details-status");
    expect(within(status).queryByText("Created by")).toBeNull();
    expect(within(status).queryByText("For task")).toBeNull();
    expect(within(status).getByText("Started by")).toBeTruthy();
    expect(within(status).getByText("An agent")).toBeTruthy();
    expect(within(status).getByText("State")).toBeTruthy();
    expect(within(status).getByText("Awake")).toBeTruthy();
    expect(
      within(status).getByText("destroys itself after 30 idle min"),
    ).toBeTruthy();
    const history = screen.getByTestId("sandbox-details-history");
    expect(history.textContent).toContain("Created");
    expect(history.textContent).toContain("by an agent");
    expect(
      screen.getByRole("region", { name: "Settings delivery" }).textContent,
    ).toBe(
      "Settings deliverySandbox setup did not apply.Support reference: SBX-0520",
    );

    act(() => {
      openSandboxDetails(startedByAgent.id);
    });
    const kept = screen.getByTestId("sandbox-details-status");
    expect(within(kept).getByText("Started by")).toBeTruthy();
    expect(within(kept).getByText("you")).toBeTruthy();
    expect(within(kept).queryByText("Planner")).toBeNull();
    expect(within(kept).queryByText("For task")).toBeNull();
    expect(within(kept).queryByText("Created by")).toBeNull();
  });

  it.each(SANDBOX_FIRST_BOOT_FAILURE_COPIES)(
    "shows the %s failure reason in Details",
    (stage, explanation) => {
      const summary = sandboxSummaryFixture({
        state: "failed",
        failureCode: stage,
      });
      list.data = { sandboxes: [summary] };
      render(<SandboxDetailsDrawerHost />);
      act(() => {
        openSandboxDetails(summary.id);
      });

      const status = screen.getByTestId("sandbox-details-status");
      expect(status.textContent).toContain(explanation);
      expect(status.textContent).not.toContain(stage);
    },
  );

  it.each([null, "future-stage:failure-detail"] as const)(
    "keeps the generic failed-start sentence for an unknown category (%s)",
    (failureCode) => {
      const summary = sandboxSummaryFixture({ state: "failed", failureCode });
      list.data = { sandboxes: [summary] };
      render(<SandboxDetailsDrawerHost />);
      act(() => {
        openSandboxDetails(summary.id);
      });

      const failed = within(
        screen.getByTestId("sandbox-details-status"),
      ).getByText("Failed to start");
      expect(failed).toBeTruthy();
      if (failureCode !== null) {
        expect(
          screen.getByTestId("sandbox-details-status").textContent,
        ).not.toContain(failureCode);
      }
    },
  );
});
