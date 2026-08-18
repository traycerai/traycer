import type { IHostDirectoryService } from "@traycer-clients/shared/host-client/host-runtime";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  classifyHostRequestFailure,
  type HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
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
 * Which of the two client-visible ways a latest-checkpoint fork request can
 * fail this flow recovers from, if any - see the module doc below for what
 * each one means and why both retry identically.
 */
function classifyRecoverableForkFailure(
  error: HostRpcError,
): "no-checkpoint" | "host-too-old" | null {
  if (error.code === "E_FORK_CHECKPOINT_UNAVAILABLE") return "no-checkpoint";
  if (classifyHostRequestFailure(error).kind === "downgrade-unsupported") {
    return "host-too-old";
  }
  return null;
}

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
 * rather than failing the whole create. There is a SECOND, client-side-only
 * way the same request cannot be served: `epic.createChat@1.1`'s
 * `boundary: "latest"` variant has no `assistantMessageId` at all, so a
 * target host still on `@1.0` (every released host as of ticket 34B1) can
 * never receive it - the transport's same-major minor-downgrade re-parses
 * the canonical request against the host's older schema before a frame is
 * even sent, that re-parse has nothing to put in the required
 * `assistantMessageId` field, and the request fails client-side as
 * `DOWNGRADE_UNSUPPORTED` (see `classifyHostRequestFailure`). Both cases
 * mean the SAME thing to this flow - "this attempt cannot carry history" -
 * and get the SAME recovery: retry EXACTLY once, without `forkSource`, so
 * the clone still lands - settings-only, same as before ticket 34B1 - with
 * a toast explaining why history did not come along. The retry is
 * structurally single-shot: a request with no `forkSource` cannot produce
 * either failure, so the retry's own error handler has nothing left to
 * retry on (see `openWithForkSource` below).
 */
export interface CloneChatOnHostSwitchArgs {
  readonly epicId: string;
  readonly tabId: string;
  /** The chat being cloned - the fork source on the target host. */
  readonly sourceChatId: string;
  /**
   * The owner this surface was SHOWING for that chat, or `null` when it
   * genuinely does not know (chat-sync-v2 ticket 37).
   *
   * Only ever what was actually rendered - the published ref's `ownerUserId`,
   * or the owner the dead-tile fallback already derived from the live
   * artifact. Never inferred, never defaulted to the current user: the host
   * uses this as the expectation its anti-squatting check runs against when
   * it holds no registry facts, so a fabricated value would be trusted.
   */
  readonly sourceOwnerUserId: string | null;
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
  /** Fired right before the settings-only retry fires - the clone still
   *  proceeds, just without history. Two distinct causes, since the right
   *  copy differs: `"no-checkpoint"` names the SOURCE (it has not replied
   *  yet); `"host-too-old"` names the TARGET (it predates
   *  `epic.createChat@1.1` and cannot receive a checkpoint-less fork
   *  request at all - every released host today). */
  readonly onHistoryUnavailable: (
    reason: "no-checkpoint" | "host-too-old",
  ) => void;
  /** Fired when the create call fails for a reason this flow does NOT
   *  recover from - including the settings-only retry itself failing - so
   *  the caller can clear any in-flight ("cloning…") UI state. Never fired
   *  for a recoverable failure, since those retry instead of ending the
   *  flow. */
  readonly onCloneFailed: () => void;
  readonly navigateNestedFocus: NavigateNestedFocus | null;
}

export function cloneChatOnHostSwitch(
  args: CloneChatOnHostSwitchArgs,
): CancelFn {
  let cancelled = false;
  let innerCancel: CancelFn | null = null;

  const openWithForkSource = (
    settings: ChatRunSettings | null,
    forkSource: CreateChatMutationInput["forkSource"] | null,
  ): void => {
    if (cancelled) return;
    // No app-wide-selection guard any more (redesign P1.2, D6): the clone
    // does not move the app, and `createChat` is the TARGET host's mutation,
    // which validates the client it is about to send on against the
    // `hostId` this request names. A failover mid-resolution can no longer
    // land the clone on the wrong machine, because nothing about where it
    // lands is read from the app-wide selection.
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
            // unavailable and no minor to be downgrade-unsupported on ⇒
            // nothing left for this handler to retry on. Structurally
            // single-shot, not merely by convention - whatever failed here
            // is terminal.
            () => {
              if (cancelled) return;
              args.onCloneFailed();
            }
          : (error: HostRpcError) => {
              // Checked BEFORE the toast, not just before the retry: a
              // cancel that lands while this attempt's error is still in
              // flight must produce neither, not just skip the (harmless)
              // retry - the caller already told this flow to stop.
              if (cancelled) return;
              const recoverable = classifyRecoverableForkFailure(error);
              if (recoverable === null) {
                args.onCloneFailed();
                return;
              }
              args.onHistoryUnavailable(recoverable);
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

  void resolveSettingsForClone(args)
    .then((settings) => {
      openWithForkSource(settings, {
        boundary: "latest",
        sourceChatId: args.sourceChatId,
        // Ticket 37: whatever owner this surface was ACTUALLY rendering, so the
        // host's cloud tier has an expectation to check when it holds no local
        // registry facts of its own (a post-restart swept chat, a fresh
        // identity) - without it the clone silently degrades to settings-only
        // and loses the history. Passed straight through from the caller and
        // `null` when that caller genuinely does not know: a fabricated guess
        // is worse than none, because the host would trust it.
        sourceOwnerUserId: args.sourceOwnerUserId,
      });
    })
    .catch(() => {
      // A settings resolution that REJECTED (a profile lookup's transport
      // failure, not a mapping miss - those resolve to ambient) has produced
      // neither settings nor a clone. Without this arm the flow just stops,
      // which leaves the caller's "cloning…" state pending forever with no
      // clone and no terminal signal.
      if (cancelled) return;
      args.onCloneFailed();
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
