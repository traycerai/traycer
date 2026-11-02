import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type {
  BotThreadFollow,
  BotThreadFollowSetRequest,
} from "@traycer/protocol/host/bot/schemas";

/**
 * A host that keeps one person's thread follows (`bot.threadFollow.read` /
 * `.set`) behind a real HostClient and QueryClient. Tests change `follows`
 * to play another device, hold the re-read with `holdRead`, or refuse the
 * write with `refuse`.
 */
export interface FollowHostFixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly follows: Record<string, BotThreadFollow>;
  readonly reads: { count: number };
  readonly writes: BotThreadFollowSetRequest[];
  readonly control: {
    refuse: boolean;
    holdRead: boolean;
    releaseRead: (() => void) | null;
  };
}

export function createFollowHostFixture(
  initial: Record<string, BotThreadFollow>,
): FollowHostFixture {
  const follows: Record<string, BotThreadFollow> = { ...initial };
  const reads = { count: 0 };
  const writes: BotThreadFollowSetRequest[] = [];
  const control: FollowHostFixture["control"] = {
    refuse: false,
    holdRead: false,
    releaseRead: null,
  };
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "bot.threadFollow.read": async () => {
          reads.count += 1;
          if (control.holdRead) {
            await new Promise<void>((resolve) => {
              control.releaseRead = resolve;
            });
          }
          return { follows: { ...follows } };
        },
        "bot.threadFollow.set": (params) => {
          writes.push(params);
          if (control.refuse) throw new Error("The thread was not found.");
          const follow: BotThreadFollow = {
            state: params.state,
            reason: "manual",
          };
          follows[params.threadId] = follow;
          return { follow };
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    client: spine.createRequester(mockLocalHostEntry),
    queryClient,
    Wrapper,
    follows,
    reads,
    writes,
    control,
  };
}
