import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { BotDeleteResult } from "@traycer-clients/shared/host-client/bot-setup";
import type { BotDeleteRequest } from "@traycer/protocol/host/bot/schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { useBotDeleteMutation } from "@/hooks/bots/use-bot-mutations";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REQUEST: BotDeleteRequest = { botId: BOT_ID };
const binding = vi.hoisted(
  (): {
    current: {
      readonly auth: {
        readonly deleteBot: (
          request: BotDeleteRequest,
        ) => Promise<BotDeleteResult>;
        readonly getIdentityGeneration: () => number;
        readonly isIdentityCurrent: (generation: number) => boolean;
      };
    } | null;
  } => ({ current: null }),
);

vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostBinding: () => binding.current,
}));

afterEach(() => {
  cleanup();
  binding.current = null;
});

function listKey(hostId: string) {
  return hostQueryKeys.method<HostRpcRegistry, "bot.list">(
    hostId,
    "bot.list",
    {},
  );
}

describe("useBotDeleteMutation", () => {
  it.each([true, false])(
    "treats deleted=%s as success and invalidates every host list",
    async (deleted) => {
      const queryClient = new QueryClient();
      const sent: BotDeleteRequest[] = [];
      binding.current = {
        auth: {
          getIdentityGeneration: () => 1,
          isIdentityCurrent: (generation) => generation === 1,
          deleteBot: (request) => {
            sent.push(request);
            return Promise.resolve({ kind: "ok" as const, deleted });
          },
        },
      };
      const local = listKey("host-local");
      const other = listKey("host-other");
      queryClient.setQueryData(local, { bots: [], mainBotIds: {} });
      queryClient.setQueryData(other, { bots: [], mainBotIds: {} });
      const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
        <QueryClientProvider client={queryClient}>
          {props.children}
        </QueryClientProvider>
      );
      const { result } = renderHook(() => useBotDeleteMutation(), { wrapper });

      await act(async () => {
        await expect(result.current.mutateAsync(REQUEST)).resolves.toEqual({
          deleted,
        });
      });

      expect(sent).toEqual([REQUEST]);
      expect(queryClient.getQueryState(local)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(other)?.isInvalidated).toBe(true);
    },
  );

  it("maps a refusal without invalidating a bot list", async () => {
    const queryClient = new QueryClient();
    binding.current = {
      auth: {
        getIdentityGeneration: () => 1,
        isIdentityCurrent: (generation) => generation === 1,
        deleteBot: () =>
          Promise.resolve({
            kind: "refused" as const,
            status: 404,
            message: "Not found",
          }),
      },
    };
    const local = listKey("host-local");
    queryClient.setQueryData(local, { bots: [], mainBotIds: {} });
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useBotDeleteMutation(), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync(REQUEST)).rejects.toThrow(
        "Not found",
      );
    });
    expect(queryClient.getQueryState(local)?.isInvalidated).toBe(false);
  });

  it("captures delete origin at press before TanStack continues", async () => {
    const queryClient = new QueryClient();
    const generation = { value: 1 };
    const sent: BotDeleteRequest[] = [];
    binding.current = {
      auth: {
        getIdentityGeneration: () => generation.value,
        isIdentityCurrent: (pressedAt) => pressedAt === generation.value,
        deleteBot: (request) => {
          sent.push(request);
          return Promise.resolve({ kind: "ok" as const, deleted: true });
        },
      },
    };
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useBotDeleteMutation(), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync(REQUEST)).resolves.toEqual({
        deleted: true,
      });
    });
    expect(sent).toEqual([REQUEST]);

    let abandoned: Promise<unknown> | undefined;
    act(() => {
      abandoned = result.current.mutateAsync(REQUEST);
      generation.value += 1;
    });
    await act(async () => {
      await expect(abandoned).resolves.toBeNull();
    });
    expect(sent).toEqual([REQUEST]);
  });

  it("answers without a binding and sends no delete", async () => {
    const queryClient = new QueryClient();
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useBotDeleteMutation(), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync(REQUEST)).rejects.toThrow(
        "Connect to manage settings.",
      );
    });
  });
});
