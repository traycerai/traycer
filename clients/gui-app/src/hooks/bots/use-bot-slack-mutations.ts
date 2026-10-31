import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  SlackAppRegisterRequest,
  SlackAppView,
} from "@traycer/protocol/host/slack-app";
import type { SlackAppFailure } from "@traycer-clients/shared/host-client/slack-app";
import { useHostBinding } from "@/lib/host";
import { botSlackMutationKeys, botSlackQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBotSlackPendingInstallStore } from "@/stores/bots/bot-slack-pending-install-store";
import { BotSlackAppError } from "@/hooks/bots/bot-slack-app-error";

const WRITE_FAILED_LINE = "Couldn't update Slack settings. Try again.";

const SIGNED_OUT: SlackAppFailure = { kind: "unauthorized" };

/** The bot's app read, refreshed after a write: the panel renders from it, never from the write's answer. */
function useInvalidateBotSlackApp(botId: string): () => Promise<void> {
  const queryClient = useQueryClient();
  const binding = useHostBinding();
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  return () =>
    binding === null
      ? Promise.resolve()
      : queryClient.invalidateQueries({
          queryKey: botSlackQueryKeys.app(binding.auth, userId, botId),
        });
}

/**
 * `POST /api/slack/apps/register`: the four credentials the person pasted.
 * A refusal is shown in place (no toast). The variables carry two secrets,
 * so the mutation is dropped from the cache as soon as its caller resets it
 * (`gcTime: 0`); the panel resets it on settlement.
 */
export function useBotSlackRegisterMutation(
  botId: string,
): UseMutationResult<SlackAppView, Error, SlackAppRegisterRequest> {
  const binding = useHostBinding();
  const clear = useBotSlackPendingInstallStore((s) => s.clear);
  const invalidate = useInvalidateBotSlackApp(botId);
  return useMutation({
    mutationKey: botSlackMutationKeys.register(botId),
    mutationFn: async (request) => {
      if (binding === null) {
        throw new BotSlackAppError(SIGNED_OUT, WRITE_FAILED_LINE);
      }
      const result = await binding.auth.registerSlackApp(request);
      if (result.kind === "ok") return result.app;
      throw new BotSlackAppError(result, WRITE_FAILED_LINE);
    },
    gcTime: 0,
    onSuccess: async () => {
      // A new registration replaces the app's credentials, so an install URL
      // minted before it no longer leads anywhere.
      clear(botId);
      await invalidate();
    },
  });
}

export interface BotSlackInstallUrl {
  readonly url: string;
  readonly expiresAt: number;
}

/**
 * `POST /api/slack/apps/install-url`: mints Slack's consent URL and starts
 * the wait for the install (`bot-slack-pending-install-store`); the caller
 * opens the URL. `baselineInstalledAt` is the app's `installedAt` as the
 * panel shows it now.
 */
export function useBotSlackInstallUrlMutation(
  botId: string,
): UseMutationResult<
  BotSlackInstallUrl,
  Error,
  { readonly baselineInstalledAt: number | null }
> {
  const binding = useHostBinding();
  const begin = useBotSlackPendingInstallStore((s) => s.begin);
  return useMutation({
    mutationKey: botSlackMutationKeys.installUrl(botId),
    mutationFn: async () => {
      if (binding === null) {
        throw new BotSlackAppError(SIGNED_OUT, WRITE_FAILED_LINE);
      }
      const result = await binding.auth.mintSlackAppInstallUrl(botId);
      if (result.kind === "ok") {
        return { url: result.url, expiresAt: result.expiresAt };
      }
      throw new BotSlackAppError(result, WRITE_FAILED_LINE);
    },
    onSuccess: (minted, variables) => {
      begin({
        botId,
        expiresAt: minted.expiresAt,
        baselineInstalledAt: variables.baselineInstalledAt,
      });
    },
  });
}

/**
 * `POST /api/slack/apps/disconnect`: clears and revokes the bot's install;
 * the registration stays. Ends any pending install's wait.
 */
export function useBotSlackDisconnectMutation(
  botId: string,
): UseMutationResult<SlackAppView, Error, void> {
  const binding = useHostBinding();
  const clear = useBotSlackPendingInstallStore((s) => s.clear);
  const invalidate = useInvalidateBotSlackApp(botId);
  return useMutation({
    mutationKey: botSlackMutationKeys.disconnect(botId),
    mutationFn: async () => {
      if (binding === null) {
        throw new BotSlackAppError(SIGNED_OUT, WRITE_FAILED_LINE);
      }
      const result = await binding.auth.disconnectSlackApp(botId);
      if (result.kind === "ok") return result.app;
      throw new BotSlackAppError(result, WRITE_FAILED_LINE);
    },
    onSuccess: async () => {
      clear(botId);
      await invalidate();
    },
  });
}
