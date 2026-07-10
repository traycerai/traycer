import "../../../../__tests__/test-browser-apis";
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
 * F4 (durability audit), tombstone-display surface: a user message's
 * `sessionAnchor.labelSnapshot` is a snapshot taken at anchor-mint time - it
 * can carry whatever hostile content a profile label held back then, and
 * `chat-message-user-body.tsx` renders it verbatim as
 * "Ran on {label} (removed)" with no truncate/escape wrapper of its own
 * (only plain JSX text interpolation - see the `dangerouslySetInnerHTML`
 * grep note in the sibling `profile-durability-f4-hostile-labels.test.tsx`).
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

const VERY_LONG_LABEL = "B".repeat(2000);
const HTML_LOOKING_LABEL = '<img src=x onerror="alert(1)">';

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
    // The provider HAS enumerated profiles (non-empty, so
    // `resolveTombstonedProfileLabel` doesn't bail out as "flag off / not
    // enumerated") - the removed profile is simply absent from that list,
    // which is exactly what makes it tombstoned.
    profiles: [ambient],
  };
}

function anchorWithLabelSnapshot(labelSnapshot: string): ChatSessionAnchor {
  return {
    harnessId: "claude",
    hostId: "host-1",
    sessionId: "session-1",
    sessionWorkspaceSnapshot: {
      workspaceKind: "session-snapshot",
      primaryWorkspace: "/repo",
      secondaryWorkspaces: [],
    },
    claudeMessageUuid: "uuid-1",
    createdAt: 100,
    coveredUntilMessageId: null,
    profileId: "removed-uuid",
    labelSnapshot,
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

function renderTombstoned(labelSnapshot: string) {
  return render(
    <TombstonedProfileProvider providers={[claudeStateWithoutProfile()]}>
      <ChatExpansionTestProviders tileInstanceId="tombstone-f4-tile">
        <TooltipProvider>
          <UserMessageBody
            actions={null}
            message={plainUserMessage(anchorWithLabelSnapshot(labelSnapshot))}
          />
        </TooltipProvider>
      </ChatExpansionTestProviders>
    </TombstonedProfileProvider>,
  );
}

describe("F4: hostile profile labels - tombstone display", () => {
  afterEach(() => cleanup());

  it("renders a very long snapshotted label without crashing", () => {
    const { container } = renderTombstoned(VERY_LONG_LABEL);
    expect(
      screen.getByText(`Ran on ${VERY_LONG_LABEL} (removed)`),
    ).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders an HTML-looking snapshotted label as literal text, no injected <img>", () => {
    const { container } = renderTombstoned(HTML_LOOKING_LABEL);
    expect(
      screen.getByText(`Ran on ${HTML_LOOKING_LABEL} (removed)`),
    ).not.toBeNull();
    // If this were ever rendered via dangerouslySetInnerHTML, an <img> tag
    // would materialize as a real DOM element here instead of literal text.
    expect(container.querySelector("img")).toBeNull();
  });
});
