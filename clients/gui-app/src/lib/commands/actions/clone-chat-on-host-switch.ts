import type { IHostDirectoryService } from "@traycer-clients/shared/host-client/host-runtime";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { buildTransientHostClient } from "@/hooks/host/use-host-client-for";
import type { CreateChatMutationInput } from "@/hooks/epic/use-epic-chat-mutations";
import {
  openCreatedChatWhenProjected,
  openCreatedChatWhenProjectedWithNavigation,
  openNewChatInActiveTile,
  type CancelFn,
  type CreateChatCommand,
} from "@/lib/commands/actions/new-chat";
import { resolveClonedChatSettings } from "@/lib/commands/actions/resolve-cloned-chat-settings";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/**
 * Clone-not-migrate flow for switching a chat tab's bound host: chat tabs
 * are host-bound for life (see CLAUDE.md), so we swap the bound host and
 * spin up a sibling chat on it, leaving the original tab untouched. Returns
 * the same caller-owned cancel as `openNewChatInActiveTile`.
 *
 * ## History carries over (chat-sync-v2 ticket 34B1)
 *
 * The sibling is a latest-checkpoint FORK of the source chat
 * (`forkSource: {boundary: "latest"}`), not an empty chat: the host resolves
 * the boundary itself via `buildLatestCheckpointForkSeed` against the
 * source's best-available transcript (store first, doc second), which is
 * exactly what lets this flow carry history for a source whose owner has
 * gone unreachable - the client cannot read the source to name a precise
 * `assistantMessageId` the way the manual fork dialog does, only the chat.
 *
 * A source with no assistant turn yet has no checkpoint to fork through; the
 * host answers that as a typed `E_FORK_CHECKPOINT_UNAVAILABLE` refusal
 * rather than failing the whole create. This flow retries EXACTLY once,
 * without `forkSource`, so the clone still lands - settings-only, same as
 * before ticket 34B1 - with a toast explaining why history did not come
 * along. The retry is structurally single-shot: a request with no
 * `forkSource` cannot produce this refusal, so the retry's own error
 * handler has nothing left to retry on (see `openWithForkSource` below).
 */
export interface CloneChatOnHostSwitchArgs {
  readonly epicId: string;
  readonly tabId: string;
  /** The chat being cloned - the fork source on the target host. */
  readonly sourceChatId: string;
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
  /** Fired when the source has no assistant checkpoint yet, right before the
   *  settings-only retry fires - the clone still proceeds, just without
   *  history. */
  readonly onHistoryUnavailable: () => void;
  readonly navigateNestedFocus: NavigateNestedFocus | null;
}

export function cloneChatOnHostSwitch(
  args: CloneChatOnHostSwitchArgs,
): CancelFn {
  args.directory.selectById(args.targetHostId);

  let cancelled = false;
  let innerCancel: CancelFn | null = null;

  const openWithForkSource = (
    settings: ChatRunSettings | null,
    forkSource: CreateChatMutationInput["forkSource"] | null,
  ): void => {
    if (cancelled) return;
    innerCancel = openNewChatInActiveTile({
      epicId: args.epicId,
      tabId: args.tabId,
      hostId: args.targetHostId,
      worktreeIntent: null,
      settings,
      forkSource,
      source: "direct_ui",
      createChat: args.createChat,
      onCreateError:
        forkSource === null
          ? // No `forkSource` on this attempt ⇒ no checkpoint to be
            // unavailable ⇒ nothing left for this handler to retry on.
            // Structurally single-shot, not merely by convention.
            () => undefined
          : (error: HostRpcError) => {
              if (error.code !== "E_FORK_CHECKPOINT_UNAVAILABLE") return;
              args.onHistoryUnavailable();
              openWithForkSource(settings, null);
            },
      openWhenProjected: (intent) => {
        Analytics.getInstance().track(AnalyticsEvent.ChatForked, {
          source: "direct_ui",
          include_history: forkSource !== null,
        });
        return args.navigateNestedFocus === null
          ? openCreatedChatWhenProjected(intent)
          : openCreatedChatWhenProjectedWithNavigation({
              intent,
              navigateNestedFocus: args.navigateNestedFocus,
            });
      },
    });
  };

  void resolveSettingsForClone(args).then((settings) => {
    openWithForkSource(settings, {
      boundary: "latest",
      sourceChatId: args.sourceChatId,
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
