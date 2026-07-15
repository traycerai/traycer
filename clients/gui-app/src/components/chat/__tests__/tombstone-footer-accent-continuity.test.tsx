import "../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionAnchor } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { resolveProfileAccentColor } from "@/lib/providers/profile-accent-color";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { UserMessageBody } from "@/components/chat/chat-message-user-body";
import { TombstonedProfileProvider } from "@/components/chat/tombstoned-profile-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

/**
 * T7 (accent continuity): the tombstone footer stops rendering the initials
 * `ProfileAvatarBadge` and instead renders provider icon + accent dot, with
 * the dot sourced from the anchor's `accentColor` snapshot (falling back to
 * the id-hash color for anchors minted before the field existed).
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
    profiles: [ambient],
  };
}

function anchor(accentColor: string | null): ChatSessionAnchor {
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
    labelSnapshot: "Work",
    accountUuid: null,
    accentColor,
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

function renderTombstoned(accentColor: string | null) {
  return render(
    <TombstonedProfileProvider providers={[claudeStateWithoutProfile()]}>
      <ChatExpansionTestProviders tileInstanceId="tombstone-accent-tile">
        <TooltipProvider>
          <UserMessageBody
            actions={null}
            message={plainUserMessage(anchor(accentColor))}
          />
        </TooltipProvider>
      </ChatExpansionTestProviders>
    </TombstonedProfileProvider>,
  );
}

describe("tombstone footer: accent continuity", () => {
  afterEach(() => cleanup());

  it("renders no initials avatar", () => {
    const { container } = renderTombstoned(null);
    expect(screen.getByText("Ran on Work (removed)")).not.toBeNull();
    expect(container.querySelector('[data-slot="avatar"]')).toBeNull();
    expect(container.querySelector('[data-slot="avatar-fallback"]')).toBeNull();
  });

  it("colors the accent dot from the anchor's accentColor snapshot when present", () => {
    const { container } = renderTombstoned("#ec4899");
    const dot = container.querySelector('span[aria-hidden="true"][style]');
    expect(dot).not.toBeNull();
    expect((dot as HTMLElement).style.backgroundColor).toBe(
      "rgb(236, 72, 153)",
    );
  });

  it("falls back to the id-hash color when the anchor predates the accentColor snapshot", () => {
    const { container } = renderTombstoned(null);
    const dot = container.querySelector('span[aria-hidden="true"][style]');
    expect(dot).not.toBeNull();
    const expected = resolveProfileAccentColor("removed-uuid", null);
    // Compare via a throwaway element so the expected hex and the rendered
    // `rgb(...)` (jsdom normalizes inline color styles) agree on format.
    const probe = document.createElement("span");
    probe.style.backgroundColor = expected;
    expect((dot as HTMLElement).style.backgroundColor).toBe(
      probe.style.backgroundColor,
    );
  });
});
