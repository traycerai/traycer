import type { ChatSessionAnchor } from "@traycer/protocol/persistence/epic/schemas";
import { useChatAccountWaitAnchor } from "./use-chat-account-wait";
import { useFocusActions } from "@/hooks/home-focus/use-focus-actions";
import { useStore } from "zustand";
import { commitProfileSelection } from "@/stores/composer/commit-selection";
import type { ProvidersListResponse } from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { useState, type ReactNode } from "react";
import type {
  ProvidersPreviewProfileMoveRequest,
  ProvidersPreviewProfileMoveResponse,
} from "@traycer/protocol/host/profile-move-schemas";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { ChatComposerBannerPortal } from "@/components/chat/composer/chat-composer-banner-portal";
import { useReadingWidthStyle } from "@/lib/layout-overrides";
import { cn } from "@/lib/utils";
import type { ChatAccountWait } from "@traycer/protocol/host/agent/gui/subscribe";
import { providerIdSchema } from "@traycer/protocol/host/provider-ids";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { Button } from "@/components/ui/button";
import { ProfileDropdownWithTrigger } from "@/components/providers/profile-dropdown";
import { ProfileMoveDialog } from "@/components/providers/profile-move-dialog";
import {
  PERSON_NOTICE_TEXT,
  REMOVED_PROFILE_PIN_TEXT,
  SIGN_IN_AGAIN_DIALOG_TITLE,
} from "@/components/providers/profile-sync-copy";
import {
  listOffersSignIns,
  profileDisplayLabel,
  removedProfilesForProvider,
  resolvedProfileRow,
  resolveProfilePin,
  type RemovedProviderProfile,
} from "@/components/providers/provider-profile-model";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { carryViewedHostIntoSettingsScope } from "@/components/settings/host-scope/carry-viewed-host-into-settings";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import {
  guiHarnessIdToProviderId,
  providerDisplayName,
  providerIdToGuiHarnessId,
} from "@/lib/provider-ordering";
import type { HostRpcRegistry } from "@/lib/host";

function AccountWaitCard({
  wait,
  client,
  hostId,
  toolbarStore,
  canAct,
  list,
  onMove,
  epicId,
  chatId,
}: {
  readonly wait: ChatAccountWait;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly toolbarStore: ComposerToolbarStore;
  readonly canAct: boolean;
  readonly list: ProvidersListResponse | undefined;
  readonly epicId: string | null;
  readonly chatId: string;
  readonly onMove: (session: MoveSession) => void;
}) {
  const anchor = useChatAccountWaitAnchor(epicId, chatId, hostId);
  const selection = useStore(toolbarStore, (state) => state.selection);
  const { profiles, profile, sourceLabel, source } = accountWaitProfile({
    list,
    wait,
    harnessId: selection.harnessId,
    anchor,
    hostId,
  });
  const pickerProviderId = guiHarnessIdToProviderId(selection.harnessId);
  const pickerProvider = list?.providers.find(
    (row) => row.providerId === pickerProviderId,
  );
  const pickerProfiles = pickerProvider?.profiles ?? [];
  const previewSupported = useHostSupportsMethod(
    hostId,
    "providers.previewProfileMove",
  );
  const commitSupported = useHostSupportsMethod(
    hostId,
    "providers.commitProfileMove",
  );
  const { openSettings } = useSystemTabModalActions();
  const signIn = (): void => {
    if (profile === null) return;
    carryViewedHostIntoSettingsScope(hostId);
    useProvidersFocusStore.getState().setProfileFocus({
      harnessId:
        source === null
          ? selection.harnessId
          : providerIdToGuiHarnessId(source.providerId),
      hostId,
      profileId: profile.profileId,
      startSignIn: true,
    });
    openSettings({
      section: "providers",
      resetToGeneral: false,
      tab: null,
      draft: null,
      hostId: null,
    });
  };
  const canSignIn = wait.reason === "needs-sign-in" && profile !== null;
  const showRemovedLabel = wait.reason === "removed" && source !== null;
  const label = ACCOUNT_WAIT_NOTICE[wait.reason];
  return (
    <div className="flex w-full flex-col gap-2 rounded-lg border border-border bg-card p-3 text-ui-sm">
      <AccountWaitIdentity
        sourceLabel={sourceLabel}
        notice={label}
        showRemovedLabel={showRemovedLabel}
      />
      <div className="flex flex-wrap items-center gap-2">
        {canSignIn ? (
          <Button size="sm" onClick={signIn} disabled={!canAct}>
            {SIGN_IN_AGAIN_DIALOG_TITLE}
          </Button>
        ) : null}
        <ProfileDropdownWithTrigger
          trigger={
            <Button
              size="sm"
              variant={canSignIn ? "outline" : "default"}
              disabled={!canAct}
            >
              Choose another profile
            </Button>
          }
          providerLabel={
            pickerProvider === undefined
              ? ""
              : providerDisplayName(pickerProvider.providerId)
          }
          profiles={pickerProfiles}
          pin={resolveProfilePin(
            pickerProfiles,
            removedProfilesForProvider(list, pickerProviderId),
            selection.profileId,
          )}
          onSelectProfile={(profileId) => {
            if (!canAct) return;
            commitProfileSelection(toolbarStore, profileId);
          }}
          onCreateProfile={null}
          createProfileDisabled={false}
          createProfileDisabledReason={undefined}
          shortcutHintForIndex={() => null}
          profileEnablementPending={null}
          contentContainer={null}
          onCloseAutoFocus={null}
          usagePresentation={null}
          eligibilityControls={null}
          admissionByProfileId={null}
          showTerminalBadge
          terminalComputerName={null}
        />
        {source !== null &&
        sourceLabel !== null &&
        previewSupported &&
        commitSupported ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!canAct || client === null}
            onClick={() => {
              if (client !== null)
                onMove({ client, source, sourceLabel, profiles });
            }}
          >
            Move all waiting agents
          </Button>
        ) : null}
      </div>
    </div>
  );
}

interface MoveSession {
  readonly client: HostClient<HostRpcRegistry>;
  readonly source: ProvidersPreviewProfileMoveRequest["source"];
  readonly sourceLabel: string;
  readonly profiles: readonly ProviderProfile[];
}

/** Keeps the result dialog alive when the move clears the waiting card. */
export function AccountWaitSurface({
  wait,
  client,
  hostId,
  toolbarStore,
  canAct,
  children,
  providersList,
  epicId,
  chatId,
}: {
  readonly epicId: string | null;
  readonly chatId: string;
  readonly providersList: ProvidersListResponse | undefined;
  readonly wait: ChatAccountWait | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly toolbarStore: ComposerToolbarStore;
  readonly canAct: boolean;
  readonly children: ReactNode;
}) {
  const [move, setMove] = useState<MoveSession | null>(null);
  const readingWidth = useReadingWidthStyle();
  return (
    <>
      {wait === null ? (
        children
      ) : (
        <ChatComposerBannerPortal>
          <div className="pointer-events-none px-4">
            <div
              className={cn(
                "pointer-events-auto mx-auto w-full bg-canvas pt-4",
                readingWidth.className,
              )}
              style={{ maxWidth: readingWidth.maxWidth }}
            >
              <AccountWaitCard
                list={providersList}
                epicId={epicId}
                chatId={chatId}
                wait={wait}
                client={client}
                hostId={hostId}
                toolbarStore={toolbarStore}
                canAct={canAct}
                onMove={setMove}
              />
            </div>
          </div>
        </ChatComposerBannerPortal>
      )}
      {move === null || !listOffersSignIns(providersList) ? null : (
        <WaitingProfileMoveDialog
          client={move.client}
          source={move.source}
          sourceLabel={move.sourceLabel}
          profiles={
            providersList?.providers.find(
              (provider) => provider.providerId === move.source.providerId,
            )?.profiles ?? move.profiles
          }
          onClose={() => setMove(null)}
        />
      )}
    </>
  );
}

function accountWaitProfile({
  list,
  wait,
  harnessId,
  anchor,
  hostId,
}: {
  readonly list: ProvidersListResponse | undefined;
  readonly wait: ChatAccountWait;
  readonly harnessId: GuiHarnessId;
  readonly anchor: ChatSessionAnchor | null;
  readonly hostId: string;
}) {
  const providerId =
    wait.source?.providerId ?? guiHarnessIdToProviderId(harnessId);
  const provider = list?.providers.find((row) => row.providerId === providerId);
  const profiles = provider?.profiles ?? [];
  const profile =
    wait.source === null
      ? null
      : resolvedProfileRow(
          profiles,
          removedProfilesForProvider(list, providerId),
          wait.source.profileId,
        );
  const removedSource = removedProfilesForProvider(list, providerId).find(
    (entry) => entry.profileId === wait.source?.profileId,
  );
  const sourceLabel = accountWaitSourceLabel({
    profile,
    removedSource,
    anchor,
    hostId,
    providerId,
  });
  const parsedProvider = providerIdSchema.safeParse(wait.source?.providerId);
  const source =
    wait.source !== null && parsedProvider.success
      ? { providerId: parsedProvider.data, profileId: wait.source.profileId }
      : null;
  return { profiles, profile, sourceLabel, source };
}

function WaitingProfileMoveDialog({
  client,
  source,
  sourceLabel,
  profiles,
  onClose,
}: MoveSession & { readonly onClose: () => void }) {
  const { openAgent } = useFocusActions();
  const openTerminalControl = (
    terminal: ProvidersPreviewProfileMoveResponse["terminals"][number],
  ): void => {
    onClose();
    openAgent(terminal.epicId, terminal.agentId, terminal.hostId);
  };
  return (
    <ProfileMoveDialog
      client={client}
      source={source}
      sourceLabel={sourceLabel}
      profiles={profiles}
      onClose={onClose}
      onRestartTerminal={openTerminalControl}
    />
  );
}

const ACCOUNT_WAIT_NOTICE: Readonly<Record<ChatAccountWait["reason"], string>> =
  {
    "needs-sign-in": PERSON_NOTICE_TEXT["needs-sign-in"],
    removed: REMOVED_PROFILE_PIN_TEXT,
    "waiting-for-traycer": PERSON_NOTICE_TEXT.waiting,
  };

function AccountWaitIdentity({
  sourceLabel,
  notice,
  showRemovedLabel,
}: {
  readonly sourceLabel: string | null;
  readonly notice: string;
  readonly showRemovedLabel: boolean;
}) {
  if (sourceLabel !== null)
    return (
      <>
        <strong>{sourceLabel}</strong>
        <div className="text-muted-foreground">{notice}</div>
      </>
    );
  return showRemovedLabel ? (
    <div className="text-muted-foreground">{REMOVED_PROFILE_PIN_TEXT}</div>
  ) : null;
}

function accountWaitSourceLabel({
  profile,
  removedSource,
  anchor,
  hostId,
  providerId,
}: {
  readonly profile: ProviderProfile | null;
  readonly removedSource: RemovedProviderProfile | undefined;
  readonly anchor: ChatSessionAnchor | null;
  readonly hostId: string;
  readonly providerId: string | null;
}): string | null {
  if (profile !== null) return profileDisplayLabel(profile);
  if (removedSource === undefined || anchor === null) return null;
  if (
    anchor.hostId !== hostId ||
    guiHarnessIdToProviderId(anchor.harnessId) !== providerId
  )
    return null;
  if (anchor.profileId === null) return null;
  if (
    anchor.profileId !== removedSource.profileId &&
    !removedSource.aliases.includes(anchor.profileId)
  )
    return null;
  const label = anchor.labelSnapshot;
  if (label === null || label.trim().length === 0) return null;
  if (label === anchor.profileId || label === removedSource.profileId)
    return null;
  return label;
}
