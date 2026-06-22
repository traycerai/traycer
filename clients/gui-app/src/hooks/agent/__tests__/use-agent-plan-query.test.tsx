import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentPlanQuery } from "@/hooks/agent/use-agent-plan-query";

interface CapturedHostQuery {
  readonly client: object | null;
  readonly method: string;
  readonly params: {
    readonly epicId: string;
    readonly chatId: string;
    readonly planId: string;
  };
  readonly cacheKeyIdentity: ReadonlyArray<unknown> | undefined;
  readonly options: {
    readonly enabled: boolean | undefined;
    readonly staleTime: number | undefined;
    readonly retry: boolean | undefined;
  } | null;
}

const tabClient = vi.hoisted<{ value: object | null }>(() => ({ value: {} }));
const captured = vi.hoisted<{ value: CapturedHostQuery | null }>(() => ({
  value: null,
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => tabClient.value,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: CapturedHostQuery) => {
    captured.value = args;
    return { data: undefined, isFetching: false, isError: false };
  },
}));

describe("useAgentPlanQuery", () => {
  beforeEach(() => {
    tabClient.value = {};
    captured.value = null;
  });

  it("uses the tab host client and keeps content identity in the cache key", () => {
    renderHook(() =>
      useAgentPlanQuery({
        epicId: "epic-1",
        chatId: "chat-1",
        planId: "plan-1",
        contentIdentity: "hash-1",
        enabled: true,
      }),
    );

    expect(captured.value?.client).toBe(tabClient.value);
    expect(captured.value?.method).toBe("agent.gui.getPlan");
    expect(captured.value?.params).toEqual({
      epicId: "epic-1",
      chatId: "chat-1",
      planId: "plan-1",
    });
    expect(captured.value?.cacheKeyIdentity).toEqual(["hash-1"]);
    expect(captured.value?.options?.enabled).toBe(true);
  });

  it("passes disabled state through so modal-closed plans do not fetch", () => {
    renderHook(() =>
      useAgentPlanQuery({
        epicId: "epic-1",
        chatId: "chat-1",
        planId: "plan-1",
        contentIdentity: "revision-2",
        enabled: false,
      }),
    );

    expect(captured.value?.options?.enabled).toBe(false);
    expect(captured.value?.cacheKeyIdentity).toEqual(["revision-2"]);
  });
});
