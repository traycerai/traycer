/**
 * A composer that rests on a sandbox, by naming it or by default, takes a stage
 * for it, since only a stage's Send wakes it. Real hooks and stores; only the
 * person's host directory and the window's `AuthService` list are answered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  createRestingBinding,
  restingDirectory,
  type RestingBinding,
} from "@/hooks/sandboxes/__tests__/resting-directory-fixture";

const mocks = vi.hoisted(() => ({ binding: null as RestingBinding | null }));

vi.mock(
  "@traycer-clients/shared/host-client/host-connection-registry",
  async (importOriginal) => {
    const { restingDirectory: directory } =
      await import("@/hooks/sandboxes/__tests__/resting-directory-fixture");
    return {
      ...(await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-connection-registry")
      >()),
      readHostDirectoryEntry: directory.read,
      subscribeHostRowChanged: directory.subscribe,
    };
  },
);
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));

import { HostRuntimeTestProvider } from "@/lib/host/__tests__/host-runtime-test-provider";
import { useRestingHostStage } from "@/components/composer/use-sandbox-staging";
import { useAuthStore } from "@/stores/auth/auth-store";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { sandboxWakeId } from "@/lib/sandboxes/sandbox-wake-wait";
import { useSandboxWakeReportStore } from "@/stores/sandboxes/sandbox-wake-report-store";
import {
  readStagedSandbox,
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";

const SURFACE = "new-conversation:epic-1";
const HOST_ID = "sbx-rest-host";

const PERSONS_STAGE: StagedSandboxTarget = {
  kind: "existing",
  hostId: "sbx-other-host",
  sandboxId: "sbx_other",
  name: "other-box",
  configuration: { kind: "personal" },
  verb: "start",
};

interface Input {
  readonly surfaceKey: string | null;
  readonly hostId: string | null;
  readonly named: boolean;
}

function listed(state: "suspended" | "stopped" | "awake") {
  restingDirectory.setSandbox(HOST_ID, "build-box", state);
  mocks.binding?.auth.listSandboxes.mockImplementation(() =>
    Promise.resolve({
      kind: "ok",
      response: {
        sandboxes: [
          sandboxSummaryFixture({
            id: "sbx_rest",
            hostId: HOST_ID,
            displayName: "build-box",
            state,
          }),
        ],
      },
    }),
  );
}

function mount(input: Input) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <HostRuntimeTestProvider>{children}</HostRuntimeTestProvider>
    </QueryClientProvider>
  );
  const view = renderHook((props: Input) => useRestingHostStage(props), {
    initialProps: input,
    wrapper,
  });
  return { ...view, client };
}

/** The sandbox list has been read and the hook has rendered with it. */
async function listRead(client: QueryClient): Promise<void> {
  await waitFor(() =>
    expect(
      client
        .getQueryCache()
        .findAll()
        .filter((query) => query.state.status === "success"),
    ).not.toEqual([]),
  );
  await act(() => Promise.resolve());
}

const UNNAMED: Input = { surfaceKey: SURFACE, hostId: HOST_ID, named: false };

beforeEach(() => {
  mocks.binding = createRestingBinding([]);
  restingDirectory.clear();
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "u1", username: "ada" },
  });
  useStagedSandboxStore.setState({ bySurface: {} });
  useSandboxWakeReportStore.setState({ answeredWakes: {} });
});

afterEach(() => {
  restingDirectory.clear();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  useStagedSandboxStore.setState({ bySurface: {} });
});

describe("useRestingHostStage", () => {
  it.each([
    { state: "suspended", verb: "resume" },
    { state: "stopped", verb: "start" },
  ] as const)(
    "stages a $state sandbox from the list row when nothing is staged",
    async ({ state, verb }) => {
      listed(state);

      mount(UNNAMED);

      await waitFor(() =>
        expect(readStagedSandbox(SURFACE)).toMatchObject({
          phase: "staged",
          target: {
            kind: "existing",
            hostId: HOST_ID,
            sandboxId: "sbx_rest",
            name: "build-box",
            configuration: { kind: "personal" },
            verb,
          },
        }),
      );
    },
  );

  it("leaves a person's stage alone on a surface that did not name the host", async () => {
    listed("suspended");
    useStagedSandboxStore.getState().stage(SURFACE, PERSONS_STAGE);
    const before = readStagedSandbox(SURFACE);

    const { client } = mount(UNNAMED);
    await listRead(client);

    expect(readStagedSandbox(SURFACE)).toBe(before);
  });

  it("replaces a stage still waiting on a surface that named the host", async () => {
    listed("suspended");
    useStagedSandboxStore.getState().stage(SURFACE, PERSONS_STAGE);

    mount({ ...UNNAMED, named: true });

    await waitFor(() =>
      expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
        hostId: HOST_ID,
        verb: "resume",
      }),
    );
  });

  it("never replaces a stage that is past staged, even on a named surface", async () => {
    listed("suspended");
    useStagedSandboxStore.getState().stage(SURFACE, PERSONS_STAGE);
    useStagedSandboxStore.getState().begin(SURFACE, false, Date.now(), false);
    const running = readStagedSandbox(SURFACE);
    expect(running?.phase).not.toBe("staged");

    const { client } = mount({ ...UNNAMED, named: true });
    await listRead(client);

    expect(readStagedSandbox(SURFACE)).toBe(running);
  });

  it("takes its own stage off when the sandbox wakes", async () => {
    listed("suspended");
    mount(UNNAMED);
    await waitFor(() => expect(readStagedSandbox(SURFACE)).not.toBeNull());

    act(() => restingDirectory.setSandbox(HOST_ID, "build-box", "awake"));

    await waitFor(() => expect(readStagedSandbox(SURFACE)).toBeNull());
  });

  it("takes its own stage off when the surface unmounts", async () => {
    listed("suspended");
    const view = mount(UNNAMED);
    await waitFor(() => expect(readStagedSandbox(SURFACE)).not.toBeNull());

    view.unmount();

    expect(readStagedSandbox(SURFACE)).toBeNull();
  });

  it("leaves a stage a send has adopted when the surface unmounts", async () => {
    listed("suspended");
    const view = mount(UNNAMED);
    await waitFor(() => expect(readStagedSandbox(SURFACE)).not.toBeNull());
    // The send begins the wake: the stage moves on from the one staged here.
    useStagedSandboxStore.getState().begin(SURFACE, false, Date.now(), false);
    const adopted = readStagedSandbox(SURFACE);
    expect(adopted?.phase).not.toBe("staged");

    view.unmount();

    expect(readStagedSandbox(SURFACE)).toBe(adopted);
  });
  it("puts back a stage that was cleared while the sandbox is still there", async () => {
    listed("suspended");
    mount(UNNAMED);
    await waitFor(() => expect(readStagedSandbox(SURFACE)).not.toBeNull());

    act(() => useStagedSandboxStore.getState().clear(SURFACE));

    await waitFor(() =>
      expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
        hostId: HOST_ID,
        verb: "resume",
      }),
    );
  });

  describe("through a wake", () => {
    const RESUMING = sandboxSummaryFixture({
      id: "sbx_rest",
      hostId: HOST_ID,
      displayName: "build-box",
      state: "resuming",
    });
    const WOKEN = sandboxSummaryFixture({
      id: "sbx_rest",
      hostId: HOST_ID,
      displayName: "build-box",
      state: "awake",
      operation: {
        at: 1_791_000_020_000,
        fromState: "suspended",
        state: "awake",
        cause: "wake",
        outcomeCause: "wake",
        outcomeDetail: null,
        actor: null,
        gesture: null,
      },
    });

    /** The row the list carries and the directory mirrors, a tick apart. */
    function rowNow(
      client: QueryClient,
      state: "resuming" | "awake",
      summary: SandboxSummary,
    ): void {
      act(() => {
        client.setQueryData(
          sandboxQueryKeys.list(mocks.binding?.auth ?? {}, "u1"),
          { sandboxes: [summary] },
        );
        restingDirectory.setSandbox(HOST_ID, "build-box", state);
      });
    }

    it("holds the same stage as the row goes resuming, then awake with a host that has not reported", async () => {
      listed("suspended");
      const { client } = mount(UNNAMED);
      await waitFor(() => expect(readStagedSandbox(SURFACE)).not.toBeNull());
      const staged = readStagedSandbox(SURFACE);

      rowNow(client, "resuming", RESUMING);
      await listRead(client);
      expect(readStagedSandbox(SURFACE)).toBe(staged);

      rowNow(client, "awake", WOKEN);
      await listRead(client);
      expect(readStagedSandbox(SURFACE)).toBe(staged);
    });

    it("takes its stage off once the host first reports", async () => {
      listed("suspended");
      const { client } = mount(UNNAMED);
      await waitFor(() => expect(readStagedSandbox(SURFACE)).not.toBeNull());
      rowNow(client, "resuming", RESUMING);
      rowNow(client, "awake", WOKEN);
      await listRead(client);
      expect(readStagedSandbox(SURFACE)).not.toBeNull();

      act(() =>
        useSandboxWakeReportStore
          .getState()
          .recordAnswer("sbx_rest", sandboxWakeId(WOKEN)),
      );

      await waitFor(() => expect(readStagedSandbox(SURFACE)).toBeNull());
    });

    it("leaves a stage a send took alone when the host first reports", async () => {
      listed("suspended");
      const { client } = mount(UNNAMED);
      await waitFor(() => expect(readStagedSandbox(SURFACE)).not.toBeNull());
      useStagedSandboxStore.getState().begin(SURFACE, false, Date.now(), false);
      const taken = readStagedSandbox(SURFACE);
      rowNow(client, "resuming", RESUMING);
      rowNow(client, "awake", WOKEN);

      act(() =>
        useSandboxWakeReportStore
          .getState()
          .recordAnswer("sbx_rest", sandboxWakeId(WOKEN)),
      );
      await listRead(client);

      expect(readStagedSandbox(SURFACE)).toBe(taken);
    });
  });
});
