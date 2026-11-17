// No host in the path, so these work with the bot's host asleep. Runs in desktop
// main or the phone's shell (traycer-server's CORS does not take the renderer).
// A refusal carries the server's words only when they hold nothing the request did.
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  botDeleteResponseSchema,
  botReplyModeSchema,
  botUpdateRunSettingsRequestSchema,
  type BotDeleteRequest,
  type BotUpdateReplyModeRequest,
  type BotUpdateRunSettingsRequest,
} from "@traycer/protocol/host/bot/schemas";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import type { EnvironmentTransport } from "../environment/environment-cloud";
import { refusalMessageWithout } from "../environment/configuration-secrets";

/** The writes run on the server's `standard` forward tier (60 s); the margin lets its own answer arrive first. */
const BOT_SETUP_TIMEOUT_MS = 70_000;

export type BotSetupFailure =
  | { readonly kind: "unauthorized" }
  | {
      readonly kind: "refused";
      readonly status: number;
      readonly message: string;
    }
  | { readonly kind: "unavailable" }
  | { readonly kind: "no_response" };

export interface BotSetupRow {
  readonly botId: string;
  readonly harness: string;
  readonly model: string;
  readonly effort: string | null;
  readonly profile: string | null;
  readonly replyMode: "direct" | "thread";
}

export type BotSetupWriteResult =
  | { readonly kind: "ok"; readonly bot: BotSetupRow }
  | BotSetupFailure;

/** `deleted` is false when the bot was already archived, which is not a failure. */
export type BotDeleteResult =
  | { readonly kind: "ok"; readonly deleted: boolean }
  | BotSetupFailure;

const botSetupRowAnswerSchema = lazySchema(() =>
  z.object({
    bot: botUpdateRunSettingsRequestSchema.extend({
      replyMode: botReplyModeSchema,
    }),
  }),
);

type BotSetupRoute = "update-run-settings" | "update-reply-mode" | "delete";

type PostResult =
  | { readonly kind: "ok"; readonly body: unknown }
  | BotSetupFailure;

/**
 * `proxyToken`: the IAP id-token a staging desktop's main mints, sent as
 * `Proxy-Authorization`; every other caller passes `null`.
 */
async function post(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  transport: EnvironmentTransport,
  route: BotSetupRoute,
  body: object,
): Promise<PostResult> {
  const base = serverBaseUrl.endsWith("/")
    ? serverBaseUrl
    : `${serverBaseUrl}/`;
  const headers: Record<string, string> =
    proxyToken === null
      ? {}
      : { "Proxy-Authorization": `Bearer ${proxyToken}` };
  headers.Authorization = `Bearer ${bearerToken}`;
  headers.Accept = "application/json";
  headers["Content-Type"] = "application/json";
  const abort = composeRequestAbort(null, BOT_SETUP_TIMEOUT_MS);
  let answer: { readonly status: number; readonly text: string | null };
  try {
    answer = await untilAborted(
      transport({
        url: new URL(`api/bots/${route}`, base).toString(),
        method: "POST",
        headers,
        body,
        signal: abort.signal,
      }),
      abort.signal,
    );
  } catch {
    return { kind: "no_response" };
  } finally {
    abort.clear();
  }
  const parsed = jsonOrNull(answer.text);
  if (answer.status === 401) return { kind: "unauthorized" };
  if (answer.status >= 400 && answer.status < 500) {
    return {
      kind: "refused",
      status: answer.status,
      // Both credentials are withheld from the server's text, which reaches the person
      // and the app's log.
      message: refusalMessageWithout(
        parsed,
        proxyToken === null ? [bearerToken] : [bearerToken, proxyToken],
      ),
    };
  }
  if (answer.status < 200 || answer.status >= 300) {
    return { kind: "unavailable" };
  }
  return { kind: "ok", body: parsed };
}

function jsonOrNull(text: string | null): unknown {
  if (text === null || text.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

function rowOf(result: PostResult): BotSetupWriteResult {
  if (result.kind !== "ok") return result;
  const parsed = botSetupRowAnswerSchema.safeParse(result.body);
  return parsed.success
    ? { kind: "ok", bot: parsed.data.bot }
    : { kind: "unavailable" };
}

export async function updateBotRunSettingsViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  transport: EnvironmentTransport,
  request: BotUpdateRunSettingsRequest,
): Promise<BotSetupWriteResult> {
  return rowOf(
    await post(
      serverBaseUrl,
      bearerToken,
      proxyToken,
      transport,
      "update-run-settings",
      {
        botId: request.botId,
        harness: request.harness,
        model: request.model,
        effort: request.effort,
        profile: request.profile,
      },
    ),
  );
}

export async function updateBotReplyModeViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  transport: EnvironmentTransport,
  request: BotUpdateReplyModeRequest,
): Promise<BotSetupWriteResult> {
  return rowOf(
    await post(
      serverBaseUrl,
      bearerToken,
      proxyToken,
      transport,
      "update-reply-mode",
      { botId: request.botId, replyMode: request.replyMode },
    ),
  );
}

/** The answer's notices for the bot's automations reach its bound computer on its bots read. */
export async function deleteBotViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  transport: EnvironmentTransport,
  request: BotDeleteRequest,
): Promise<BotDeleteResult> {
  const result = await post(
    serverBaseUrl,
    bearerToken,
    proxyToken,
    transport,
    "delete",
    { botId: request.botId },
  );
  if (result.kind !== "ok") return result;
  const parsed = botDeleteResponseSchema.safeParse(result.body);
  return parsed.success
    ? { kind: "ok", deleted: parsed.data.deleted }
    : { kind: "unavailable" };
}
