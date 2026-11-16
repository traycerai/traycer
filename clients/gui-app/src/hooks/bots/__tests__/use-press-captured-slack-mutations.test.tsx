import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SlackAppDmsRequest,
  SlackAppRegisterRequest,
  SlackAppView,
} from "@traycer/protocol/host/slack-app";
import type {
  SlackAppInstallUrlResult,
  SlackAppWriteResult,
} from "@traycer-clients/shared/host-client/slack-app";
import {
  useBotSlackDisconnectMutation,
  useBotSlackDmsMutation,
  useBotSlackInstallUrlMutation,
  useBotSlackRegisterMutation,
} from "@/hooks/bots/use-bot-slack-mutations";

interface PressTestAuth {
  getIdentityGeneration(): number;
  isIdentityCurrent(generation: number): boolean;
  registerSlackApp(request: SlackAppRegisterRequest): Promise<SlackAppWriteResult>;
  mintSlackAppInstallUrl(botId: string): Promise<SlackAppInstallUrlResult>;
  disconnectSlackApp(botId: string): Promise<SlackAppWriteResult>;
  setSlackAppDms(request: SlackAppDmsRequest): Promise<SlackAppWriteResult>;
}

const binding = vi.hoisted((): { current: { auth: PressTestAuth } | null } => ({
  current: null,
}));

vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostBinding: () => binding.current,
}));

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const APP: SlackAppView = {
  botId: BOT_ID,
  appId: "app-test",
  clientId: "123.456",
  installState: "registered",
  teamId: null,
  teamName: null,
  botUserId: null,
  installedAt: null,
  dmsEnabled: true,
};
const REGISTER_REQUEST: SlackAppRegisterRequest = {
  botId: BOT_ID,
  appId: APP.appId,
  clientId: APP.clientId,
  clientSecret: "synthetic-client-secret",
  signingSecret: "synthetic-signing-secret",
};

let generation = { value: 1 };
let dispatches: string[] = [];

afterEach(() => {
  cleanup();
  binding.current = null;
  generation = { value: 1 };
  dispatches = [];
});

function pressTestAuth(): PressTestAuth {
  return {
    getIdentityGeneration: () => generation.value,
    isIdentityCurrent: (pressedAt) => pressedAt === generation.value,
    registerSlackApp: () => {
      dispatches.push("register");
      return Promise.resolve<SlackAppWriteResult>({ kind: "ok", app: APP });
    },
    mintSlackAppInstallUrl: () => {
      dispatches.push("install-url");
      return Promise.resolve<SlackAppInstallUrlResult>({
        kind: "ok",
        url: "https://slack.example.test/install",
        expiresAt: 1_800_000_000_000,
      });
    },
    disconnectSlackApp: () => {
      dispatches.push("disconnect");
      return Promise.resolve<SlackAppWriteResult>({ kind: "ok", app: APP });
    },
    setSlackAppDms: (request) => {
      dispatches.push(request.dmsEnabled ? "dms-on" : "dms-off");
      return Promise.resolve<SlackAppWriteResult>({ kind: "ok", app: APP });
    },
  };
}

function renderWithQueryClient<T>(
  hook: () => T,
): { readonly result: { readonly current: T } } {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return renderHook(hook, { wrapper });
}

describe("the press-captured Slack mutations", () => {
  it("does not register Slack after the pressed sign-in ends", async () => {
    binding.current = { auth: pressTestAuth() };
    const { result } = renderWithQueryClient(() =>
      useBotSlackRegisterMutation(BOT_ID),
    );

    await act(async () => {
      await expect(
        result.current.mutateAsync(REGISTER_REQUEST),
      ).resolves.toEqual(APP);
    });
    expect(dispatches).toEqual(["register"]);

    await act(async () => {
      const pending = result.current.mutateAsync(REGISTER_REQUEST);
      generation.value += 1;
      await expect(pending).resolves.toBeNull();
    });
    expect(dispatches).toEqual(["register"]);
  });

  it("does not mint a Slack install URL after the pressed sign-in ends", async () => {
    binding.current = { auth: pressTestAuth() };
    const { result } = renderWithQueryClient(() =>
      useBotSlackInstallUrlMutation(BOT_ID),
    );
    const variables = { baselineInstalledAt: null };

    await act(async () => {
      await expect(result.current.mutateAsync(variables)).resolves.toMatchObject({
        url: "https://slack.example.test/install",
      });
    });
    expect(dispatches).toEqual(["install-url"]);

    await act(async () => {
      const pending = result.current.mutateAsync(variables);
      generation.value += 1;
      await expect(pending).resolves.toBeNull();
    });
    expect(dispatches).toEqual(["install-url"]);
  });

  it("does not disconnect Slack after the pressed sign-in ends", async () => {
    binding.current = { auth: pressTestAuth() };
    const { result } = renderWithQueryClient(() =>
      useBotSlackDisconnectMutation(BOT_ID),
    );

    await act(async () => {
      await expect(result.current.mutateAsync()).resolves.toEqual(APP);
    });
    expect(dispatches).toEqual(["disconnect"]);

    await act(async () => {
      const pending = result.current.mutateAsync();
      generation.value += 1;
      await expect(pending).resolves.toBeNull();
    });
    expect(dispatches).toEqual(["disconnect"]);
  });

  it("does not change the Slack DM setting after the pressed sign-in ends", async () => {
    binding.current = { auth: pressTestAuth() };
    const { result } = renderWithQueryClient(() =>
      useBotSlackDmsMutation(BOT_ID),
    );

    await act(async () => {
      await expect(result.current.mutateAsync(false)).resolves.toEqual(APP);
    });
    expect(dispatches).toEqual(["dms-off"]);

    await act(async () => {
      const pending = result.current.mutateAsync(true);
      generation.value += 1;
      await expect(pending).resolves.toBeNull();
    });
    expect(dispatches).toEqual(["dms-off"]);
  });
});
