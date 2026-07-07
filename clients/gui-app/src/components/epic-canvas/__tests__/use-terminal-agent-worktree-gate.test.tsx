import "../../../../__tests__/test-browser-apis";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { CreateTuiAgentInput } from "@/hooks/agent/use-create-tui-agent";

const gateMocks = vi.hoisted(() => ({
  create: vi.fn<(input: CreateTuiAgentInput) => Promise<string | null>>(),
  isPending: false,
}));

vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgent: () => ({
    create: gateMocks.create,
    isPending: gateMocks.isPending,
  }),
}));

import { useTerminalAgentWorktreeGate } from "@/components/epic-canvas/hooks/use-terminal-agent-worktree-gate";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";

const EPIC_ID = "epic-gate";
const TAB_ID = "tab-gate";

describe("useTerminalAgentWorktreeGate", () => {
  beforeEach(() => {
    window.localStorage.clear();
    gateMocks.create.mockReset();
    gateMocks.create.mockResolvedValue("agent-id");
    gateMocks.isPending = false;
    useWorktreeIntentMemoryStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
    useWorktreeIntentMemoryStore.getState().resetForTests();
  });

  it("forwards a null intent straight through to useCreateTuiAgent.create", () => {
    const { result } = renderHook(() =>
      useTerminalAgentWorktreeGate(EPIC_ID, TAB_ID),
    );

    act(() => {
      result.current.requestCreate({
        harnessId: "claude",
        model: null,
        reasoningEffort: null,
        agentMode: "regular",
        workspaceMode: "inherit",
        worktreeIntent: null,
        terminalAgentArgs: null,
      });
    });

    expect(gateMocks.create).toHaveBeenCalledTimes(1);
    expect(gateMocks.create).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      tabId: TAB_ID,
      parentId: null,
      title: "",
      harnessId: "claude",
      model: null,
      reasoningEffort: null,
      agentMode: "regular",
      workspaceMode: "inherit",
      worktreeIntent: null,
      terminalAgentArgs: null,
      forkSourceHarnessSessionId: null,
      onStatusChange: null,
      placement: { kind: "active-tile" },
    });
    expect(
      useWorktreeIntentMemoryStore.getState().getEpicIntent(EPIC_ID),
    ).toBeNull();
  });

  it("remembers a non-empty intent as the per-epic intent for the next open", () => {
    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/tmp/ws",
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "traycer/feature",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    };
    const { result } = renderHook(() =>
      useTerminalAgentWorktreeGate(EPIC_ID, TAB_ID),
    );

    act(() => {
      result.current.requestCreate({
        harnessId: "codex",
        model: "gpt-5",
        reasoningEffort: "high",
        agentMode: "regular",
        workspaceMode: "inherit",
        worktreeIntent: intent,
        terminalAgentArgs: "--full-auto",
      });
    });

    expect(gateMocks.create).toHaveBeenCalledTimes(1);
    expect(gateMocks.create.mock.calls[0][0]).toMatchObject({
      agentMode: "regular",
      model: "gpt-5",
      reasoningEffort: "high",
      workspaceMode: "inherit",
      worktreeIntent: intent,
      terminalAgentArgs: "--full-auto",
    });
    expect(
      useWorktreeIntentMemoryStore.getState().getEpicIntent(EPIC_ID),
    ).toEqual(intent);
  });

  it("does not overwrite the per-epic intent with an empty-entries intent", () => {
    const previous: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/tmp/ws",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    useWorktreeIntentMemoryStore.getState().setEpicIntent(EPIC_ID, previous, 1);
    const { result } = renderHook(() =>
      useTerminalAgentWorktreeGate(EPIC_ID, TAB_ID),
    );

    act(() => {
      result.current.requestCreate({
        harnessId: "claude",
        model: null,
        reasoningEffort: null,
        agentMode: "epic",
        workspaceMode: "folderless",
        worktreeIntent: { entries: [] },
        terminalAgentArgs: null,
      });
    });

    expect(
      useWorktreeIntentMemoryStore.getState().getEpicIntent(EPIC_ID),
    ).toEqual(previous);
  });

  it("exposes the underlying mutation's isPending flag", () => {
    gateMocks.isPending = true;
    const { result } = renderHook(() =>
      useTerminalAgentWorktreeGate(EPIC_ID, TAB_ID),
    );

    expect(result.current.isPending).toBe(true);
  });
});
