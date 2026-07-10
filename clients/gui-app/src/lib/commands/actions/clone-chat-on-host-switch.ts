import type { IHostDirectoryService } from "@traycer-clients/shared/host-client/host-runtime";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { buildTransientHostClient } from "@/hooks/host/use-host-client-for";
import {
  openCreatedChatWhenProjected,
  openCreatedChatWhenProjectedWithNavigation,
  openNewChatInActiveTile,
  type CancelFn,
  type CreateChatCommand,
} from "@/lib/commands/actions/new-chat";
import { resolveClonedChatSettings } from "@/lib/commands/actions/resolve-cloned-chat-settings";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";

/**
 * Clone-not-migrate flow for switching a chat tab's bound host: chat tabs
 * are host-bound for life (see CLAUDE.md), so we swap the bound host and
 * spin up a sibling chat on it, leaving the original tab untouched. Returns
 * the same caller-owned cancel as `openNewChatInActiveTile`.
 */
export interface CloneChatOnHostSwitchArgs {
  readonly epicId: string;
  readonly tabId: string;
  readonly sourceHostId: string;
  readonly targetHostId: string;
  readonly directory: IHostDirectoryService;
  readonly createChat: CreateChatCommand;
  /** The source chat's own run settings (harness/model/profile), read from
   *  the local Epic projection - `null` for a chat that never ran (host
   *  defaults, today's behavior). */
  readonly sourceSettings: ChatRunSettings | null;
  /** App-wide client used to mint throwaway clients against the source and
   *  target hosts for the `providers.list` profile-identity lookup (never
   *  bound as the active host - see `buildTransientHostClient`). */
  readonly globalClient: HostClient<HostRpcRegistry>;
  /** Fired when a non-ambient source profile could not be mapped to an
   *  equivalent on the target host (source unreachable, provider not
   *  logged in there, or no matching `accountUuid`) - the clone still
   *  proceeds, landing on the ambient login instead of failing silently. */
  readonly onProfileFallbackToAmbient: () => void;
  readonly navigateNestedFocus: NavigateNestedFocus | null;
}

export function cloneChatOnHostSwitch(
  args: CloneChatOnHostSwitchArgs,
): CancelFn {
  args.directory.selectById(args.targetHostId);

  let cancelled = false;
  let innerCancel: CancelFn | null = null;

  void resolveSettingsForClone(args).then((settings) => {
    if (cancelled) return;
    innerCancel = openNewChatInActiveTile({
      epicId: args.epicId,
      tabId: args.tabId,
      hostId: args.targetHostId,
      worktreeIntent: null,
      settings,
      createChat: args.createChat,
      openWhenProjected: (intent) =>
        args.navigateNestedFocus === null
          ? openCreatedChatWhenProjected(intent)
          : openCreatedChatWhenProjectedWithNavigation({
              intent,
              navigateNestedFocus: args.navigateNestedFocus,
            }),
    });
  });

  return () => {
    if (cancelled) return;
    cancelled = true;
    if (innerCancel !== null) {
      innerCancel();
      innerCancel = null;
    }
  };
}

async function resolveSettingsForClone(
  args: CloneChatOnHostSwitchArgs,
): Promise<ChatRunSettings | null> {
  if (args.sourceSettings === null || args.sourceSettings.profileId === null) {
    return args.sourceSettings;
  }
  const targetEntry = args.directory.findById(args.targetHostId);
  const targetClient =
    targetEntry === null
      ? null
      : buildTransientHostClient(args.globalClient, targetEntry);
  if (targetClient === null) {
    args.onProfileFallbackToAmbient();
    return { ...args.sourceSettings, profileId: null };
  }
  const sourceEntry = args.directory.findById(args.sourceHostId);
  const sourceClient =
    sourceEntry === null
      ? null
      : buildTransientHostClient(args.globalClient, sourceEntry);

  const resolved = await resolveClonedChatSettings({
    sourceSettings: args.sourceSettings,
    sourceClient,
    targetClient,
  });
  if (resolved.fallenBackToAmbient) {
    args.onProfileFallbackToAmbient();
  }
  return resolved.settings;
}
