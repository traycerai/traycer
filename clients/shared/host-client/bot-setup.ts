/**
 * A bot's settings on traycer-server (`/api/bots/*`), the app's own calls on
 * the person's sign-in: no host in the path, so they work with the bot's host
 * asleep. A sibling of `environment-directory.ts`, and it runs where that
 * runs: desktop in Electron main (traycer-server's CORS list does not take the
 * app renderer), the phone through its native request.
 *
 * Each request is sent once through the shell's `EnvironmentTransport`, which
 * never follows a redirect: a 3xx, or a browser's opaque redirect, is an
 * answered non-success. Nothing here throws, logs, or answers with any part of
 * the request; a refusal carries the server's own words only when they hold
 * nothing the request carried, and the generic words otherwise.
 */
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  botReplyModeSchema,
  botUpdateRunSettingsRequestSchema,
  type BotUpdateReplyModeRequest,
  type BotUpdateRunSettingsRequest,
} from "@traycer/protocol/host/bot/schemas";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import type { EnvironmentTransport } from "../environment/environment-cloud";
import { refusalMessageWithout } from "../environment/configuration-secrets";

/** The writes run on the server's `standard` forward tier (60 s); the margin lets its own answer arrive first. */
const BOT_SETUP_TIMEOUT_MS = 70_000;

/**
 * A bot write that did not succeed:
 * - `unauthorized`: the server refused the sign-in (401);
 * - `refused`: any other 4xx, 403 included; `message` is the server's own
 *   words as the host's forwarder answered them, bounded and holding nothing
 *   the request carried, or the generic words when it gave none;
 * - `unavailable`: a 5xx, a redirect, or an answer this build cannot read;
 * - `no_response`: nothing answered in time.
 */
export type BotSetupFailure =
  | { readonly kind: "unauthorized" }
  | {
      readonly kind: "refused";
      readonly status: number;
      readonly message: string;
    }
  | { readonly kind: "unavailable" }
  | { readonly kind: "no_response" };

/**
 * The bot's settings as a run-settings or reply-mode write left them: the
 * fields the bot's settings panel draws, and nothing else of the row.
 */
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

const botSetupRowAnswerSchema = lazySchema(() =>
  z.object({
    bot: botUpdateRunSettingsRequestSchema.extend({
      replyMode: botReplyModeSchema,
    }),
  }),
);

type BotSetupRoute = "update-run-settings" | "update-reply-mode";

type PostResult =
  | { readonly kind: "ok"; readonly body: unknown }
  | BotSetupFailure;

/**
 * `proxyToken` is the Google IAP id-token a staging desktop's main process
 * mints, sent as `Proxy-Authorization` ahead of the person's `Authorization`;
 * every other caller passes `null`.
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
      message: refusalMessageWithout(parsed, [bearerToken]),
    };
  }
  if (answer.status < 200 || answer.status >= 300) {
    return { kind: "unavailable" };
  }
  return { kind: "ok", body: parsed };
}

/** An empty or non-JSON body (a proxy's HTML page) reads as `null`. */
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

/** `POST /api/bots/update-run-settings`: the harness, model, effort and profile the bot's next turn runs on. */
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

/**
 * `POST /api/bots/update-reply-mode`: how the bot answers a post, from the
 * next post on. `direct` on a team's bot is refused (422).
 */
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
