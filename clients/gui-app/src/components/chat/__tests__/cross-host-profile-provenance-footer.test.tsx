import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionAnchor } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { UserMessageBody } from "@/components/chat/chat-message-user-body";
import { TombstonedProfileProvider } from "@/components/chat/tombstoned-profile-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

/**
 * A profile id is HOST-LOCAL - it names a managed config dir on one machine -
 * so an anchor a fork/clone carried here from another host can never match
 * this host's `providers.list`, and the old "(removed)" verdict accused the
 * user of deleting a profile that is alive and well on the other machine.
 *
 * The provenance itself stays: which account a past turn ran on is useful.
 * Only the removal claim is dropped, and only for a FOREIGN anchor - a
 * same-host miss is a genuine deletion and still says "(removed)".
 */

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifact: () => null,
  useOpenEpicId: () => "epic-1",
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/components/chat/composer/picker/use-composer-picker-items", () => ({
  useComposerPickerItems: () => undefined,
}));

const THIS_HOST = "host-1";
const OTHER_HOST = "host-2";

function claudeStateWithoutProfile(): ProviderCliState {
  const ambient: ProviderProfile = {
    profileId: "ambient",
    kind: "ambient",
    authType: "oauth",
    label: "Terminal account",
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
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [ambient],
  };
}

function anchorFromHost(hostId: string): ChatSessionAnchor {
  return {
    harnessId: "claude",
    hostId,
    sessionId: "session-1",
    sessionWorkspaceSnapshot: {
      workspaceKind: "session-snapshot",
      primaryWorkspace: "/repo",
      secondaryWorkspaces: [],
    },
    claudeMessageUuid: "uuid-1",
    turnTailUuid: null,
    createdAt: 100,
    coveredUntilMessageId: null,
    profileId: "removed-uuid",
    labelSnapshot: "Work",
    accountUuid: null,
    accentColor: null,
  };
}

function plainUserMessage(sessionAnchor: ChatSessionAnchor): ChatMessageModel {
  return {
    id: "message-1",
    role: "user",
    content: "hello",
    segments: [],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: 1,
    completedAt: null,
    stopped: null,
    persistentMessageId: "message-1",
    senderLabel: "You",
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor,
    steerBadge: null,
  };
}

function renderAnchoredMessage(anchorHostId: string) {
  return render(
    <TombstonedProfileProvider
      providers={[claudeStateWithoutProfile()]}
      hostId={THIS_HOST}
    >
      <ChatExpansionTestProviders tileInstanceId="cross-host-provenance-tile">
        <TooltipProvider>
          <UserMessageBody
            actions={null}
            message={plainUserMessage(anchorFromHost(anchorHostId))}
          />
        </TooltipProvider>
      </ChatExpansionTestProviders>
    </TombstonedProfileProvider>,
  );
}

describe("cross-host profile provenance footer", () => {
  afterEach(() => cleanup());

  it("drops the removal claim for a turn that ran on another host", () => {
    renderAnchoredMessage(OTHER_HOST);
    expect(screen.getByText("Ran on Work")).not.toBeNull();
    expect(screen.queryByText("Ran on Work (removed)")).toBeNull();
  });

  it("still reports a genuine deletion on the host that owned the profile", () => {
    renderAnchoredMessage(THIS_HOST);
    expect(screen.getByText("Ran on Work (removed)")).not.toBeNull();
    expect(screen.queryByText("Ran on Work")).toBeNull();
  });
});
