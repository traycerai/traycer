import type { ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { LazyMotion, domMax } from "motion/react";
import type { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

/** The query client, runner host and host runtime around a tree page's own providers. */
export function FixtureProviders(props: {
  readonly queryClient: QueryClient;
  readonly runnerHost: MockRunnerHost;
  readonly messengerFactory: MessengerFactory<HostRpcRegistry>;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <QueryClientProvider client={props.queryClient}>
      <RunnerHostProvider runnerHost={props.runnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={props.messengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-fixture-runtime-fallback />}
        >
          <LazyMotion features={domMax}>
            <TooltipProvider>{props.children}</TooltipProvider>
          </LazyMotion>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}
