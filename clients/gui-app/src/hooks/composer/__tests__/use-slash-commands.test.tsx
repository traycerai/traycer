import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListGuiAgentCommandsResponse } from "@traycer/protocol/host/index";
import { useSlashCommands } from "../use-slash-commands";

const mockState = vi.hoisted(() => ({
  calls: [] as Array<{
    harnessId: string;
    workingDirectories: ReadonlyArray<string>;
    enabled: boolean;
    subscribed: boolean;
  }>,
  data: null as ListGuiAgentCommandsResponse | null,
  isPending: false,
  isFetching: false,
  error: null as Error | null,
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCommandsQuery: (
    hostClient: unknown,
    harnessId: string,
    workingDirectories: ReadonlyArray<string>,
    activity: { enabled: boolean; subscribed: boolean },
  ) => {
    void hostClient;
    mockState.calls.push({
      harnessId,
      workingDirectories,
      enabled: activity.enabled,
      subscribed: activity.subscribed,
    });
    return {
      data: mockState.data,
      isPending: mockState.isPending,
      isFetching: mockState.isFetching,
      error: mockState.error,
    };
  },
}));

describe("useSlashCommands", () => {
  beforeEach(() => {
    mockState.calls = [];
    mockState.data = {
      harnessId: "codex",
      commands: [
        {
          harnessId: "codex",
          name: "review",
          description: "Review current changes",
          argumentHint: null,
          kind: "slash-command",
          metadata: {},
        },
        {
          harnessId: "codex",
          name: "frontend-design",
          description: "Build polished frontend interfaces",
          argumentHint: "<component>",
          kind: "skill",
          metadata: { path: "/repo/.agents/skills/frontend-design/SKILL.md" },
        },
        {
          harnessId: "codex",
          name: "plan",
          description: "Run the prompt in plan mode",
          argumentHint: null,
          kind: "slash-command",
          metadata: {},
        },
      ],
    };
    mockState.isPending = false;
    mockState.isFetching = false;
    mockState.error = null;
  });

  it("queries the selected provider and returns provider commands", () => {
    const { result } = renderHook(() =>
      useSlashCommands("", {
        hostClient: null,
        harnessId: "codex",
        workingDirectories: ["/repo", "/repo/packages/app"],
        enabled: true,
      }),
    );

    expect(mockState.calls.at(-1)).toEqual({
      harnessId: "codex",
      workingDirectories: ["/repo", "/repo/packages/app"],
      enabled: true,
      subscribed: true,
    });
    expect(result.current.data.map((command) => command.name)).toEqual([
      "frontend-design",
      "plan",
      "review",
    ]);
    expect(result.current.data[0]).toMatchObject({
      source: "provider",
      description: "Build polished frontend interfaces",
    });
  });

  it("filters provider skills and exposes loading state", () => {
    mockState.isPending = true;

    const { result } = renderHook(() =>
      useSlashCommands("front", {
        hostClient: null,
        harnessId: "codex",
        workingDirectories: ["/repo"],
        enabled: true,
      }),
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toEqual([
      expect.objectContaining({
        source: "provider",
        name: "frontend-design",
        kind: "skill",
      }),
    ]);
  });
});
