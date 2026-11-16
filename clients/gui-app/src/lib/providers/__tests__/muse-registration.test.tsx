import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerIdFromHarnessOrProviderName } from "@traycer-clients/shared/providers/provider-harness-ids";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { providerSignedOutMessage } from "@traycer/protocol/host/provider-display";
import type {
  ProviderCliCandidate,
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { ModelRowsState } from "@/components/home/pickers/harness-model-picker-empty";
import { ProviderApiKeySection } from "@/components/settings/panels/provider-api-key-section";
import { ProviderCliCandidatesSection } from "@/components/settings/panels/provider-cli-candidates-section";
import { KIMI_LIST_ROW } from "@/components/settings/panels/__tests__/__fixtures__/kimi-projected-auth";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import {
  providerDisplayName,
  providerIdToGuiHarnessId,
} from "@/lib/provider-ordering";

const openLink = vi.hoisted(() => vi.fn());

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => openLink,
}));

vi.mock("@/hooks/providers/use-providers-set-selection-mutation", () => ({
  useProvidersSetSelection: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/providers/use-providers-add-custom-path-mutation", () => ({
  useProvidersAddCustomPath: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/providers/use-providers-remove-custom-path-mutation", () => ({
  useProvidersRemoveCustomPath: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/providers/use-providers-ensure-pack-mutation", () => ({
  useProvidersEnsurePack: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/providers/use-providers-detect-version-query", () => ({
  useProvidersDetectVersion: () => ({ isFetching: false, data: undefined }),
}));

vi.mock("@/hooks/providers/use-providers-set-api-key-mutation", () => ({
  useProvidersSetApiKey: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/providers/use-providers-clear-api-key-mutation", () => ({
  useProvidersClearApiKey: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
}));

function registeredProvider(name: string): ProviderId {
  const providerId = providerIdFromHarnessOrProviderName(name);
  if (providerId === null) {
    throw new Error(`Provider name ${name} is not registered.`);
  }
  return providerId;
}

function providerState(
  providerId: ProviderId,
  candidates: readonly ProviderCliCandidate[],
): ProviderCliState {
  return {
    ...KIMI_LIST_ROW,
    providerId,
    enabled: true,
    selected: { kind: "path" },
    candidates: [...candidates],
    auth: {
      status: "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    checkedAt: null,
    cliBinaryResolved: candidates.some((candidate) => candidate.available),
    nextRunBinary: null,
  };
}

function pathCandidate(path: string): ProviderCliCandidate {
  return {
    kind: "path",
    path,
    version: null,
    available: true,
    versionPending: false,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Muse Code client registration", () => {
  it("takes the shared provider name through the GUI harness to actionable sign-in guidance", () => {
    const providerId = registeredProvider("muse");
    const state: ProviderCliState = {
      ...providerState(providerId, [pathCandidate("/usr/local/bin/muse")]),
      // A supplied capability exercises client guidance, not a host support claim.
      loginCapability: {
        oauthArgs: null,
        token: null,
        codePaste: null,
        terminalLogin: {},
        remoteSafe: null,
        selfOpensBrowser: null,
      },
    };
    const harness: GuiHarnessCatalogEntry = {
      id: providerIdToGuiHarnessId(providerId),
      label: providerDisplayName(providerId),
      enabled: true,
      available: true,
      error: null,
      modes: ["gui"],
      requiresApiKey: false,
      supportedPermissionModes: [],
      nativeAutoJudge: false,
      availabilityPending: false,
      models: [],
      modelsLoading: false,
      modelsError: new HostRpcError({
        code: "RPC_ERROR",
        message: providerSignedOutMessage(providerId),
        requestId: "muse-registration",
        method: "agent.gui.listModels",
        fatalDetails: null,
      }),
    };

    render(
      <ModelRowsState
        catalogLoading={false}
        catalogError={false}
        hostUnavailableLabel={null}
        hasQuery={false}
        activeProvider={harness}
        activeProviderState={state}
        rowsCount={0}
        onOpenProviderSettings={() => undefined}
        onOpenHostUpdates={() => undefined}
        terminalLoginSurface={null}
        runTargetHostId={null}
        onClosePicker={() => undefined}
      />,
    );

    expect(screen.getByText("Set up Muse Code")).toBeDefined();
    expect(screen.getByText(/sign in to Muse Code/i)).toBeDefined();
    expect(
      screen.getByText(/complete the sign-in in the browser/i),
    ).toBeDefined();
    expect(screen.getByText(/choose.*sign in from a terminal/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: /report issue/i })).toBeNull();
  });

  it("requires Muse's own CLI even when OpenCode is installed, while preserving shared-binary providers", () => {
    const muse = providerState(registeredProvider("muse"), []);
    const opencode = providerState("opencode", [
      pathCandidate("/usr/local/bin/opencode"),
    ]);
    const providers = [muse, opencode];
    const { rerender } = render(
      <TooltipProvider>
        <ProviderCliCandidatesSection
          state={muse}
          providers={providers}
          hostId={null}
        />
      </TooltipProvider>,
    );

    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    const guide = screen.getByRole("link", {
      name: "Muse Code installation guide",
    });
    expect(guide.getAttribute("href")).toBe(
      "https://dev.meta.ai/docs/muse-code",
    );
    fireEvent.click(guide);
    expect(openLink).toHaveBeenCalledWith(
      "https://dev.meta.ai/docs/muse-code",
      "docs",
      null,
    );

    rerender(
      <TooltipProvider>
        <ProviderCliCandidatesSection
          state={providerState("huggingface", [])}
          providers={providers}
          hostId={null}
        />
      </TooltipProvider>,
    );
    expect(
      screen.getByRole("radio", { name: "Select /usr/local/bin/opencode" }),
    ).toBeDefined();

    const installedMuse = providerState(muse.providerId, [
      pathCandidate("/usr/local/bin/muse"),
    ]);
    rerender(
      <TooltipProvider>
        <ProviderCliCandidatesSection
          state={installedMuse}
          providers={[installedMuse, opencode]}
          hostId={null}
        />
      </TooltipProvider>,
    );
    expect(
      screen
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("aria-label")),
    ).toEqual(["Select /usr/local/bin/muse"]);
  });

  it("shows META_API_KEY when the host reports a Muse key sourced from the shell", () => {
    const state: ProviderCliState = {
      ...providerState(registeredProvider("muse"), []),
      apiKey: { supported: true, configured: true, source: "env" },
    };
    render(
      <ProviderApiKeySection
        state={state}
        draft=""
        onDraftChange={() => undefined}
      />,
    );

    expect(
      screen.getByText(
        "Using META_API_KEY from your shell. Save a key here to override it.",
      ),
    ).toBeDefined();
    expect(
      screen.getByPlaceholderText("Paste your Muse Code API key"),
    ).toBeDefined();
  });
});
