import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { BotSetupWriteResult } from "@traycer-clients/shared/host-client/bot-setup";
import type { BotUpdateReplyModeRequest } from "@traycer/protocol/host/bot/schemas";
import { EnvironmentCloudError } from "@traycer-clients/shared/environment/environment-cloud";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { useBotUpdateReplyModeMutation } from "@/hooks/bots/use-bot-mutations";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REQUEST: BotUpdateReplyModeRequest = {
  botId: BOT_ID,
  replyMode: "direct",
};
const binding = vi.hoisted(
  (): {
    current: {
      readonly auth: {
        readonly updateBotReplyMode: (
          request: BotUpdateReplyModeRequest,
        ) => Promise<BotSetupWriteResult>;
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

describe("useBotUpdateReplyModeMutation", () => {
  it("writes through the person's sign-in and invalidates every host list", async () => {
    const queryClient = new QueryClient();
    const sent: BotUpdateReplyModeRequest[] = [];
    binding.current = {
      auth: {
        getIdentityGeneration: () => 1,
        isIdentityCurrent: (generation) => generation === 1,
        updateBotReplyMode: async (request) => {
          sent.push(request);
          return {
            kind: "ok",
            bot: {
              botId: request.botId,
              harness: "claude",
              model: "model-a",
              effort: null,
              profile: null,
              replyMode: request.replyMode,
            },
          };
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
    const { result } = renderHook(() => useBotUpdateReplyModeMutation(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync(REQUEST);
    });

    expect(sent).toEqual([REQUEST]);
    expect(queryClient.getQueryState(local)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(other)?.isInvalidated).toBe(true);
  });

  it("throws the mapped refusal and leaves every cached list current", async () => {
    const queryClient = new QueryClient();
    binding.current = {
      auth: {
        getIdentityGeneration: () => 1,
        isIdentityCurrent: (generation) => generation === 1,
        updateBotReplyMode: async () => ({
          kind: "refused",
          status: 422,
          message: "Replies must stay in threads",
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
    const { result } = renderHook(() => useBotUpdateReplyModeMutation(), {
      wrapper,
    });

    await act(async () => {
      await expect(result.current.mutateAsync(REQUEST)).rejects.toMatchObject({
        message: "Replies must stay in threads",
        kind: "invalid",
      } satisfies Partial<EnvironmentCloudError>);
    });
    expect(queryClient.getQueryState(local)?.isInvalidated).toBe(false);
  });

  it("answers without a binding and sends no write", async () => {
    const queryClient = new QueryClient();
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useBotUpdateReplyModeMutation(), {
      wrapper,
    });

    await act(async () => {
      await expect(result.current.mutateAsync(REQUEST)).rejects.toThrow(
        "Connect to manage settings.",
      );
    });
  });
});
