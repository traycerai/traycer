/**
 * The REAL bot task action mutations over a real `HostClient` and
 * `QueryClient`, with the real Sonner `<Toaster />` mounted: when the host
 * refuses a reporting action with an error nothing maps to its own sentence,
 * the toast the person is shown names the reporting action they pressed, in
 * the words the Activity page uses for it. What is read back is the text on
 * screen, not what the hook handed to a toast function.
 */
import { useEffect, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { toast, Toaster } from "sonner";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  BotTaskActionRequest,
  BotTaskSetPausedRequest,
} from "@traycer/protocol/host/bot/task-action-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import {
  useBotTaskRunNowMutation,
  useBotTaskSetPausedMutation,
  useBotTaskStopMutation,
} from "@/hooks/bots/use-bot-task-action-mutations";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TASK_ID = "task-1";

type Sent = {
  readonly runNow: BotTaskActionRequest[];
  readonly setPaused: BotTaskSetPausedRequest[];
  readonly stop: BotTaskActionRequest[];
};

/** A refusal no mapped sentence covers, from a host that was reached and answered. */
function refusal(method: string): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "refused",
    requestId: "req-task-action",
    method,
    fatalDetails: null,
  });
}

function buildClient(
  queryClient: QueryClient,
  sent: Sent,
): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-task-action",
      handlers: {
        "bot.task.runNow": (params) => {
          sent.runNow.push(params);
          return Promise.reject(refusal("bot.task.runNow"));
        },
        "bot.task.setPaused": (params) => {
          sent.setPaused.push(params);
          return Promise.reject(refusal("bot.task.setPaused"));
        },
        "bot.task.stop": (params) => {
          sent.stop.push(params);
          return Promise.reject(refusal("bot.task.stop"));
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

type PresserProps = {
  readonly client: HostClient<HostRpcRegistry>;
  readonly ready: (press: () => void) => void;
};

function RunNowPresser(props: PresserProps): ReactNode {
  const run = useBotTaskRunNowMutation(props.client);
  const { ready } = props;
  useEffect(
    () => ready(() => run.mutate({ botId: BOT_ID, taskId: TASK_ID })),
    [ready, run],
  );
  return null;
}

function PausePresser(
  props: PresserProps & { readonly paused: boolean },
): ReactNode {
  const pause = useBotTaskSetPausedMutation(props.client);
  const { ready, paused } = props;
  useEffect(
    () => ready(() => pause.mutate({ botId: BOT_ID, taskId: TASK_ID, paused })),
    [ready, pause, paused],
  );
  return null;
}

function StopPresser(props: PresserProps): ReactNode {
  const stop = useBotTaskStopMutation(props.client);
  const { ready } = props;
  useEffect(
    () => ready(() => stop.mutate({ botId: BOT_ID, taskId: TASK_ID })),
    [ready, stop],
  );
  return null;
}

type Press = {
  readonly action: string;
  readonly shown: string;
  readonly presser: (props: PresserProps) => ReactNode;
  readonly sentIs: (sent: Sent) => void;
};

const PRESSES: ReadonlyArray<Press> = [
  {
    action: "Check in now",
    shown: "Couldn't check in.",
    presser: (props) => <RunNowPresser {...props} />,
    sentIs: (sent) =>
      expect(sent.runNow).toEqual([{ botId: BOT_ID, taskId: TASK_ID }]),
  },
  {
    action: "Pause reports",
    shown: "Couldn't pause reports.",
    presser: (props) => <PausePresser {...props} paused />,
    sentIs: (sent) =>
      expect(sent.setPaused).toEqual([
        { botId: BOT_ID, taskId: TASK_ID, paused: true },
      ]),
  },
  {
    action: "Resume reports",
    shown: "Couldn't resume reports.",
    presser: (props) => <PausePresser {...props} paused={false} />,
    sentIs: (sent) =>
      expect(sent.setPaused).toEqual([
        { botId: BOT_ID, taskId: TASK_ID, paused: false },
      ]),
  },
  {
    action: "End reporting",
    shown: "Couldn't end reporting.",
    presser: (props) => <StopPresser {...props} />,
    sentIs: (sent) =>
      expect(sent.stop).toEqual([{ botId: BOT_ID, taskId: TASK_ID }]),
  },
];

afterEach(() => {
  toast.dismiss();
  cleanup();
});

describe("a refused reporting action's toast, as the person sees it", () => {
  it.each(PRESSES)(
    "says $shown for $action, after the one request the action sends",
    async ({ shown, presser, sentIs }) => {
      const queryClient = createAppQueryClient();
      const sent: Sent = { runNow: [], setPaused: [], stop: [] };
      const client = buildClient(queryClient, sent);
      const handle: { press: (() => void) | null } = { press: null };
      render(
        <QueryClientProvider client={queryClient}>
          <Toaster />
          {presser({
            client,
            ready: (press) => {
              handle.press = press;
            },
          })}
        </QueryClientProvider>,
      );
      const press = handle.press;
      if (press === null) throw new Error("the action was not set up");

      act(() => press());

      await waitFor(() =>
        expect(document.querySelector("[data-sonner-toast]")).not.toBeNull(),
      );
      sentIs(sent);
      expect(
        document.querySelector("[data-sonner-toast]")?.textContent,
      ).toContain(shown);
    },
  );
});
