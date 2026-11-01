import { useEffect } from "react";
import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { SlackAppView } from "@traycer/protocol/host/slack-app";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { botSlackQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBotSlackPendingInstallStore } from "@/stores/bots/bot-slack-pending-install-store";
import { LINK_LOGIN_STATUS_POLL_MS } from "@/hooks/auth/use-link-login-status-query";
import { BotSlackAppError } from "@/hooks/bots/bot-slack-app-error";

const READ_FAILED_LINE = "Couldn't read this bot's Slack settings.";

/** A transport failure is tried again; an answer the server gave is not. */
function retryTransport(failureCount: number, error: Error): boolean {
  return (
    error instanceof BotSlackAppError &&
    error.failure.kind === "network-error" &&
    failureCount < 2
  );
}

function slackAppQueryOptions(input: {
  readonly auth: AuthService | null;
  readonly userId: string | null;
  readonly botId: string;
  readonly enabled: boolean;
  /** An install is pending: read on an interval too. */
  readonly watching: boolean;
}) {
  const { auth, userId, botId, enabled, watching } = input;
  if (auth === null) {
    return queryOptions<SlackAppView | null>({
      queryKey: botSlackQueryKeys.missing(),
      queryFn: () => Promise.resolve(null),
      enabled: false,
    });
  }
  return queryOptions<SlackAppView | null>({
    queryKey: botSlackQueryKeys.app(auth, userId, botId),
    queryFn: async () => {
      const result = await auth.readSlackApp(botId);
      if (result.kind === "ok") return result.app;
      throw new BotSlackAppError(result, READ_FAILED_LINE);
    },
    enabled,
    retry: retryTransport,
    // Slack or another member can change the app at any time, and nothing
    // tells this client: every mount and every focus reads it again.
    staleTime: 0,
    refetchOnWindowFocus: true,
    // While an install is pending: Slack's consent page sends nothing back,
    // and the person is in their browser, so the read also runs on the
    // link-login watch's cadence with the window in the background.
    refetchInterval: watching ? LINK_LOGIN_STATUS_POLL_MS : false,
    refetchIntervalInBackground: watching,
  });
}

/**
 * `POST /api/slack/apps/read`: the bot's Slack app as its members see it,
 * `null` before one is registered. Watches the app while an install the
 * person started is pending (`bot-slack-pending-install-store`), and ends
 * that wait when an answer or the URL's expiry says it is over.
 */
export function useBotSlackAppQuery(
  botId: string,
): UseQueryResult<SlackAppView | null> {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const expiresAt = useBotSlackPendingInstallStore((s) =>
    Object.hasOwn(s.entries, botId) ? s.entries[botId].expiresAt : null,
  );
  const settle = useBotSlackPendingInstallStore((s) => s.settle);
  const expire = useBotSlackPendingInstallStore((s) => s.expire);
  const query = useQuery(
    slackAppQueryOptions({
      auth,
      userId,
      botId,
      enabled: signedIn,
      watching: expiresAt !== null,
    }),
  );
  const app = query.data;
  useEffect(() => {
    if (app !== undefined) settle(botId, app, Date.now());
  }, [app, botId, settle]);
  useEffect(() => {
    if (expiresAt === null) return undefined;
    const timer = window.setTimeout(
      () => expire(botId, expiresAt),
      Math.max(0, expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [botId, expire, expiresAt]);
  return query;
}

/**
 * `POST /api/slack/apps/manifest`: the JSON text the bot's Slack app is
 * created from, composed by the server; the panel reads it while the bot
 * has no app.
 */
export function useBotSlackManifestQuery(
  botId: string,
): UseQueryResult<string | null> {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  return useQuery<string | null>(
    auth === null
      ? {
          queryKey: botSlackQueryKeys.missing(),
          queryFn: () => Promise.resolve(null),
          enabled: false,
        }
      : {
          queryKey: botSlackQueryKeys.manifest(auth, userId, botId),
          queryFn: async () => {
            const result = await auth.getSlackAppManifest(botId);
            if (result.kind === "ok") return result.manifest;
            throw new BotSlackAppError(result, READ_FAILED_LINE);
          },
          enabled: signedIn,
          retry: retryTransport,
        },
  );
}
