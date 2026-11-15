/**
 * The REAL `useBotUpdateRunSettingsMutation` over a real `QueryClient`: a
 * run-settings write the server accepts invalidates the cached `bot.list` of
 * every host. The write is the app's own call through the session service,
 * with no host in the path. What the panel does with a new row is pinned
 * separately in `bot-settings-panel-reseed.test.tsx`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { BotSetupWriteResult } from "@traycer-clients/shared/host-client/bot-setup";
import type {
  BotRecord,
  BotUpdateRunSettingsRequest,
} from "@traycer/protocol/host/bot/schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { createAppQueryClient } from "@/lib/query-client";
import { botQueryKeys } from "@/lib/query-keys/bot-query-keys";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import type { BotSubscriptionSnapshot } from "@/hooks/bots/use-bot-subscription";

// The window's binding: only its session service is read by this write.
const binding = vi.hoisted(
  (): {
    current: {
      readonly auth: {
        readonly updateBotRunSettings: (
          request: BotUpdateRunSettingsRequest,
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

import { useBotUpdateRunSettingsMutation } from "@/hooks/bots/use-bot-mutations";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const SNAPSHOT_BOT: BotRecord = {
  botId: BOT_ID,
  environmentId: "env-team",
  createdByUserId: "user-1",
  title: "Release Bot",
  harness: "claude",
  model: "model-old",
  effort: null,
  profile: null,
  trunkChatId: "trunk-1",
  boundHostId: "host-local",
  hostEpoch: 1,
  createdAt: 1_000,
  archivedAt: null,
  directive: null,
  replyMode: "thread",
  appConversationChatId: "app-chat-1",
};

function snapshot(
  bot: BotRecord,
  boundHostId: string,
): BotSubscriptionSnapshot {
  return {
    bot,
    tasks: [],
    openRequestCount: 1,
    conversationsRevision: 2,
    boundHost: { hostId: boundHostId, epoch: 1, isThisHost: true },
    activity: null,
    notificationSubscriptions: null,
    surfaceActions: null,
    stoppedNotificationWatches: null,
  };
}

afterEach(() => {
  cleanup();
  binding.current = null;
});

describe("useBotUpdateRunSettingsMutation", () => {
  it("sends the write on the person's sign-in and invalidates every host's cached bot list", async () => {
    const queryClient = createAppQueryClient();
    const sent: BotUpdateRunSettingsRequest[] = [];
    binding.current = {
      auth: {
        updateBotRunSettings: (request) => {
          sent.push(request);
          return Promise.resolve({
            kind: "ok",
            bot: { ...request, replyMode: "thread" },
          });
        },
        getIdentityGeneration: () => 1,
        isIdentityCurrent: (generation) => generation === 1,
      },
    };
    const listKey = hostQueryKeys.method<HostRpcRegistry, "bot.list">(
      "host-local",
      "bot.list",
      {},
    );
    const otherHostListKey = hostQueryKeys.method<HostRpcRegistry, "bot.list">(
      "host-other",
      "bot.list",
      {},
    );
    queryClient.setQueryData(listKey, { bots: [], mainBotIds: {} });
    queryClient.setQueryData(otherHostListKey, { bots: [], mainBotIds: {} });
    const firstSnapshot = botQueryKeys.subscription({
      hostId: "host-local",
      botId: BOT_ID,
    });
    const secondSnapshot = botQueryKeys.subscription({
      hostId: "host-other",
      botId: BOT_ID,
    });
    const differentBot = botQueryKeys.subscription({
      hostId: "host-other",
      botId: "bot-other",
    });
    queryClient.setQueryData(
      firstSnapshot,
      snapshot(SNAPSHOT_BOT, "host-local"),
    );
    queryClient.setQueryData(
      secondSnapshot,
      snapshot({ ...SNAPSHOT_BOT, boundHostId: "host-other" }, "host-other"),
    );
    const otherBotRecord = {
      ...SNAPSHOT_BOT,
      botId: "bot-other",
      title: "Other Bot",
    };
    queryClient.setQueryData(
      differentBot,
      snapshot(otherBotRecord, "host-other"),
    );
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useBotUpdateRunSettingsMutation(), {
      wrapper,
    });
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(otherHostListKey)?.isInvalidated).toBe(
      false,
    );

    const request: BotUpdateRunSettingsRequest = {
      botId: BOT_ID,
      harness: "codex",
      model: "model-x",
      effort: null,
      profile: null,
    };
    await act(async () => {
      await result.current.mutateAsync(request);
    });

    expect(sent).toEqual([request]);
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherHostListKey)?.isInvalidated).toBe(
      true,
    );
    expect(
      queryClient.getQueryData<BotSubscriptionSnapshot>(firstSnapshot),
    ).toMatchObject({
      bot: { ...SNAPSHOT_BOT, ...request, replyMode: "thread" },
      openRequestCount: 1,
      conversationsRevision: 2,
      boundHost: { hostId: "host-local", epoch: 1, isThisHost: true },
    });
    expect(
      queryClient.getQueryData<BotSubscriptionSnapshot>(secondSnapshot),
    ).toMatchObject({
      bot: {
        ...SNAPSHOT_BOT,
        ...request,
        replyMode: "thread",
        boundHostId: "host-other",
      },
      boundHost: { hostId: "host-other", epoch: 1, isThisHost: true },
    });
    expect(
      queryClient.getQueryData<BotSubscriptionSnapshot>(differentBot),
    ).toEqual(snapshot(otherBotRecord, "host-other"));
  });
});
