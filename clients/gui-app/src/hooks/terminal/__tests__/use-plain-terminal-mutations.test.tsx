import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PlainTerminalProjection,
  RenamePlainTerminalRequest,
} from "@traycer/protocol/host/terminal/plain-schemas";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import {
  replacePlainTerminalSnapshot,
  setPlainTerminalStreamStatus,
  settlePlainTerminalSnapshot,
  type PlainTerminalCollection,
  type PlainTerminalProjectionBarrier,
} from "@/lib/terminals/plain-terminal-authority";
import type { PlainTerminalMutationAuthority } from "@/hooks/terminal/use-plain-terminal-mutations";

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: vi.fn(),
}));

type CapturedMutation = {
  readonly mapVariables: (variables: never) => unknown;
  readonly options: {
    readonly onMutate?: (variables: never) => unknown;
    readonly onSuccess?: (
      response: never,
      variables: never,
      context: {
        hostId: string;
        scope: PlainTerminalMutationAuthority["scope"];
        barrier: PlainTerminalProjectionBarrier;
      },
    ) => void;
  };
};

const captured = new Map<string, CapturedMutation>();

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: CapturedMutation & { readonly method: string }) => {
    captured.set(args.method, args);
    return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
  },
}));

import { usePlainTerminalMutations } from "@/hooks/terminal/use-plain-terminal-mutations";

const SCOPE = { kind: "epic", epicId: "epic-1" } as const;

function terminal(overrides: {
  readonly hostId?: string;
  readonly revision?: number;
  readonly manualTitle?: string | null;
}): PlainTerminalProjection {
  return {
    record: {
      terminalId: "terminal-1",
      hostId: overrides.hostId ?? "host-a",
      scope: SCOPE,
      launch: {
        cwd: "/work",
        shellCommand: "/bin/zsh",
        shellArgs: [],
      },
      manualTitle: overrides.manualTitle ?? null,
      revision: overrides.revision ?? 1,
      createdAt: "2026-08-16T10:00:00.000Z",
      updatedAt: "2026-08-16T10:00:00.000Z",
    },
    runtime: { status: "dormant" },
  };
}

function collection(hostId: string): PlainTerminalCollection {
  return setPlainTerminalStreamStatus(
    settlePlainTerminalSnapshot(
      replacePlainTerminalSnapshot(undefined, [terminal({ hostId })]),
    ),
    "open",
  );
}

function authority(
  hostId: string,
  overrides: Partial<PlainTerminalMutationAuthority>,
): PlainTerminalMutationAuthority {
  return {
    hostId,
    scope: SCOPE,
    canMutate: true,
    collection: collection(hostId),
    ...overrides,
  };
}

function wrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("plain terminal mutation authority", () => {
  beforeEach(() => {
    captured.clear();
    vi.clearAllMocks();
  });

  it("writes a delayed canonical response to the host captured at mutation start", () => {
    const queryClient = new QueryClient();
    const rendered = renderHook(
      ({ currentAuthority }) =>
        usePlainTerminalMutations({
          authority: currentAuthority,
          client: null,
        }),
      {
        initialProps: { currentAuthority: authority("host-a", {}) },
        wrapper: wrapper(queryClient),
      },
    );
    expect(rendered.result.current.rename).toBeDefined();
    const started = captured.get("terminal.plain.rename");
    if (started === undefined) throw new Error("rename mutation was not bound");
    const context = started.options.onMutate?.({} as never);

    rendered.rerender({ currentAuthority: authority("host-b", {}) });
    const canonical = terminal({
      hostId: "host-a",
      revision: 2,
      manualTitle: "canonical",
    });
    started.options.onSuccess?.(
      { terminal: canonical } as never,
      {} as never,
      context as {
        hostId: string;
        scope: typeof SCOPE;
        barrier: PlainTerminalProjectionBarrier;
      },
    );

    expect(
      queryClient.getQueryData<PlainTerminalCollection>(
        hostQueryKeys.plainTerminals("host-a", SCOPE),
      )?.terminalsById["terminal-1"]?.record.manualTitle,
    ).toBe("canonical");
    expect(
      queryClient.getQueryData(hostQueryKeys.plainTerminals("host-b", SCOPE)),
    ).toBeUndefined();
  });

  it("uses ensureRunning only for an existing logical id and never falls back to create", () => {
    const queryClient = new QueryClient();
    renderHook(
      () =>
        usePlainTerminalMutations({
          authority: authority("host-a", {}),
          client: null,
        }),
      { wrapper: wrapper(queryClient) },
    );
    const ensure = captured.get("terminal.plain.ensureRunning");
    if (ensure === undefined) {
      throw new Error("plain terminal mutations were not bound");
    }

    expect(() =>
      ensure.mapVariables({
        terminalId: "missing-terminal",
        cols: 80,
        rows: 24,
      } as never),
    ).toThrow("Cannot bootstrap an unknown terminal");
  });

  it("blocks mutation variables while capable host data is stale", () => {
    const queryClient = new QueryClient();
    renderHook(
      () =>
        usePlainTerminalMutations({
          authority: authority("host-a", { canMutate: false }),
          client: null,
        }),
      { wrapper: wrapper(queryClient) },
    );
    const rename = captured.get("terminal.plain.rename");
    if (rename === undefined) throw new Error("rename mutation was not bound");
    const request: RenamePlainTerminalRequest = {
      terminalId: "terminal-1",
      manualTitle: "blocked",
    };
    expect(() => rename.mapVariables(request as never)).toThrow(
      "Cached data is view-only",
    );
  });
});
