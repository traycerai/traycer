import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { botConversationListV10 } from "@traycer/protocol/host/bot/contracts";
import {
  CHANNEL_LIST,
  TAB_HOST_ID,
} from "@/components/bots/__tests__/bot-channel-cloud-test-support";
import { BOT_ID } from "@/components/bots/__tests__/bot-turn-test-support";
import {
  installBotReadReadability,
  retainedReadableBy,
} from "@/lib/bots/bot-read-readability";
import { currentBotLifetime } from "@/lib/bots/bot-lifetime";
import { botReadView } from "@/lib/bots/bot-read-view";
import type { HostRpcRegistry } from "@/lib/host";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

describe("installBotReadReadability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds no auth-store listener for the clients it is installed on, so no listener holds a client", () => {
    const subscribe = vi.spyOn(useAuthStore, "subscribe");

    for (let client = 0; client < 3; client += 1) {
      installBotReadReadability(new QueryClient());
    }

    expect(subscribe).not.toHaveBeenCalled();
  });

  it("withdraws retained bot rows on a decoded per-call membership refusal", async () => {
    const previous = useAuthStore.getState().contextMetadata;
    const viewer = "viewer";
    useAuthStore.setState({
      contextMetadata: { userId: viewer, username: viewer },
    });
    onTestFinished(() => useAuthStore.setState({ contextMetadata: previous }));

    const client = createAppQueryClient();
    const method = "bot.conversation.list";
    const queryKey = hostQueryKeys.method<HostRpcRegistry, typeof method>(
      TAB_HOST_ID,
      method,
      { botId: BOT_ID },
    );
    const answer = await client.fetchQuery({
      queryKey,
      queryFn: () =>
        Promise.resolve(
          botConversationListV10.responseSchema.parse(CHANNEL_LIST),
        ),
    });
    const lifetime = currentBotLifetime();
    expect(retainedReadableBy(answer, viewer, lifetime)).toBe(true);

    const refusal = HostRpcError.fromWireEnvelope(
      {
        code: "TEAM_MEMBERSHIP_REQUIRED",
        message: "This account cannot access this computer",
        retryable: false,
        doorReason: "membership_removed",
      },
      "refusal",
      method,
    );
    const reread = vi.fn(() => Promise.reject(refusal));
    await expect(
      client.fetchQuery({
        queryKey,
        queryFn: reread,
        staleTime: 0,
        retryDelay: 0,
      }),
    ).rejects.toBe(refusal);

    const read = client.getQueryState(queryKey);
    if (read === undefined) throw new Error("The bot read was removed");
    const readable = retainedReadableBy(read.data, viewer, lifetime);
    expect(
      botReadView({ ...read, isError: read.status === "error" }, readable),
    ).toEqual({
      kind: "failed",
      failure: "access-refused",
      rowsWithheld: true,
    });
    expect(readable).toBe(false);
    expect(reread).toHaveBeenCalledOnce();
  });
});
