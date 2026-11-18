import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionAnchor } from "@traycer/protocol/persistence/epic/schemas";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { UserMessageBody } from "@/components/chat/chat-message-user-body";
import { TombstonedProfileProvider } from "@/components/chat/tombstoned-profile-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  legacyProfile,
  pinProfile,
  providerState,
  removedEntry,
} from "@/components/providers/__tests__/profile-pin-fixtures";
import type { RemovedProviderProfile } from "@/components/providers/provider-profile-model";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

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

const HOST_ID = "desk-1";

function managed(input: {
  readonly profileId: string;
  readonly label: string;
  readonly aliases: readonly string[];
}): ProviderProfile {
  return pinProfile({
    profileId: input.profileId,
    label: input.label,
    kind: "managed",
    enabled: true,
    authStatus: "authenticated",
    aliases: input.aliases,
    personNotice: null,
    terminalOnThisComputer: false,
    otherNames: [],
  });
}

function message(profileId: string): ChatMessageModel {
  const anchor: ChatSessionAnchor = {
    harnessId: "codex",
    hostId: HOST_ID,
    sessionId: "session-1",
    sessionWorkspaceSnapshot: {
      workspaceKind: "session-snapshot",
      primaryWorkspace: "desk-folder",
      secondaryWorkspaces: [],
    },
    codexTurnId: "turn-1",
    codexUserMessageId: "user-1",
    createdAt: 100,
    coveredUntilMessageId: null,
    profileId,
    labelSnapshot: "Desk label",
    accountUuid: null,
    accentColor: null,
  };
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
    sessionAnchor: anchor,
    steerBadge: null,
  };
}

function renderFooter(input: {
  readonly profiles: readonly ProviderProfile[];
  readonly removed: readonly RemovedProviderProfile[];
  readonly profileId: string;
}): void {
  render(
    <TombstonedProfileProvider
      providers={[
        providerState({
          providerId: "codex",
          authStatus: "authenticated",
          profiles: input.profiles,
        }),
      ]}
      removedProfiles={input.removed}
      hostId={HOST_ID}
    >
      <ChatExpansionTestProviders tileInstanceId="pin-footer-tile">
        <TooltipProvider>
          <UserMessageBody actions={null} message={message(input.profileId)} />
        </TooltipProvider>
      </ChatExpansionTestProviders>
    </TombstonedProfileProvider>,
  );
}

const side = managed({ profileId: "side-row", label: "Side", aliases: [] });
const work = managed({
  profileId: "work-row",
  label: "Work",
  aliases: ["alias-work"],
});

describe("transcript footer pin", () => {
  afterEach(() => cleanup());

  it("an alias anchor draws no footer", () => {
    renderFooter({
      profiles: [side, work],
      removed: [],
      profileId: "alias-work",
    });
    expect(screen.queryByText(/Ran on/)).toBeNull();
  });

  it("a removed profile id keeps Ran on the snapshotted label", () => {
    renderFooter({
      profiles: [side, work],
      removed: [
        removedEntry({
          providerId: "codex",
          profileId: "gone-row",
          aliases: [],
        }),
      ],
      profileId: "gone-row",
    });
    expect(screen.getByText("Ran on Desk label (removed)")).toBeDefined();
  });

  it("an unknown id keeps Ran on the snapshotted label", () => {
    renderFooter({
      profiles: [side, work],
      removed: [],
      profileId: "missing-id",
    });
    expect(screen.getByText("Ran on Desk label (removed)")).toBeDefined();
  });

  it("a 10.10-shaped list draws no footer for a listed id and keeps it for an unknown id", () => {
    const olderSide = legacyProfile({
      profileId: "side-row",
      label: "Side",
      kind: "managed",
      enabled: true,
      authStatus: "authenticated",
    });
    const olderWork = legacyProfile({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      enabled: true,
      authStatus: "authenticated",
    });
    renderFooter({
      profiles: [olderSide, olderWork],
      removed: [],
      profileId: "work-row",
    });
    expect(screen.queryByText(/Ran on/)).toBeNull();
    cleanup();
    renderFooter({
      profiles: [olderSide, olderWork],
      removed: [],
      profileId: "missing-id",
    });
    expect(screen.getByText("Ran on Desk label (removed)")).toBeDefined();
  });
});
