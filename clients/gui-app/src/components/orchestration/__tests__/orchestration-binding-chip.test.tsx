import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOrchestrationBindingStore } from "@/stores/orchestration/orchestration-binding-store";
import { useOrchestrationEpicOverridesStore } from "@/stores/orchestration/orchestration-epic-overrides-store";
import { OrchestrationBindingChip } from "../orchestration-binding-chip";

vi.mock("@/hooks/runner/use-runner-orchestration-queries", () => ({
  useRunnerOrchestrationListQuery: () => ({
    data: ["dev-team", "x"],
    isLoading: false,
  }),
  useRunnerOrchestrationGroupsQuery: () => ({
    data: ["cheap", "premium"],
    isLoading: false,
  }),
  useRunnerOrchestrationShowQuery: (name: string) => ({
    data: {
      name,
      roles: [
        { id: "orchestrator", label: "Orchestrator" },
        { id: "y", label: "Y" },
      ],
    },
    isLoading: false,
  }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ traycerCli: {} }),
}));

const GLOBAL = {
  enabled: true,
  orchestrationName: "dev-team",
  roleId: "orchestrator",
  modelGroup: null as string | null,
};

beforeEach(() => {
  window.localStorage.clear();
  useOrchestrationEpicOverridesStore.getState().resetForTests();
  useOrchestrationBindingStore.getState().setBinding(GLOBAL);
});

afterEach(() => {
  cleanup();
  useOrchestrationEpicOverridesStore.getState().resetForTests();
  useOrchestrationBindingStore.getState().setBinding(GLOBAL);
});

describe("OrchestrationBindingChip", () => {
  it("renders the effective binding label", async () => {
    render(<OrchestrationBindingChip epicId="epic-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("orchestration-binding-chip").textContent).toContain(
        "dev-team",
      );
    });
    expect(screen.getByTestId("orchestration-binding-chip").textContent).toContain(
      "orchestrator",
    );
    expect(screen.getByTestId("orchestration-binding-chip").textContent).toContain(
      "Default",
    );
  });

  it("popover change writes a per-epic override", async () => {
    const user = userEvent.setup();
    render(<OrchestrationBindingChip epicId="epic-1" />);

    await user.click(screen.getByTestId("orchestration-binding-chip"));
    await waitFor(() => {
      expect(screen.getByTestId("orchestration-binding-popover")).toBeTruthy();
    });

    await user.selectOptions(
      screen.getByTestId("orchestration-binding-name"),
      "x",
    );
    await user.selectOptions(
      screen.getByTestId("orchestration-binding-role"),
      "y",
    );
    await user.selectOptions(
      screen.getByTestId("orchestration-binding-group"),
      "cheap",
    );

    expect(
      useOrchestrationEpicOverridesStore.getState().overridesByEpicId["epic-1"],
    ).toMatchObject({
      orchestrationName: "x",
      roleId: "y",
      modelGroup: "cheap",
      enabled: true,
    });
    expect(screen.getByTestId("orchestration-binding-dirty-dot")).toBeTruthy();
  });

  it("Reset to global clears the override and chip reflects global", async () => {
    const user = userEvent.setup();
    useOrchestrationEpicOverridesStore.getState().setEpicOverride("epic-1", {
      enabled: true,
      orchestrationName: "x",
      roleId: "y",
      modelGroup: "cheap",
    });

    render(<OrchestrationBindingChip epicId="epic-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("orchestration-binding-chip").textContent).toContain(
        "x",
      );
    });

    await user.click(screen.getByTestId("orchestration-binding-chip"));
    await user.click(screen.getByTestId("orchestration-binding-reset"));

    expect(
      useOrchestrationEpicOverridesStore.getState().overridesByEpicId,
    ).toEqual({});
    await waitFor(() => {
      expect(screen.getByTestId("orchestration-binding-chip").textContent).toContain(
        "dev-team",
      );
    });
  });

  it("disabled global + no override shows Team off; toggle enables override", async () => {
    const user = userEvent.setup();
    useOrchestrationBindingStore.getState().setBinding({
      ...GLOBAL,
      enabled: false,
    });

    render(<OrchestrationBindingChip epicId="epic-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("orchestration-binding-chip").textContent).toContain(
        "Team: off",
      );
    });

    await user.click(screen.getByTestId("orchestration-binding-chip"));
    await user.click(screen.getByTestId("orchestration-binding-enabled"));

    expect(
      useOrchestrationEpicOverridesStore.getState().overridesByEpicId["epic-1"]
        ?.enabled,
    ).toBe(true);
  });
});
