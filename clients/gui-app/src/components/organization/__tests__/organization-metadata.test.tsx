import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import {
  HistoryImportedStatus,
  OrganizationDetails,
} from "@/components/organization/organization-metadata";
import { useImportedUnseenStore } from "@/stores/session-import/imported-unseen-store";
import type {
  TaskLabel,
  TaskOrganization,
} from "@traycer/protocol/host/organization/schemas";

const state = vi.hoisted(() => ({
  organization: {
    supported: true,
    userId: "user-1",
    view: undefined,
    register: () => () => undefined,
    openDialog: () => undefined,
    command: () => Promise.resolve(),
  },
}));

vi.mock("@/hooks/organization/organization-context", async (load) => {
  const actual =
    await load<typeof import("@/hooks/organization/organization-context")>();
  return { ...actual, useOrganization: () => state.organization };
});

vi.mock("@/hooks/epics/use-epic-collaborators-query", () => ({
  useEpicCollaboratorsQuery: () => ({ data: { flatRows: [] } }),
}));

function historyItem(overrides: Partial<HistoryItem>): HistoryItem {
  return {
    id: "history-1",
    epicId: "epic-1",
    taskType: "epic",
    title: "Imported task",
    initialUserPrompt: "",
    updatedAtMs: 1_700_000_000_000,
    updatedLabel: "about 2 hours ago",
    updatedBucket: "today",
    linkedRepos: [],
    linkedWorkspaces: [],
    chatHostIds: null,
    pullRequestNumbers: [],
    worktreeBranches: [],
    worktreePaths: [],
    ownership: "mine",
    permissionRole: "owner",
    isPinned: false,
    ...overrides,
  };
}

function resetUnseen(): void {
  useImportedUnseenStore.setState({ unseen: {} });
}

beforeEach(() => {
  resetUnseen();
  state.organization.supported = true;
});

afterEach(() => {
  cleanup();
  resetUnseen();
});

describe("organization history metadata", () => {
  it("removes the imported-unseen dot for supported cloud epics", () => {
    act(() => {
      useImportedUnseenStore.getState().markImported("cloud-epic", "claude");
    });

    render(
      <HistoryImportedStatus item={historyItem({ epicId: "cloud-epic" })} />,
    );

    expect(screen.queryByTestId("imported-unseen-dot")).toBeNull();
  });

  it("retains the imported-unseen dot for legacy and local history rows", () => {
    state.organization.supported = false;
    act(() => {
      useImportedUnseenStore.getState().markImported("legacy-epic", "codex");
    });
    render(
      <HistoryImportedStatus item={historyItem({ epicId: "legacy-epic" })} />,
    );
    expect(screen.getByTestId("imported-unseen-dot")).toBeTruthy();

    cleanup();
    state.organization.supported = true;
    act(() => {
      useImportedUnseenStore.getState().markImported("local-epic", "opencode");
    });
    render(
      <HistoryImportedStatus
        item={historyItem({ epicId: "local-epic", isLocalHome: true })}
      />,
    );
    expect(screen.getByTestId("imported-unseen-dot")).toBeTruthy();
  });

  it("keeps the permanent Imported label metadata after unseen state is cleared", () => {
    const importedLabel: TaskLabel = {
      ownerId: "__system_labels__",
      labelId: "imported",
      assignmentId: "assignment-1",
      kind: "system",
      systemKey: "imported",
      name: "Imported",
      color: "#8ab4f8",
      version: "0",
    };
    const fallback: TaskOrganization = {
      group: null,
      appearance: {
        taskId: "epic-1",
        version: "0",
        color: null,
        icon: null,
      },
      labels: [importedLabel],
    };
    act(() => {
      useImportedUnseenStore.getState().markImported("epic-1", "claude");
    });
    render(<OrganizationDetails taskId="epic-1" fallback={fallback} />);
    expect(screen.getByText(/Imported/)).toBeTruthy();

    act(() => {
      useImportedUnseenStore.getState().markSeen("epic-1");
    });
    expect(screen.getByText(/Imported/)).toBeTruthy();
  });
});
