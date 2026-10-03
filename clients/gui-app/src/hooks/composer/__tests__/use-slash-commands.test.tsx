import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GuiAgentCommandOption,
  ListGuiAgentCommandsResponse,
} from "@traycer/protocol/host/index";
import { useSlashCommands } from "../use-slash-commands";
import type { LocalSlashCommand } from "@/lib/composer/types";

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
      refetch: () => Promise.resolve(),
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
        localCommands: [],
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

  it("ranks the best fuzzy match first and exposes loading state", () => {
    mockState.isPending = true;

    const { result } = renderHook(() =>
      useSlashCommands("front", {
        hostClient: null,
        harnessId: "codex",
        workingDirectories: ["/repo"],
        enabled: true,
        localCommands: [],
      }),
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data[0]).toMatchObject({
      source: "provider",
      name: "frontend-design",
      kind: "skill",
    });
    expect(result.current.data.map((cmd) => cmd.name)).not.toContain("plan");
  });

  it("skips computing the command list entirely while disabled, then sorts numeric/case-insensitively once enabled", () => {
    // A getter on `name`, not a plain string: proves the disabled path never
    // reads it at all (never maps, dedupes, or sorts the catalog), rather
    // than just filtering a computed list down to nothing afterward.
    let nameReads = 0;
    const trackedProviderCommand = (name: string): GuiAgentCommandOption => ({
      harnessId: "codex",
      get name() {
        nameReads++;
        return name;
      },
      description: `desc-${name}`,
      argumentHint: null,
      kind: "slash-command",
      metadata: {},
    });
    mockState.data = {
      harnessId: "codex",
      commands: [
        trackedProviderCommand("review10"),
        trackedProviderCommand("Review2"),
      ],
    };
    const trackedLocalCommand: LocalSlashCommand = {
      source: "local",
      harnessId: "codex",
      get name() {
        nameReads++;
        return "alpha";
      },
      description: "Local alpha",
      argumentHint: null,
      kind: "slash-command",
      metadata: {},
      preview: {
        kind: "text",
        primary: "Local alpha",
        secondary: null,
        mono: false,
      },
    };

    const { result, rerender } = renderHook(
      (props: { enabled: boolean }) =>
        useSlashCommands("", {
          hostClient: null,
          harnessId: "codex",
          workingDirectories: ["/repo"],
          enabled: props.enabled,
          localCommands: [trackedLocalCommand],
        }),
      { initialProps: { enabled: false } },
    );

    expect(result.current.data).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(nameReads).toBe(0);
    expect(mockState.calls.at(-1)).toMatchObject({
      enabled: false,
      subscribed: false,
    });

    rerender({ enabled: true });

    // sensitivity: "base" (case-insensitive) + numeric: true (2 before 10).
    expect(result.current.data.map((command) => command.name)).toEqual([
      "alpha",
      "Review2",
      "review10",
    ]);
    expect(nameReads).toBeGreaterThan(0);
  });

  it("lists localCommands and lets a local row shadow a same-named provider row", () => {
    mockState.data = {
      harnessId: "claude",
      commands: [
        {
          harnessId: "claude",
          name: "btw",
          description: "Provider's own btw command",
          argumentHint: null,
          kind: "slash-command",
          metadata: {},
        },
        {
          harnessId: "claude",
          name: "review",
          description: "Review current changes",
          argumentHint: null,
          kind: "slash-command",
          metadata: {},
        },
      ],
    };

    const localBtw: LocalSlashCommand = {
      source: "local",
      harnessId: "claude",
      name: "btw",
      description: "Ask a side question in a forked copy of this chat",
      argumentHint: "<question>",
      kind: "slash-command",
      metadata: {},
      preview: {
        kind: "text",
        primary: "Ask a side question <question>",
        secondary: null,
        mono: false,
      },
    };

    const { result } = renderHook(() =>
      useSlashCommands("", {
        hostClient: null,
        harnessId: "claude",
        workingDirectories: ["/repo"],
        enabled: true,
        localCommands: [localBtw],
      }),
    );

    const btwRows = result.current.data.filter(
      (command) => command.name.toLowerCase() === "btw",
    );
    expect(btwRows).toHaveLength(1);
    expect(btwRows[0]).toMatchObject({
      source: "local",
      description: "Ask a side question in a forked copy of this chat",
    });
    expect(result.current.data.map((command) => command.name)).toContain(
      "review",
    );
  });
});
