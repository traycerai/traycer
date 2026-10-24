import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SandboxControlFailure } from "@traycer-clients/shared/host-client/sandbox-control";
import type { SandboxCreateRequest } from "@traycer/protocol/host/sandbox-control";
import { SandboxRowActions } from "@/components/settings/panels/sandbox-row-actions";
import { SandboxCreateError } from "@/hooks/sandboxes/use-sandbox-create-mutation";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  readStagedSandbox,
  useStagedSandboxStore,
} from "@/stores/composer/staged-sandbox-store";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";

const SURFACE = "landing:window-test";

const mutation = () => ({ mutate: vi.fn(), isPending: false });
const createMutate = vi.hoisted(() =>
  vi.fn<
    (
      variables: { readonly request: SandboxCreateRequest },
      callbacks: {
        readonly onSuccess: () => void;
        readonly onError: (error: Error) => void;
      },
    ) => void
  >(),
);

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => new Promise<void>(() => undefined),
}));
vi.mock("@/hooks/host/use-composer-surface-host-pin", () => ({
  useComposerSurfaceHostKey: () => SURFACE,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-verb-mutation", () => ({
  useSandboxVerb: () => mutation(),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-patch-mutation", () => ({
  useSandboxPatch: () => mutation(),
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-create-mutation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-create-mutation")
    >()),
    useSandboxCreate: () => ({ mutate: createMutate, isPending: false }),
  }),
);
vi.mock(
  "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation",
  () => ({ useSandboxRepairGuestConfigurationOnHost: () => mutation() }),
);
// The run is the network boundary: it creates or wakes the sandbox.
const runStagedSandbox = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/sandboxes/staged-sandbox-run", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/sandboxes/staged-sandbox-run")
  >()),
  runStagedSandbox,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => ({ auth: {}, directory: {} }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ signInUrl: "https://example.test" }),
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));
// The confirm dialogs read the account; this suite never opens one.
vi.mock("@/components/hosts/sandbox-confirm-dialogs", () => ({
  SandboxDestroyDialog: () => null,
  SandboxIdleSettingsDialog: () => null,
  SandboxKeepDialog: () => null,
  SandboxRenameDialog: () => null,
  SandboxStopDialog: () => null,
  SandboxSuspendDialog: () => null,
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ close: vi.fn() }),
}));

beforeEach(() => {
  createMutate.mockClear();
  runStagedSandbox.mockClear();
  useStagedSandboxStore.setState({ bySurface: {} });
  useSurfaceHostSelectionStore.setState({ selections: {} });
  useLandingPanelStore.getState().resetForTests();
});

afterEach(cleanup);

function renderRow(element: ReactElement): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      {element}
    </QueryClientProvider>,
  );
}

describe("<SandboxRowActions />", () => {
  it("drops the landing composer's staged New sandbox when a row opens its own sandbox there", async () => {
    useStagedSandboxStore.getState().stage(SURFACE, {
      kind: "new",
      configuration: { kind: "personal" },
      shape: {
        os: "linux",
        cpus: 2,
        memoryMb: 4096,
        diskMb: null,
        region: "us-east",
        idleMinutes: 30,
        destroyAfterRestingMinutes: 10_080,
      },
      name: "",
      wakeString: null,
    });
    renderRow(
      <SandboxRowActions
        summary={sandboxSummaryFixture({
          id: "sbx-build",
          hostId: "host-build",
          state: "awake",
          burst: false,
          guestConfigured: true,
        })}
        configuration={{ kind: "personal" }}
        unreachable={false}
        frozenNeedsOwnCredits={false}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /^More actions for/ }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open a tab" }),
    );

    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(useSurfaceHostSelectionStore.getState().selections[SURFACE]).toBe(
      "host-build",
    );
  });

  it("stages a suspended sandbox to resume when a row opens it there, so the first send wakes it", async () => {
    renderRow(
      <SandboxRowActions
        summary={sandboxSummaryFixture({
          id: "sbx-build",
          hostId: "host-build",
          displayName: "build-box",
          state: "suspended",
          burst: false,
          frozen: false,
        })}
        configuration={{ kind: "personal" }}
        unreachable={false}
        frozenNeedsOwnCredits={false}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /^More actions for/ }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open a tab" }),
    );

    expect(readStagedSandbox(SURFACE)?.target).toEqual({
      kind: "existing",
      hostId: "host-build",
      sandboxId: "sbx-build",
      name: "build-box",
      configuration: { kind: "personal" },
      verb: "resume",
    });
    expect(useSurfaceHostSelectionStore.getState().selections[SURFACE]).toBe(
      "host-build",
    );
  });

  it.each([
    { item: "Open a tab", request: null },
    { item: "Open terminal", request: "host-build" },
  ])(
    "asks the landing panel for a terminal on an awake sandbox from $item: $request",
    async ({ item, request }) => {
      // An earlier press's ask that was never served; this one replaces it.
      useLandingPanelStore.getState().requestTerminal(SURFACE, "host-earlier");
      renderRow(
        <SandboxRowActions
          summary={sandboxSummaryFixture({
            id: "sbx-build",
            hostId: "host-build",
            state: "awake",
            burst: false,
            guestConfigured: true,
          })}
          configuration={{ kind: "personal" }}
          unreachable={false}
          frozenNeedsOwnCredits={false}
        />,
      );

      await userEvent.click(
        screen.getByRole("button", { name: /^More actions for/ }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: item }),
      );

      expect(
        useLandingPanelStore.getState().terminalRequest?.hostId ?? null,
      ).toBe(request);
    },
  );

  it("wakes a suspended sandbox from Open terminal at once, marked to open its terminal and send nothing", async () => {
    useLandingPanelStore.getState().requestTerminal(SURFACE, "host-earlier");
    renderRow(
      <SandboxRowActions
        summary={sandboxSummaryFixture({
          id: "sbx-build",
          hostId: "host-build",
          state: "suspended",
          burst: false,
          frozen: false,
        })}
        configuration={{ kind: "personal" }}
        unreachable={false}
        frozenNeedsOwnCredits={false}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /^More actions for/ }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open terminal" }),
    );

    expect(readStagedSandbox(SURFACE)).toMatchObject({
      target: { kind: "existing", hostId: "host-build", verb: "resume" },
      openTerminal: true,
      sendTaken: false,
    });
    expect(runStagedSandbox).toHaveBeenCalledTimes(1);
    expect(runStagedSandbox).toHaveBeenCalledWith(
      SURFACE,
      true,
      { fallbackName: "build-box", taskId: null },
      expect.anything(),
    );
    expect(useLandingPanelStore.getState().terminalRequest).toBeNull();
  });

  it.each([
    { period: null, sent: 0 },
    { period: 4_320, sent: 4_320 },
  ])(
    "retries a failed create with its resting period ($period rests for $sent)",
    async ({ period, sent }) => {
      renderRow(
        <SandboxRowActions
          summary={sandboxSummaryFixture({
            state: "failed",
            destroyAfterRestingMinutes: period,
          })}
          configuration={{ kind: "personal" }}
          unreachable={false}
          frozenNeedsOwnCredits={false}
        />,
      );

      await userEvent.click(screen.getByRole("button", { name: "Retry" }));

      expect(createMutate).toHaveBeenCalledTimes(1);
      expect(
        createMutate.mock.calls[0]?.[0].request.destroyAfterRestingMinutes,
      ).toBe(sent);
    },
  );

  it("keeps Retry's key until the server refuses it before creating, or accepts it", async () => {
    renderRow(
      <SandboxRowActions
        summary={sandboxSummaryFixture({ state: "failed" })}
        configuration={{ kind: "personal" }}
        unreachable={false}
        frozenNeedsOwnCredits={false}
      />,
    );
    const press = async (): Promise<{
      readonly key: string | null;
      readonly answer: {
        readonly onSuccess: () => void;
        readonly onError: (error: Error) => void;
      };
    }> => {
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
      const call = createMutate.mock.calls.at(-1);
      if (call === undefined) throw new Error("expected a create");
      return { key: call[0].request.clientRequestId, answer: call[1] };
    };
    const refusal = (failure: SandboxControlFailure) =>
      new SandboxCreateError("no", null, null, failure);

    const first = await press();
    // The answer never came: the create may have been accepted.
    act(() =>
      first.answer.onError(
        refusal({ kind: "network-error", detail: "timeout" }),
      ),
    );
    const second = await press();
    expect(second.key).toBe(first.key);

    act(() =>
      second.answer.onError(
        refusal({
          kind: "refused",
          status: 402,
          code: "insufficient_credit",
          reason: null,
          shortfallMc: 100,
          newRateMcPerHour: null,
          currentAwakeBurnMcPerHour: null,
          message: null,
        }),
      ),
    );
    const third = await press();
    expect(third.key).not.toBe(second.key);

    act(() => third.answer.onSuccess());
    const fourth = await press();
    expect(fourth.key).not.toBe(third.key);
  });
});
