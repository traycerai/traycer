import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { TuiAgentProjection } from "@/stores/epics/open-epic/types";
import type { ForkWorkspaceSeed } from "@/lib/worktree/fork-workspace-seed";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";

/**
 * D4 (durability audit), end-to-end: "Fork dialog seeded from a chat whose
 * profile is now tombstoned: falls back to ambient for the new selection;
 * no crash."
 *
 * Mirrors terminal-agent-fork-dialog.test.tsx's mocking shape (only the
 * picker/agent-mode-toggle/workspace-controls/harness-catalog are stubbed -
 * `useComposerToolbarStore` / `createComposerToolbarStore` are the REAL
 * production store), so this exercises the actual code path that decides
 * what `profileId` gets sent to `createAgent.create`.
 *
 * A cold reviewer flagged the FIRST version of this fix: the seed-resolution
 * hook originally read `providers.list` from the APP-WIDE ACTIVE host
 * (`useProvidersList`) instead of the host the fork's `createAgent.create`
 * call actually targets (this dialog's explicit `hostClient` prop). `mock
 * useHostQuery` here is keyed by the EXACT `client` reference it's called
 * with, so the cross-host tests below can prove the dialog reads from its
 * OWN `hostClient` prop and never a decoy "active host" client.
 */

const dialogMocks = vi.hoisted(() => ({
  create: vi.fn<(input: TerminalForkCreateInput) => Promise<string | null>>(),
  providersByClient: new Map<unknown, ProviderCliState[]>(),
}));

vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgentForClient: () => ({
    create: dialogMocks.create,
    isPending: false,
  }),
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: {
    readonly client: unknown;
    readonly options: { readonly enabled: boolean } | null;
  }) => {
    if (!(args.options?.enabled ?? false)) return { data: undefined };
    const providers = dialogMocks.providersByClient.get(args.client);
    return { data: providers === undefined ? undefined : { providers } };
  },
}));

vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: () => (
    <button type="button" aria-label="Harness picker">
      Claude Opus
    </button>
  ),
}));

vi.mock("@/components/home/pickers/agent-mode-toggle", () => ({
  AgentModeToggle: () => (
    <button type="button" aria-label="Agent mode">
      Regular
    </button>
  ),
}));

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    ActiveHostWorkspaceControls: () => null,
  }),
);

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () => ({
    data: {
      harnesses: [
        {
          id: "claude",
          label: "Claude Code",
          available: true,
          error: null,
          modes: ["gui", "tui"],
          requiresApiKey: false,
          supportedPermissionModes: ["supervised"],
        },
      ],
    },
    isPending: false,
  }),
  useGuiHarnessModelsQuery: () => ({
    data: {
      models: [
        {
          harnessId: "claude",
          slug: "claude-opus-4-7",
          label: "Claude Opus",
          description: null,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [],
          defaultServiceTier: null,
          supportedServiceTiers: [],
          metadata: {},
        },
      ],
    },
    isPending: false,
  }),
}));

import { TerminalAgentForkDialog } from "../terminal-agent-fork-dialog";

interface TerminalForkCreateInput {
  readonly profileId: string | null;
}

function buildHostClient(hostId: string): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    // `useHostQuery` is mocked wholesale below, so this messenger's handlers
    // are never actually invoked - this just needs to be a real, distinct
    // `HostClient` instance to key `dialogMocks.providersByClient` by.
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${hostId}`,
      handlers: {},
    }),
  });
  client.bind({
    hostId,
    label: hostId,
    kind: "local",
    websocketUrl: `ws://127.0.0.1:0/${hostId}`,
    version: "0.0.0-mock",
    status: "available",
  });
  return client;
}

// The dialog's own `hostClient` prop - the ONLY client its `createAgent`
// call and the seeded-profile validation are supposed to read from.
const TARGET_HOST_CLIENT = buildHostClient("target-host");
// A decoy standing in for "the app-wide active host" (or any other host) -
// something the dialog must NEVER read profiles from. Never passed as the
// `hostClient` prop in any test below.
const DECOY_ACTIVE_HOST_CLIENT = buildHostClient("decoy-active-host");

function sourceAgentWithProfile(profileId: string | null): TuiAgentProjection {
  return {
    id: "source-agent",
    harnessId: "claude",
    title: "Source terminal",
    parentId: "source-parent",
    createdAt: 0,
    updatedAt: 0,
    userId: "user-test",
    hostId: "host-test",
    workspaceFolders: ["/workspace"],
    workspaceMode: undefined,
    model: "claude-opus-4-7",
    reasoningEffort: "high",
    agentMode: "regular",
    profileId,
    harnessSessionId: "source-session",
    terminalAgentArgs: null,
    terminalShellCommand: "claude",
    terminalShellArgs: ["--resume", "source-session"],
  };
}

function emptyWorkspaceSeed(): ForkWorkspaceSeed {
  return {
    workspace: { folders: [], folderInfoByPath: {}, primaryPath: null },
    intent: null,
  };
}

function profile(
  profileId: string,
  kind: "ambient" | "managed",
  label: string,
): ProviderProfile {
  return {
    profileId,
    kind,
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function claudeState(profiles: ProviderProfile[]): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles,
  };
}

describe("D4: TerminalAgentForkDialog seeded from a tombstoned profile", () => {
  beforeEach(() => {
    dialogMocks.providersByClient.clear();
  });
  afterEach(() => {
    dialogMocks.create.mockReset();
    cleanup();
  });

  it("FIXED: forking without touching the picker falls back to ambient when the source profile is tombstoned", async () => {
    // The target host HAS enumerated profiles (so the check can judge), and
    // "tombstoned-uuid" is simply absent from them.
    dialogMocks.providersByClient.set(TARGET_HOST_CLIENT, [
      claudeState([profile("ambient", "ambient", "Terminal account")]),
    ]);
    dialogMocks.create.mockResolvedValue("forked-agent");
    render(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: sourceAgentWithProfile("tombstoned-uuid"),
          workspaceSeed: emptyWorkspaceSeed(),
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={TARGET_HOST_CLIENT}
        onOpenChange={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    await waitFor(() => {
      expect(dialogMocks.create).toHaveBeenCalled();
    });
    expect(dialogMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: null }),
    );
  });

  it("a source profile that is STILL alive passes through unchanged, and the dialog doesn't crash", async () => {
    dialogMocks.providersByClient.set(TARGET_HOST_CLIENT, [
      claudeState([
        profile("ambient", "ambient", "Terminal account"),
        profile("work-uuid", "managed", "Work"),
      ]),
    ]);
    dialogMocks.create.mockResolvedValue("forked-agent");
    render(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: sourceAgentWithProfile("work-uuid"),
          workspaceSeed: emptyWorkspaceSeed(),
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={TARGET_HOST_CLIENT}
        onOpenChange={() => undefined}
      />,
    );

    const titleInput = screen.getByRole("textbox", {
      name: "Fork terminal agent title",
    });
    expect((titleInput as HTMLInputElement).value).toBe(
      "Fork - Source terminal",
    );

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    await waitFor(() => {
      expect(dialogMocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: "work-uuid" }),
      );
    });
  });

  it("holds the seeded profileId verbatim while the target host's providers.list hasn't loaded yet (unsettled) - never false-positives an undetermined profile to ambient", async () => {
    // No entry registered for TARGET_HOST_CLIENT at all - the `useHostQuery`
    // mock returns `data: undefined`, the genuine "still loading" signal
    // `resolveSeededProfileId`'s `settled` param must gate on.
    dialogMocks.create.mockResolvedValue("forked-agent");
    render(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: sourceAgentWithProfile("work-uuid"),
          workspaceSeed: emptyWorkspaceSeed(),
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={TARGET_HOST_CLIENT}
        onOpenChange={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    await waitFor(() => {
      expect(dialogMocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: "work-uuid" }),
      );
    });
  });

  it("ticket 07: resolves the seeded profileId to ambient once the target host SETTLES on an empty profiles[] (old host, or flag-off/unsupported provider) - a settled empty list means 'no support', not 'unknown'", async () => {
    // The target host HAS responded - just with no profiles for this
    // provider (an old host upgraded to `profiles: []`, or a new host with
    // the flag off / an unsupported provider). Per the protocol-schema-
    // contract-compat review's Major finding, preserving the pin here would
    // silently run the account on ambient while the UI/artifact still
    // claimed the managed profile - this must clear it instead.
    dialogMocks.providersByClient.set(TARGET_HOST_CLIENT, [claudeState([])]);
    dialogMocks.create.mockResolvedValue("forked-agent");
    render(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: sourceAgentWithProfile("work-uuid"),
          workspaceSeed: emptyWorkspaceSeed(),
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={TARGET_HOST_CLIENT}
        onOpenChange={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    await waitFor(() => {
      expect(dialogMocks.create).toHaveBeenCalled();
    });
    expect(dialogMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: null }),
    );
  });

  describe("cross-host: validation must read the fork's OWN hostClient, never the active/decoy host", () => {
    it("source profile alive on the TARGET host but absent on the decoy host must be PRESERVED (no false null)", async () => {
      // The dialog's own host (its `hostClient` prop) has the profile alive.
      dialogMocks.providersByClient.set(TARGET_HOST_CLIENT, [
        claudeState([
          profile("ambient", "ambient", "Terminal account"),
          profile("work-uuid", "managed", "Work"),
        ]),
      ]);
      // A decoy "active host" - never passed as `hostClient` - claims the
      // profile doesn't exist there. If the dialog ever silently fell back to
      // reading from an app-wide active-host client instead of its own prop,
      // this would wrongly null the profile.
      dialogMocks.providersByClient.set(DECOY_ACTIVE_HOST_CLIENT, [
        claudeState([profile("ambient", "ambient", "Terminal account")]),
      ]);
      dialogMocks.create.mockResolvedValue("forked-agent");
      render(
        <TerminalAgentForkDialog
          open
          target={{
            sourceAgent: sourceAgentWithProfile("work-uuid"),
            workspaceSeed: emptyWorkspaceSeed(),
          }}
          epicId="epic-test"
          tabId="tab-test"
          hostId="host-test"
          hostClient={TARGET_HOST_CLIENT}
          onOpenChange={() => undefined}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Fork" }));

      await waitFor(() => {
        expect(dialogMocks.create).toHaveBeenCalledWith(
          expect.objectContaining({ profileId: "work-uuid" }),
        );
      });
    });

    it("source profile tombstoned on the TARGET host but alive on the decoy host must resolve to null", async () => {
      // The dialog's own host (its `hostClient` prop) no longer has the
      // profile - the real tombstone this fix must catch.
      dialogMocks.providersByClient.set(TARGET_HOST_CLIENT, [
        claudeState([profile("ambient", "ambient", "Terminal account")]),
      ]);
      // The decoy "active host" still has it alive. If the dialog ever
      // silently fell back to reading from an app-wide active-host client,
      // this would wrongly preserve a dead id.
      dialogMocks.providersByClient.set(DECOY_ACTIVE_HOST_CLIENT, [
        claudeState([
          profile("ambient", "ambient", "Terminal account"),
          profile("work-uuid", "managed", "Work"),
        ]),
      ]);
      dialogMocks.create.mockResolvedValue("forked-agent");
      render(
        <TerminalAgentForkDialog
          open
          target={{
            sourceAgent: sourceAgentWithProfile("work-uuid"),
            workspaceSeed: emptyWorkspaceSeed(),
          }}
          epicId="epic-test"
          tabId="tab-test"
          hostId="host-test"
          hostClient={TARGET_HOST_CLIENT}
          onOpenChange={() => undefined}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Fork" }));

      await waitFor(() => {
        expect(dialogMocks.create).toHaveBeenCalled();
      });
      expect(dialogMocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: null }),
      );
    });
  });
});
