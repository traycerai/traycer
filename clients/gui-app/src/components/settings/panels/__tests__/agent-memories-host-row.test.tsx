// The host that answers, the method support probe and the analytics call are
// the boundary. Everything between the switch and the wire runs for real: the
// query, the mutation, the cache, the poll table's cadence and the row's own
// derivation of where the write stands.
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-local",
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
vi.mock("@/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics")>()),
  trackSettingChanged: () => undefined,
}));

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ConfigAgentMemoriesResponse,
  ConfigAgentMemoriesSetResponse,
} from "@traycer/protocol/host/config/schemas";
import type {
  EnvironmentStatusResponseV20,
  EnvironmentUploadReceipt,
} from "@traycer/protocol/host/environment-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import {
  mountTeamPage,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { hostQueryKeys } from "@/lib/query-keys";
import { useRereadHostReadsOnFocus } from "@/hooks/environment/use-reread-host-reads-on-focus";
import { AgentMemoriesSettingsPanel } from "@/components/settings/panels/agent-memories-settings-panel";
import { AGENT_MEMORY_CONFIRM_BOUND_MS } from "@/components/settings/panels/agent-memories-settings-panel";
import {
  environmentStatusFixture,
  pendingUploadFixture,
} from "@/lib/environment/__tests__/environment-test-support";

const ENV = "env-a";
const OTHER_ENV = "env-b";
const UPLOAD = "upload-memory";

/** The getter's answer as the host builds it: one snapshot, three fields. */
function read(
  enabled: boolean,
  revision: number | null,
): ConfigAgentMemoriesResponse {
  return { enabled, revision, environmentId: ENV };
}

/** The same read, answered for a configuration this host has moved to. */
function readIn(
  environmentId: string,
  enabled: boolean,
  revision: number | null,
): ConfigAgentMemoriesResponse {
  return { enabled, revision, environmentId };
}

function savedAnswer(input: {
  readonly enabled: boolean;
  readonly revision: number | null;
}): ConfigAgentMemoriesSetResponse {
  return {
    enabled: input.enabled,
    state: "saved",
    revision: input.revision,
    environmentId: ENV,
    uploadId: null,
  };
}

function queuedAnswer(uploadId: string | null): ConfigAgentMemoriesSetResponse {
  return {
    enabled: false,
    state: "queued",
    revision: null,
    environmentId: ENV,
    uploadId,
  };
}

function receipt(
  overrides: Partial<EnvironmentUploadReceipt>,
): EnvironmentUploadReceipt {
  return {
    uploadId: UPLOAD,
    kind: "agent_memory",
    key: "memory",
    os: "any",
    environmentId: ENV,
    revision: 7,
    acceptedAt: 1,
    ...overrides,
  };
}

/**
 * The reads the host answers, in order: each call takes the next entry and
 * the last one repeats, which is how a projection arriving between polls is
 * expressed without a timer in the fixture.
 */
const script: {
  reads: ConfigAgentMemoriesResponse[];
  get: (() => Promise<ConfigAgentMemoriesResponse>) | null;
  statuses: EnvironmentStatusResponseV20[];
  status: (() => Promise<EnvironmentStatusResponseV20>) | null;
  set: (request: {
    readonly enabled: boolean;
  }) =>
    | ConfigAgentMemoriesSetResponse
    | Promise<ConfigAgentMemoriesSetResponse>;
} = {
  reads: [read(false, 5)],
  get: null,
  statuses: [environmentStatusFixture({})],
  status: null,
  set: () => savedAnswer({ enabled: true, revision: 6 }),
};

function nextOf<T>(queue: T[]): T {
  const head = queue.length > 1 ? queue.shift() : queue[0];
  if (head === undefined) throw new Error("the script ran out of answers");
  return head;
}

function handlers(): MockHandlerMap<HostRpcRegistry> {
  return {
    "config.agentMemories.get": () =>
      script.get ? script.get() : nextOf(script.reads),
    "config.agentMemories.set": (request) => script.set(request),
    "environment.status": () =>
      script.status ? script.status() : nextOf(script.statuses),
  };
}

function PersonalRevision() {
  const client = requireTeamHostClient();
  const status = useEnvironmentStatusRead(
    client,
    client.getActiveHostId(),
    true,
  );
  return <p data-testid="personal-revision">{status.data?.receivedRevision}</p>;
}

function mount(): TeamPageHarness {
  const harness = mountTeamPage({ kind: "host" }, handlers());
  render(<AgentMemoriesSettingsPanel />, { wrapper: harness.Wrapper });
  return harness;
}

/** The row's status line; request failures use the shared host notice. */
async function line(): Promise<string> {
  const row = await screen.findByText("Use Traycer memories for agents");
  const text = row.closest("div")?.parentElement?.textContent ?? null;
  if (text === null) throw new Error("no row text");
  return text;
}

async function flipOn(): Promise<void> {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const toggle = await screen.findByRole("switch", {
    name: "Use Traycer memories for agents",
  });
  // Enabled once the row's first read has answered, which is when a click can
  // mean anything.
  await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
  await user.click(toggle);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(toast, "error");
  vi.spyOn(toast, "info");
  script.reads = [read(false, 5)];
  script.get = null;
  script.status = null;
  script.statuses = [environmentStatusFixture({})];
  script.set = () => savedAnswer({ enabled: true, revision: 6 });
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  toast.dismiss();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Agent memories ▸ the host row's write", () => {
  it.each(["settled", "held initial"] as const)(
    "refreshes the Personal switch when a revision overtakes a %s GET",
    async (initialRead) => {
      let releaseInitial: (value: ConfigAgentMemoriesResponse) => void = () => {
        throw new Error("initial GET has not started");
      };
      if (initialRead === "held initial") {
        let first = true;
        script.get = () => {
          if (!first) return Promise.resolve(read(true, 6));
          first = false;
          return new Promise((resolve) => {
            releaseInitial = resolve;
          });
        };
      }
      script.statuses = [
        environmentStatusFixture({
          principal: { kind: "personal" },
          receivedRevision: 5,
          appliedRevision: 5,
        }),
      ];
      const harness = mountTeamPage(
        { kind: "host" },
        {
          ...handlers(),
          "environment.list": () => ({
            environments: [
              {
                environmentId: ENV,
                ownerKind: "user",
                ownerId: "user-me",
                roomId: "room-personal",
                label: "Personal",
                effectiveRole: "owner",
                kind: "personal",
                hostCount: 1,
                providerHandle: null,
              },
            ],
          }),
        },
      );
      harness.queryClient.setDefaultOptions({
        queries: {
          retry: false,
          staleTime: 60_000,
          gcTime: 300_000,
        },
      });
      render(
        <>
          <PersonalRevision />
          <AgentMemoriesSettingsPanel />
        </>,
        { wrapper: harness.Wrapper },
      );
      await waitFor(() => {
        expect(screen.getByTestId("personal-revision").textContent).toBe("5");
        if (initialRead === "settled") {
          expect(
            screen
              .getByRole("switch", { name: "Use Traycer memories for agents" })
              .getAttribute("aria-checked"),
          ).toBe("false");
        }
        expect(harness.paramsOf("environment.list")).toHaveLength(1);
        expect(harness.paramsOf("config.agentMemories.get")).toHaveLength(1);
      });
      script.reads = [read(true, 6)];
      script.statuses = [
        environmentStatusFixture({
          principal: { kind: "personal" },
          receivedRevision: 6,
          appliedRevision: 6,
        }),
      ];
      await act(async () => {
        await harness.queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            requireTeamHostClient().getActiveHostId(),
            "environment.status",
          ),
        });
      });
      await waitFor(() =>
        expect(screen.getByTestId("personal-revision").textContent).toBe("6"),
      );
      if (initialRead === "held initial") {
        act(() => {
          releaseInitial(read(false, 5));
        });
      }
      await waitFor(() =>
        expect(
          screen
            .getByRole("switch", {
              name: "Use Traycer memories for agents",
            })
            .getAttribute("aria-checked"),
        ).toBe("true"),
      );
      expect(harness.paramsOf("config.agentMemories.set")).toHaveLength(0);
    },
  );

  it("rejects retained confirmation data when a Personal revision cancels the populated post-status read", async () => {
    let reads = 0;
    let releasePostStatus: (
      value: ConfigAgentMemoriesResponse,
    ) => void = () => {
      throw new Error("post-status read has not started");
    };
    script.get = () => {
      reads += 1;
      if (reads === 1) return Promise.resolve(read(false, 5));
      if (reads === 2) return Promise.resolve(read(true, 9));
      if (reads === 3)
        return new Promise((resolve) => {
          releasePostStatus = resolve;
        });
      // Keep the canonical reread unavailable: it cannot supply confirmation.
      if (reads === 4) return new Promise(() => undefined);
      return Promise.resolve(read(false, 10));
    };
    script.set = () => queuedAnswer(UPLOAD);
    script.statuses = [
      environmentStatusFixture({
        principal: { kind: "personal" },
        receivedRevision: 5,
        appliedRevision: 5,
        acceptedUploads: [receipt({ revision: 7 })],
      }),
    ];
    const harness = mountTeamPage(
      { kind: "host" },
      {
        ...handlers(),
        "environment.list": () => ({
          environments: [
            {
              environmentId: ENV,
              ownerKind: "user",
              ownerId: "user-me",
              roomId: "room-personal",
              label: "Personal",
              effectiveRole: "owner",
              kind: "personal",
              hostCount: 1,
              providerHandle: null,
            },
          ],
        }),
      },
    );
    harness.queryClient.setDefaultOptions({
      queries: {
        retry: false,
        staleTime: 60_000,
        gcTime: 300_000,
      },
    });
    render(
      <>
        <PersonalRevision />
        <AgentMemoriesSettingsPanel />
      </>,
      { wrapper: harness.Wrapper },
    );
    await waitFor(() =>
      expect(screen.getByTestId("personal-revision").textContent).toBe("5"),
    );
    await flipOn();
    await waitFor(() => expect(reads).toBe(3));
    script.statuses = [
      environmentStatusFixture({
        principal: { kind: "personal" },
        receivedRevision: 10,
        appliedRevision: 10,
        acceptedUploads: [receipt({ revision: 7 })],
      }),
    ];
    await act(async () => {
      await harness.queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope(
          requireTeamHostClient().getActiveHostId(),
          "environment.status",
        ),
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("personal-revision").textContent).toBe("10");
      expect(reads).toBe(4);
    });
    expect(await line()).toContain("Waiting to reach your configuration");
    expect(
      screen
        .getByRole("switch", { name: "Use Traycer memories for agents" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    act(() => releasePostStatus(read(false, 10)));
  });

  it.each(["applied", "saved", "queued"] as const)(
    "keeps the confirmed %s read when Settings reopens inside cache freshness",
    async (state) => {
      script.set = () =>
        state === "queued"
          ? queuedAnswer(UPLOAD)
          : {
              ...savedAnswer({ enabled: true, revision: 6 }),
              state,
            };
      script.reads = [read(false, 5), read(true, 6)];
      script.statuses = [
        environmentStatusFixture({
          acceptedUploads: [receipt({ revision: 6 })],
        }),
      ];
      const harness = mountTeamPage({ kind: "host" }, handlers());
      // Match production freshness and keep the entry across page navigation.
      harness.queryClient.setDefaultOptions({
        queries: { retry: false, staleTime: 60_000, gcTime: 300_000 },
        mutations: { retry: false },
      });
      const view = render(<AgentMemoriesSettingsPanel />, {
        wrapper: harness.Wrapper,
      });
      await flipOn();
      await waitFor(() =>
        expect(
          screen
            .getByRole("switch", {
              name: "Use Traycer memories for agents",
            })
            .getAttribute("aria-checked"),
        ).toBe("true"),
      );
      await waitFor(async () =>
        expect(await line()).toContain("Running agents pick this up"),
      );
      const confirmedReads = harness.paramsOf(
        "config.agentMemories.get",
      ).length;
      view.rerender(null);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      view.rerender(<AgentMemoriesSettingsPanel />);
      await waitFor(() =>
        expect(
          screen
            .getByRole("switch", {
              name: "Use Traycer memories for agents",
            })
            .getAttribute("aria-checked"),
        ).toBe("true"),
      );
      expect(harness.paramsOf("config.agentMemories.get").length).toBe(
        confirmedReads,
      );
    },
  );

  it("refetches on reopening after focus rereads an unconfirmed write", async () => {
    function FocusReader(): null {
      useRereadHostReadsOnFocus(requireTeamHostClient().getActiveHostId());
      return null;
    }
    const harness = mountTeamPage({ kind: "host" }, handlers());
    harness.queryClient.setDefaultOptions({
      queries: { retry: false, staleTime: 60_000, gcTime: 300_000 },
      mutations: { retry: false },
    });
    const content = (
      <>
        <FocusReader />
        <AgentMemoriesSettingsPanel />
      </>
    );
    const view = render(content, { wrapper: harness.Wrapper });
    await screen.findByRole("switch", {
      name: "Use Traycer memories for agents",
    });
    await flipOn();
    await waitFor(async () =>
      expect(await line()).toContain("This host hasn't picked it up yet"),
    );
    await waitFor(() =>
      expect(
        harness.paramsOf("config.agentMemories.get").length,
      ).toBeGreaterThan(1),
    );
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    const beforeFocus = harness.paramsOf("config.agentMemories.get").length;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(
        harness.paramsOf("config.agentMemories.get").length,
      ).toBeGreaterThan(beforeFocus),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Use Traycer memories for agents" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    view.rerender(null);
    script.reads = [read(true, 6)];
    const reads = harness.paramsOf("config.agentMemories.get").length;
    view.rerender(content);
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Use Traycer memories for agents" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(harness.paramsOf("config.agentMemories.get").length).toBeGreaterThan(
      reads,
    );
  });

  it("refetches an unconfirmed write when reopening inside cache freshness", async () => {
    const harness = mountTeamPage({ kind: "host" }, handlers());
    harness.queryClient.setDefaultOptions({
      queries: { retry: false, staleTime: 60_000, gcTime: 300_000 },
      mutations: { retry: false },
    });
    const view = render(<AgentMemoriesSettingsPanel />, {
      wrapper: harness.Wrapper,
    });
    await flipOn();
    await waitFor(async () =>
      expect(await line()).toContain("This host hasn't picked it up yet"),
    );
    const waitingReads = harness.paramsOf("config.agentMemories.get").length;
    view.rerender(null);
    script.reads = [read(true, 6)];
    view.rerender(<AgentMemoriesSettingsPanel />);
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", {
            name: "Use Traycer memories for agents",
          })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(harness.paramsOf("config.agentMemories.get").length).toBe(
      waitingReads + 1,
    );
  });

  it.each([
    { name: "newer revision", next: read(false, 7) },
    { name: "new environment", next: readIn(OTHER_ENV, false, 7) },
  ])(
    "keeps a GET received before a held setter reply: $name",
    async ({ next }) => {
      let release: (value: ConfigAgentMemoriesSetResponse) => void = () => {
        throw new Error("setter was not started");
      };
      script.set = () =>
        new Promise((resolve) => {
          release = resolve;
        });
      const harness = mountTeamPage({ kind: "host" }, handlers());
      harness.queryClient.setDefaultOptions({
        queries: { retry: false, staleTime: 60_000, gcTime: 300_000 },
        mutations: { retry: false },
      });
      const view = render(<AgentMemoriesSettingsPanel />, {
        wrapper: harness.Wrapper,
      });
      await flipOn();
      await waitFor(() =>
        expect(harness.paramsOf("config.agentMemories.set")).toHaveLength(1),
      );
      script.reads = [next];
      await act(async () => {
        await harness.queryClient.refetchQueries({ type: "active" });
      });
      act(() => {
        release({
          enabled: true,
          state: "applied",
          revision: 6,
          environmentId: ENV,
          uploadId: null,
        });
      });
      await waitFor(() =>
        expect(
          screen
            .getByRole("switch", { name: "Use Traycer memories for agents" })
            .getAttribute("aria-checked"),
        ).toBe("false"),
      );
      view.rerender(null);
      view.rerender(<AgentMemoriesSettingsPanel />);
      await waitFor(() =>
        expect(
          screen
            .getByRole("switch", { name: "Use Traycer memories for agents" })
            .getAttribute("aria-checked"),
        ).toBe("false"),
      );
    },
  );

  it("publishes confirmed evidence newer than an intervening canonical read", async () => {
    let release: (value: ConfigAgentMemoriesSetResponse) => void = () => {
      throw new Error("setter was not started");
    };
    script.set = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const harness = mountTeamPage({ kind: "host" }, handlers());
    harness.queryClient.setDefaultOptions({
      queries: { retry: false, staleTime: 60_000, gcTime: 300_000 },
      mutations: { retry: false },
    });
    const view = render(<AgentMemoriesSettingsPanel />, {
      wrapper: harness.Wrapper,
    });
    await flipOn();
    await waitFor(() =>
      expect(harness.paramsOf("config.agentMemories.set")).toHaveLength(1),
    );
    script.reads = [read(false, 6)];
    await act(async () => {
      await harness.queryClient.refetchQueries({ type: "active" });
    });
    act(() => {
      release({
        enabled: true,
        state: "applied",
        revision: 7,
        environmentId: ENV,
        uploadId: null,
      });
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Use Traycer memories for agents" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    view.rerender(null);
    view.rerender(<AgentMemoriesSettingsPanel />);
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Use Traycer memories for agents" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  it("withholds confirmation dispatch while requester authority is unavailable", async () => {
    const harness = mountTeamPage({ kind: "host" }, handlers());
    render(<AgentMemoriesSettingsPanel />, { wrapper: harness.Wrapper });
    await flipOn();
    await waitFor(async () =>
      expect(await line()).toContain("This host hasn't picked it up yet"),
    );
    await waitFor(() =>
      expect(harness.paramsOf("config.agentMemories.get")).toHaveLength(2),
    );
    const authority = vi
      .spyOn(requireTeamHostClient(), "getRequestContextUserId")
      .mockReturnValue(null);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(harness.paramsOf("config.agentMemories.get")).toHaveLength(2);
    authority.mockRestore();
    script.reads = [read(true, 6)];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Use Traycer memories for agents" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  it("keeps an applied write when an older GET arrives afterward", async () => {
    let release: (value: ConfigAgentMemoriesResponse) => void = () => {
      throw new Error("getter was not started");
    };
    const harness = mountTeamPage({ kind: "host" }, handlers());
    harness.queryClient.setDefaultOptions({
      queries: { retry: false, staleTime: 60_000, gcTime: 300_000 },
      mutations: { retry: false },
    });
    const view = render(<AgentMemoriesSettingsPanel />, {
      wrapper: harness.Wrapper,
    });
    await screen.findByRole("switch", {
      name: "Use Traycer memories for agents",
    });
    script.get = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    let refetch: Promise<void> = Promise.resolve();
    act(() => {
      refetch = harness.queryClient.refetchQueries({ type: "active" });
    });
    await waitFor(() =>
      expect(harness.paramsOf("config.agentMemories.get")).toHaveLength(2),
    );
    script.set = () => ({
      enabled: true,
      state: "applied",
      revision: 6,
      environmentId: ENV,
      uploadId: null,
    });
    await flipOn();
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Use Traycer memories for agents" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    await act(async () => {
      release(read(false, 5));
      await refetch;
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Use Traycer memories for agents" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    view.rerender(null);
    view.rerender(<AgentMemoriesSettingsPanel />);
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Use Traycer memories for agents" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  it("refetches on reopening when an older GET outlives a lost setter response", async () => {
    let release: (value: ConfigAgentMemoriesResponse) => void = () => {
      throw new Error("getter was not started");
    };
    const harness = mountTeamPage({ kind: "host" }, handlers());
    harness.queryClient.setDefaultOptions({
      queries: { retry: false, staleTime: 60_000, gcTime: 300_000 },
      mutations: { retry: false },
    });
    const view = render(<AgentMemoriesSettingsPanel />, {
      wrapper: harness.Wrapper,
    });
    await waitFor(() =>
      expect(harness.paramsOf("config.agentMemories.get")).toHaveLength(1),
    );
    script.get = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    let refetch: Promise<void> = Promise.resolve();
    act(() => {
      refetch = harness.queryClient.refetchQueries({ type: "active" });
    });
    await waitFor(() =>
      expect(harness.paramsOf("config.agentMemories.get")).toHaveLength(2),
    );
    script.set = () => {
      script.reads = [read(true, 6)];
      throw new Error("response lost");
    };
    await flipOn();
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    script.get = null;
    await act(async () => {
      release(read(false, 5));
      await refetch;
    });
    const reads = harness.paramsOf("config.agentMemories.get").length;
    view.rerender(null);
    view.rerender(<AgentMemoriesSettingsPanel />);
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Use Traycer memories for agents" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(harness.paramsOf("config.agentMemories.get").length).toBeGreaterThan(
      reads,
    );
  });

  it("refetches after a committed setter loses its response", async () => {
    script.set = () => {
      script.reads = [read(true, 6)];
      throw new Error("response lost");
    };
    const harness = mountTeamPage({ kind: "host" }, handlers());
    harness.queryClient.setDefaultOptions({
      queries: { retry: false, staleTime: 60_000, gcTime: 300_000 },
      mutations: { retry: false },
    });
    const view = render(<AgentMemoriesSettingsPanel />, {
      wrapper: harness.Wrapper,
    });
    await flipOn();
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    const reads = harness.paramsOf("config.agentMemories.get").length;
    view.rerender(null);
    view.rerender(<AgentMemoriesSettingsPanel />);
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Use Traycer memories for agents" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(harness.paramsOf("config.agentMemories.get").length).toBeGreaterThan(
      reads,
    );
  });

  it.each([
    { name: "later writer", next: read(false, 7) },
    { name: "same-host environment change", next: readIn(OTHER_ENV, false, 2) },
  ])(
    "shows a real query refetch after terminal application: $name",
    async ({ next }) => {
      script.set = () => ({
        enabled: true,
        state: "applied",
        revision: 6,
        environmentId: ENV,
        uploadId: null,
      });
      const harness = mount();
      await flipOn();
      const toggle = screen.getByRole("switch", {
        name: "Use Traycer memories for agents",
      });
      await waitFor(() =>
        expect(toggle.getAttribute("aria-checked")).toBe("true"),
      );
      script.reads = [next];
      await act(async () => {
        await harness.queryClient.refetchQueries({ type: "active" });
      });
      await waitFor(() =>
        expect(toggle.getAttribute("aria-checked")).toBe("false"),
      );
    },
  );

  it("retires an active observation when a new client serves the same host", async () => {
    let resolveStatus: (value: EnvironmentStatusResponseV20) => void = () => {
      throw new Error("status was not started");
    };
    script.set = () => queuedAnswer(UPLOAD);
    script.status = () =>
      new Promise((resolve) => {
        resolveStatus = resolve;
      });
    const original = mountTeamPage({ kind: "host" }, handlers());
    const view = render(<AgentMemoriesSettingsPanel />, {
      wrapper: original.Wrapper,
    });
    const oldClient = requireTeamHostClient();
    await flipOn();
    await waitFor(() =>
      expect(original.paramsOf("environment.status").length).toBe(1),
    );
    expect(await line()).toContain("Waiting to reach your configuration");

    // Replace only the requester, preserving the host, mounted row and QueryClient.
    const replacement = mountTeamPage({ kind: "host" }, handlers());
    expect(requireTeamHostClient()).not.toBe(oldClient);
    expect(requireTeamHostClient().getActiveHostId()).toBe(
      oldClient.getActiveHostId(),
    );
    view.rerender(<AgentMemoriesSettingsPanel />);
    script.reads = [read(true, 7)];
    await act(async () => {
      await original.queryClient.refetchQueries({ type: "active" });
    });
    const toggle = screen.getByRole("switch", {
      name: "Use Traycer memories for agents",
    });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    expect(await line()).toContain("Running agents pick this up");

    // A response from the abandoned observer cannot restore its queued state.
    act(() => {
      resolveStatus(
        environmentStatusFixture({
          acceptedUploads: [receipt({ revision: null })],
        }),
      );
    });
    script.reads = [readIn(OTHER_ENV, false, 2)];
    await act(async () => {
      await original.queryClient.refetchQueries({ type: "active" });
    });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
    const oldReads = original.paramsOf("config.agentMemories.get").length;
    const newReads = replacement.paramsOf("config.agentMemories.get").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_MEMORY_CONFIRM_BOUND_MS + 10_000);
    });
    expect(await line()).toContain("Running agents pick this up");
    expect(original.paramsOf("config.agentMemories.get").length).toBe(oldReads);
    expect(original.paramsOf("environment.status").length).toBe(1);
    expect(replacement.paramsOf("config.agentMemories.get").length).toBe(
      newReads,
    );
    expect(replacement.paramsOf("environment.status").length).toBe(0);
  });

  it("says the change is saved until the host's own read reaches its revision, then stops saying anything", async () => {
    // Saved at 6; this host still reads 5, then 6 on its next read.
    script.reads = [read(false, 5), read(false, 5), read(true, 6)];
    mount();
    await flipOn();

    await waitFor(async () =>
      expect(await line()).toContain("This host hasn't picked it up yet"),
    );
    // The row re-reads at the configuration cadence; the third answer is the
    // one carrying the revision the write was saved as.
    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(async () =>
      expect(await line()).toContain("Running agents pick this up"),
    );
    expect(await line()).not.toContain("hasn't picked it up");
  });

  it("keeps waiting for a read that already carries the asked-for value at an EARLIER revision", async () => {
    // The setting was turned on at revision 4, turned off in a delta this host
    // has not received, and turned on again here, saved as 6. Every read after
    // the write answers `true` - the value this write asked for - while still
    // standing on revision 4, which is the earlier of the two. Taking that as
    // arrival would report success for a state the undelivered revision 5 had
    // already overturned.
    script.reads = [read(false, 4), read(true, 4)];
    script.set = () => savedAnswer({ enabled: true, revision: 6 });
    mount();
    await flipOn();

    await waitFor(async () =>
      expect(await line()).toContain("This host hasn't picked it up yet"),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await line()).toContain("This host hasn't picked it up yet");
  });

  it("supersedes an earlier write with the newer one, saying nothing about the one it replaced", async () => {
    script.reads = [read(false, 5)];
    script.set = () => savedAnswer({ enabled: true, revision: 6 });
    mount();
    await flipOn();
    await waitFor(async () =>
      expect(await line()).toContain("This host hasn't picked it up yet"),
    );

    // A second flip, which the configuration takes and this host has already
    // received: the row speaks for THIS write, and the first is not reported
    // as still waiting, nor as having failed.
    script.reads = [read(false, 5), read(true, 8)];
    script.set = () => ({
      enabled: true,
      state: "applied",
      revision: 8,
      environmentId: ENV,
      uploadId: null,
    });
    await flipOn();

    await waitFor(async () =>
      expect(await line()).toContain("Running agents pick this up"),
    );
    const text = await line();
    expect(text).not.toContain("hasn't picked it up");
    expect(text).not.toContain("Couldn't change");
  });

  it("reads a revision at or past the write's with the OTHER value as unconfirmed, never as arrival", async () => {
    // A later revision overturned it: the pointer is past 6 and reads `false`,
    // which is not what the write asked for.
    script.reads = [read(false, 5), read(false, 9)];
    mount();
    await flipOn();

    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(async () =>
      expect(await line()).toContain("can't be shown here"),
    );
  });

  it("says a write the configuration answered with no revision cannot be shown to have arrived", async () => {
    script.set = () => savedAnswer({ enabled: true, revision: null });
    mount();
    await flipOn();

    await waitFor(async () =>
      expect(await line()).toContain("can't be shown here"),
    );
  });

  it("holds a queued edit as waiting to be sent while its row is in the queue", async () => {
    script.set = () => queuedAnswer(UPLOAD);
    script.statuses = [
      environmentStatusFixture({
        pendingUploads: [
          pendingUploadFixture({
            kind: "agent_memory",
            key: "memory",
            uploadId: UPLOAD,
          }),
        ],
      }),
    ];
    mount();
    await flipOn();

    await waitFor(async () =>
      expect(await line()).toContain("Waiting to reach your configuration"),
    );
  });

  it("takes a queued edit's acknowledgement as the revision to wait for, and settles when the read reaches it", async () => {
    script.set = () => queuedAnswer(UPLOAD);
    // The drain sent it and the host kept the acknowledgement: saved at 7.
    script.statuses = [
      environmentStatusFixture({ acceptedUploads: [receipt({ revision: 7 })] }),
    ];
    script.reads = [
      read(false, 5),
      read(false, 5),
      read(false, 5),
      read(true, 7),
    ];
    mount();
    await flipOn();

    await waitFor(async () =>
      expect(await line()).toContain("This host hasn't picked it up yet"),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(async () =>
      expect(await line()).toContain("Running agents pick this up"),
    );
  });

  it("keeps an acknowledgement whose revision the host's projection already passed, instead of losing the write to the fast path", async () => {
    // The projection reached 9 before the first status read, which an earlier
    // design dropped the receipt for - deleting the only evidence the queued
    // write had. Here it is still there, so the write is placed, not lost.
    script.set = () => queuedAnswer(UPLOAD);
    script.reads = [read(false, 2), read(true, 9)];
    script.statuses = [
      environmentStatusFixture({ acceptedUploads: [receipt({ revision: 7 })] }),
    ];
    mount();
    await flipOn();

    await waitFor(async () =>
      expect(await line()).toContain("Running agents pick this up"),
    );
    expect(await line()).not.toContain("Waiting to reach");
  });

  it("will not take an acknowledgement saved in another configuration as this write's", async () => {
    script.set = () => queuedAnswer(UPLOAD);
    // The read is otherwise everything the write needs - this configuration,
    // past the receipt's revision, carrying the value asked for - so the
    // configuration the acknowledgement names is what decides the outcome.
    script.reads = [read(false, 2), read(true, 9)];
    script.statuses = [
      environmentStatusFixture({
        acceptedUploads: [receipt({ environmentId: OTHER_ENV })],
      }),
    ];
    mount();
    await flipOn();

    // An unrelated receipt leaves this upload queued.
    await waitFor(async () =>
      expect(await line()).toContain("Waiting to reach your configuration"),
    );
  });

  it.each([
    { kind: "shell" as const },
    { key: "other" },
    { os: "linux" as const },
  ])("ignores a receipt with a mismatched identity: %o", async (identity) => {
    script.set = () => queuedAnswer(UPLOAD);
    script.reads = [read(false, 2), read(true, 9)];
    script.statuses = [
      environmentStatusFixture({ acceptedUploads: [receipt(identity)] }),
    ];
    mount();
    await flipOn();
    await waitFor(async () =>
      expect(await line()).toContain("Waiting to reach your configuration"),
    );
  });

  it("retains the accepted revision when a later status omits the receipt", async () => {
    script.set = () => queuedAnswer(UPLOAD);
    script.reads = [
      read(false, 2),
      read(false, 2),
      read(false, 2),
      read(true, 7),
    ];
    script.statuses = [
      environmentStatusFixture({ acceptedUploads: [receipt({})] }),
      environmentStatusFixture({}),
    ];
    mount();
    await flipOn();
    await waitFor(async () =>
      expect(await line()).toContain("This host hasn't picked it up yet"),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(async () =>
      expect(await line()).toContain("Running agents pick this up"),
    );
  });

  it("does not acknowledge a matching revision from an unavailable environment", async () => {
    script.set = () => savedAnswer({ enabled: true, revision: 6 });
    script.reads = [
      read(false, 2),
      { enabled: true, revision: 6, environmentId: null },
    ];
    mount();
    await flipOn();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await line()).toContain("This host hasn't picked it up yet");
  });

  it("says an acknowledgement that names no revision cannot be shown to have arrived", async () => {
    script.set = () => queuedAnswer(UPLOAD);
    script.statuses = [
      environmentStatusFixture({
        acceptedUploads: [receipt({ revision: null })],
      }),
    ];
    mount();
    await flipOn();

    await waitFor(async () =>
      expect(await line()).toContain("can't be shown here"),
    );
  });

  it("reports a refused queued edit as a failure to change the setting", async () => {
    script.set = () => queuedAnswer(UPLOAD);
    script.statuses = [
      environmentStatusFixture({
        pendingUploads: [
          pendingUploadFixture({
            kind: "agent_memory",
            key: "memory",
            uploadId: UPLOAD,
            receipt: "refused",
            code: "permission_denied",
          }),
        ],
      }),
    ];
    mount();
    await flipOn();

    await waitFor(async () =>
      expect(await line()).toContain("Your configuration refused this change"),
    );
  });

  it("keeps a queued edit waiting while its receipt is absent", async () => {
    script.set = () => queuedAnswer(UPLOAD);
    script.statuses = [environmentStatusFixture({})];
    mount();
    await flipOn();

    await waitFor(async () =>
      expect(await line()).toContain("Waiting to reach your configuration"),
    );
  });

  it.each([
    {
      name: "applied",
      answer: () => savedAnswer({ enabled: true, revision: 6 }),
      reads: [read(false, 5), read(true, 6)],
      statuses: [environmentStatusFixture({})],
      text: "Running agents pick this up",
    },
    {
      name: "unconfirmed",
      answer: () => savedAnswer({ enabled: true, revision: null }),
      reads: [read(false, 5)],
      statuses: [environmentStatusFixture({})],
      text: "can't be shown here",
    },
    {
      name: "refused",
      answer: () => queuedAnswer(UPLOAD),
      reads: [read(false, 5)],
      statuses: [
        environmentStatusFixture({
          pendingUploads: [
            pendingUploadFixture({
              kind: "agent_memory",
              key: "memory",
              uploadId: UPLOAD,
              receipt: "refused",
              code: "permission_denied",
            }),
          ],
        }),
      ],
      text: "Your configuration refused this change",
    },
    {
      name: "switch",
      answer: () => savedAnswer({ enabled: true, revision: 6 }),
      reads: [read(false, 5), readIn(OTHER_ENV, false, 3)],
      statuses: [environmentStatusFixture({})],
      text: "Running agents pick this up",
    },
  ])(
    "stops observer requests after $name",
    async ({ answer, reads, statuses, text }) => {
      script.set = answer;
      script.reads = reads;
      script.statuses = statuses;
      const harness = mount();
      await flipOn();
      await waitFor(async () => expect(await line()).toContain(text));
      const readsAtTerminal = harness.paramsOf(
        "config.agentMemories.get",
      ).length;
      const statusesAtTerminal = harness.paramsOf("environment.status").length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(harness.paramsOf("config.agentMemories.get").length).toBe(
        readsAtTerminal,
      );
      expect(harness.paramsOf("environment.status").length).toBe(
        statusesAtTerminal,
      );
    },
  );

  it("reports a setter failure once through the shared host notice", async () => {
    script.set = () => {
      throw new Error("the connection dropped");
    };
    mount();
    await flipOn();

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    const text = await line();
    expect(text).not.toContain("Couldn't change this setting");
    expect(text).not.toContain("Someone else");
    expect(text).not.toContain("Saved to your configuration");
  });

  it("stops re-reading once the bound runs out, and says the change was not confirmed", async () => {
    // A host whose delta never comes: every read stays behind the revision.
    script.reads = [read(false, 5)];
    const harness = mount();
    await flipOn();

    await waitFor(async () =>
      expect(await line()).toContain("This host hasn't picked it up yet"),
    );
    await vi.advanceTimersByTimeAsync(AGENT_MEMORY_CONFIRM_BOUND_MS + 1_000);
    await waitFor(async () =>
      expect(await line()).toContain("can't be shown here"),
    );
    const settled = harness.paramsOf("config.agentMemories.get").length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.paramsOf("config.agentMemories.get").length).toBe(settled);
  });

  it("expires during a stalled getter and ignores its late answer", async () => {
    let resolveRead: (value: ConfigAgentMemoriesResponse) => void = () => {
      throw new Error("getter was not started");
    };
    const harness = mount();
    await screen.findByRole("switch", {
      name: "Use Traycer memories for agents",
    });
    script.get = () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      });
    await flipOn();
    await waitFor(() =>
      expect(
        harness.paramsOf("config.agentMemories.get").length,
      ).toBeGreaterThan(1),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_MEMORY_CONFIRM_BOUND_MS + 1_000);
    });
    expect(await line()).toContain("can't be shown here");
    const count = harness.paramsOf("config.agentMemories.get").length;
    const statusCount = harness.paramsOf("environment.status").length;
    act(() => {
      resolveRead(read(true, 6));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(await line()).toContain("can't be shown here");
    expect(harness.paramsOf("config.agentMemories.get").length).toBe(count);
    expect(harness.paramsOf("environment.status").length).toBe(statusCount);
  });

  it("stands down when the configuration switches while status is in flight", async () => {
    let resolveStatus: (value: EnvironmentStatusResponseV20) => void = () => {
      throw new Error("status was not started");
    };
    script.set = () => queuedAnswer(UPLOAD);
    script.reads = [read(false, 5), read(false, 5), readIn(OTHER_ENV, true, 9)];
    script.status = () =>
      new Promise((resolve) => {
        resolveStatus = resolve;
      });
    const harness = mount();
    await flipOn();
    await waitFor(() =>
      expect(harness.paramsOf("environment.status").length).toBe(1),
    );
    act(() => {
      resolveStatus(
        environmentStatusFixture({ acceptedUploads: [receipt({})] }),
      );
    });
    await waitFor(async () =>
      expect(await line()).toContain("Running agents pick this up"),
    );
    const reads = harness.paramsOf("config.agentMemories.get").length;
    const statuses = harness.paramsOf("environment.status").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(harness.paramsOf("config.agentMemories.get").length).toBe(reads);
    expect(harness.paramsOf("environment.status").length).toBe(statuses);
  });

  it("ignores an older held status after a newer write supersedes it", async () => {
    let resolveStatus: (value: EnvironmentStatusResponseV20) => void = () => {
      throw new Error("status was not started");
    };
    script.set = () => queuedAnswer(UPLOAD);
    script.status = () =>
      new Promise((resolve) => {
        resolveStatus = resolve;
      });
    const harness = mount();
    await flipOn();
    await waitFor(() =>
      expect(harness.paramsOf("environment.status").length).toBe(1),
    );
    script.set = () => ({
      enabled: true,
      state: "applied",
      revision: 8,
      environmentId: ENV,
      uploadId: null,
    });
    await flipOn();
    await waitFor(async () =>
      expect(await line()).toContain("Running agents pick this up"),
    );
    const reads = harness.paramsOf("config.agentMemories.get").length;
    const statuses = harness.paramsOf("environment.status").length;
    act(() => {
      resolveStatus(
        environmentStatusFixture({
          acceptedUploads: [receipt({ revision: null })],
        }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(await line()).toContain("Running agents pick this up");
    expect(harness.paramsOf("config.agentMemories.get").length).toBe(reads);
    expect(harness.paramsOf("environment.status").length).toBe(statuses);
  });

  it("ignores a status response after the row unmounts", async () => {
    let resolveStatus: (value: EnvironmentStatusResponseV20) => void = () => {
      throw new Error("status was not started");
    };
    script.set = () => queuedAnswer(UPLOAD);
    script.status = () =>
      new Promise((resolve) => {
        resolveStatus = resolve;
      });
    const harness = mount();
    await flipOn();
    await waitFor(() =>
      expect(harness.paramsOf("environment.status").length).toBe(1),
    );
    cleanup();
    const reads = harness.paramsOf("config.agentMemories.get").length;
    const statuses = harness.paramsOf("environment.status").length;
    act(() => {
      resolveStatus(
        environmentStatusFixture({ acceptedUploads: [receipt({})] }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(harness.paramsOf("config.agentMemories.get").length).toBe(reads);
    expect(harness.paramsOf("environment.status").length).toBe(statuses);
  });

  it("stands down silently once the row is reading another configuration", async () => {
    // The host rebound part-way through the wait: what it reads is another
    // configuration's, so this write is not something the row can report on
    // any more.
    script.reads = [
      read(false, 5),
      read(false, 5),
      readIn(OTHER_ENV, false, 3),
    ];
    mount();
    await flipOn();

    await waitFor(async () =>
      expect(await line()).toContain("This host hasn't picked it up yet"),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(async () =>
      expect(await line()).toContain("Running agents pick this up"),
    );
  });

  it("keeps stale-write origin in the shared notice without duplicating it inline", async () => {
    script.set = () => {
      throw HostRpcError.fromWireEnvelope(
        {
          code: "ENVIRONMENT_WRITE_STALE",
          message: "someone else changed it",
          staleWrite: { changedBy: { kind: "dashboard" }, currentRevision: 6 },
        },
        "req-stale",
        "config.agentMemories.set",
      );
    };
    mount();
    await flipOn();

    await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1));
    expect(toast.info).toHaveBeenCalledWith(
      "This setting was changed in the dashboard just now.",
      { id: "environment-write-stale" },
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(await line()).not.toContain("Someone else changed this setting");
  });

  it("finishes after navigation with one shared setter failure notice", async () => {
    let reject: (error: Error) => void = () => {
      throw new Error("setter was not started");
    };
    script.set = () =>
      new Promise((_resolve, rejectWrite) => {
        reject = rejectWrite;
      });
    const harness = mountTeamPage({ kind: "host" }, handlers());
    const view = render(<AgentMemoriesSettingsPanel />, {
      wrapper: harness.Wrapper,
    });
    await flipOn();
    await waitFor(() =>
      expect(harness.paramsOf("config.agentMemories.set")).toHaveLength(1),
    );
    view.unmount();
    act(() => reject(new Error("response lost after navigation")));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
  });

  it("never asks for the host's configuration card for a write the configuration already took", async () => {
    const harness = mount();
    await flipOn();

    await waitFor(async () =>
      expect(await line()).toContain("This host hasn't picked it up yet"),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.paramsOf("environment.status")).toEqual([]);
  });
});
