import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  GuiHarnessId,
  GuiHarnessOption,
} from "@traycer/protocol/host/index";
import type {
  ProviderCliState,
  ProviderManagedInstallState,
} from "@traycer/protocol/host/provider-schemas";
import type { PendingSandboxSend } from "@/stores/sandboxes/pending-sandbox-send-store";

/** The pick the person made in the composer: Codex · GPT-6.1-Sol · High. */
export const PICKED_SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-6.1-sol",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

export const MESSAGE_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "fix the login bug" }],
    },
  ],
};

/** One harness row of a host's catalog; available unless an override says not. */
export function harnessRow(
  id: GuiHarnessId,
  overrides: Partial<GuiHarnessOption>,
): GuiHarnessOption {
  return {
    id,
    label: id,
    enabled: true,
    available: true,
    error: null,
    modes: ["gui", "tui"],
    requiresApiKey: false,
    supportedPermissionModes: ["supervised", "full_access"],
    nativeAutoJudge: false,
    availabilityPending: false,
    ...overrides,
  };
}

/**
 * One provider row of a host's `providers.list`. `candidates: []` is the
 * load-bearing default: nothing to fall back on, so a pack that is not
 * installed is a provider that cannot run.
 */
export function providerRow(
  providerId: ProviderCliState["providerId"],
  managedInstallState: ProviderManagedInstallState | null,
): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
    managedInstallState,
    versionVisibility: null,
    advisory: null,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
  };
}

/** A message waiting on its sandbox, as `handPendingSandboxSend` records it. */
export function pendingSend(
  overrides: Partial<PendingSandboxSend>,
): PendingSandboxSend {
  return {
    id: "send-1",
    userId: "user-1",
    epicId: "epic-1",
    request: { kind: "chat", parentId: null, placement: null },
    content: MESSAGE_CONTENT,
    text: "fix the login bug",
    settings: PICKED_SETTINGS,
    createdAt: 1_000,
    epicConfirmed: true,
    delivery: null,
    ...overrides,
  };
}
