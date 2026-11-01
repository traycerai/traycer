/**
 * A team's setup channel re-reads `bot.onboarding.read` on the shared
 * on-screen cadence while it is on screen and the setup still needs a host:
 * the team's host creating the bot rings the team's room,
 * which reaches a member's bot list only while their host listens to that
 * room, so this read is the backstop for a missed ring. Through the real
 * query client, `HostClient` and policy table; only the host's answer is
 * scripted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  BotOnboardingReadResponse,
  BotOnboardingSetup,
} from "@traycer/protocol/host/bot/onboarding-schemas";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createAppQueryClient } from "@/lib/query-client";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { TeamSetupChannel } from "@/components/bots/team-setup-channel";
import { useInstalledAppLevel2Form } from "@/hooks/ui/use-installed-app-level2-form";
import {
  installShellForm,
  SHELL_WIDTH_COLUMN_256,
  SHELL_WIDTH_MENU,
} from "../../../../__tests__/mobile-level2-form-harness";

// The channel list beside the post reads every bot and team on its own; it
// is not what this file is about.
vi.mock("@/components/bots/bot-channel-sidebar", () => ({
  BotChannelSidebar: () => null,
}));
// Nor is Enable cloud's read of the team's sandbox defaults, which goes
// through the app's host runtime.
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", () => ({
  useSandboxDefaults: () => new Map(),
}));

const MAIN_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAX";
/** `ON_SCREEN_FIXED_POLL`'s interval. */
const ON_SCREEN_INTERVAL_MS = 10_000;

function readWith(setup: BotOnboardingSetup): BotOnboardingReadResponse {
  return {
    github: {
      state: "ok",
      installingAdmin: null,
      repositories: [],
      callerCanConnect: true,
    },
    unlocked: false,
    choice: null,
    catalog: [],
    setup,
  };
}

type Rig = {
  readonly reads: () => number;
  readonly goLive: () => void;
  readonly mount: (visible: boolean) => {
    readonly unmount: () => void;
    readonly setVisible: (visible: boolean) => void;
  };
};

function rig(): Rig {
  const queryClient = createAppQueryClient();
  let setup: BotOnboardingSetup = {
    botId: MAIN_BOT_ID,
    title: "Tracy",
    state: "needs_host",
    arrival: null,
  };
  let reads = 0;
  let requestCounter = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestCounter += 1;
        return `req-${String(requestCounter)}`;
      },
      handlers: {
        "bot.onboarding.read": () => {
          reads += 1;
          return readWith(setup);
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const channel = (visible: boolean): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <PaneVisibilityContext value={visible}>
        <SetupWithLevel2Form client={client} />
      </PaneVisibilityContext>
    </QueryClientProvider>
  );
  return {
    reads: () => reads,
    goLive: () => {
      setup = { ...setup, state: "live", arrival: { kind: "cloud" } };
    },
    mount: (visible) => {
      const view = render(channel(visible));
      return {
        unmount: view.unmount,
        setVisible: (next) => {
          view.rerender(channel(next));
        },
      };
    },
  };
}

/** Lets the interval fire and the read it starts answer. */
async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetNegotiatedManifests();
});

describe("TeamSetupChannel on-screen poll", () => {
  it("re-reads the setup on the on-screen cadence while it needs a host, and stops once it is live", async () => {
    const harness = rig();
    harness.mount(true);
    expect(screen.getByTestId("team-setup-channel")).toBeTruthy();
    await elapse(0);
    expect(harness.reads()).toBe(1);

    await elapse(ON_SCREEN_INTERVAL_MS);
    expect(harness.reads()).toBe(2);

    // The team's host created the bot; no bell reaches this host.
    harness.goLive();
    await elapse(ON_SCREEN_INTERVAL_MS);
    expect(harness.reads()).toBe(3);

    await elapse(ON_SCREEN_INTERVAL_MS * 3);
    expect(harness.reads()).toBe(3);
  });

  it("stops when the channel is unmounted", async () => {
    const harness = rig();
    const view = harness.mount(true);
    await elapse(0);
    expect(harness.reads()).toBe(1);

    view.unmount();
    await elapse(ON_SCREEN_INTERVAL_MS * 3);
    expect(harness.reads()).toBe(1);
  });

  it("does not poll while its pane is hidden, and resumes when it is shown", async () => {
    const harness = rig();
    const view = harness.mount(false);
    await elapse(0);
    expect(harness.reads()).toBe(1);

    await elapse(ON_SCREEN_INTERVAL_MS * 3);
    expect(harness.reads()).toBe(1);

    view.setVisible(true);
    await elapse(ON_SCREEN_INTERVAL_MS);
    expect(harness.reads()).toBe(2);
  });
});

describe("TeamSetupChannel level 2 in the installed app", () => {
  // The column is the Tracy surface's, beside this pane; the pane's title is
  // the picker where the surface draws none.
  it("names the bot as a plain title beside the column at 256, and as a picker without one", () => {
    const shell = installShellForm(SHELL_WIDTH_COLUMN_256);
    try {
      rig().mount(true);
      expect(screen.getByTestId("bot-tab-title").textContent).toBe("Tracy");
      expect(screen.queryByTestId("bot-channel-picker-trigger")).toBeNull();

      shell.set({ width: SHELL_WIDTH_MENU, portrait: false });
      expect(screen.getByTestId("bot-channel-picker-trigger").textContent).toBe(
        "Tracy",
      );
    } finally {
      shell.dispose();
    }
  });
});

/** The setup pane with the form the surface would hand it. */
function SetupWithLevel2Form(props: {
  readonly client: HostClient<HostRpcRegistry>;
}): ReactNode {
  const level2 = useInstalledAppLevel2Form(1);
  return (
    <TeamSetupChannel
      setup={{
        environmentId: "env-team",
        teamName: "Acme",
        botId: MAIN_BOT_ID,
        title: "Tracy",
      }}
      client={props.client}
      hostId={mockLocalHostEntry.hostId}
      level2={level2}
    />
  );
}
