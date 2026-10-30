import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * Client-side mirror of traycer-server's Slack app routes
 * (`POST /api/slack/apps/{register,read,manifest,install-url,disconnect}`),
 * the calls a bot's members make with their own bearer to connect the bot to
 * Slack from its settings.
 *
 * ⚠️ CROSS-REPO MIRROR of `packages/common/src/slack/wire.ts` (the member
 * routes' request and response schemas) and the refusals of
 * `traycer-server/src/services/slack/slack-errors.ts`. The OSS clients cannot
 * import the server's types, so the wire shape is mirrored here.
 *
 * Not `.strict()`, as `sandbox-control.ts` is not: the routes are read only
 * by builds that know them, and a tolerant reader lets the server add a field
 * without a lockstep client release. The install state is a closed
 * vocabulary and still fails a parse on a value this build does not know.
 */

/** A Slack id: a workspace, user or app id (`T…`, `U…`, `A…`). */
const slackIdSchema = lazySchema(() =>
  z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Z0-9]+$/),
);

const botIdSchema = lazySchema(() => z.string().min(1).max(36));

/** `POST /api/slack/apps/register`: the credentials from the app's Basic Information page. */
export interface SlackAppRegisterRequest {
  readonly botId: string;
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly signingSecret: string;
}

export const slackAppRegisterRequestSchema: z.ZodType<SlackAppRegisterRequest> =
  lazySchema(() =>
    z.object({
      botId: botIdSchema,
      appId: slackIdSchema,
      clientId: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[0-9.]+$/),
      clientSecret: z.string().min(1).max(256),
      signingSecret: z.string().min(1).max(256),
    }),
  );

/** The bot id alone: read, manifest, install URL and disconnect. */
export interface SlackAppBotRequest {
  readonly botId: string;
}

export const slackAppBotRequestSchema: z.ZodType<SlackAppBotRequest> =
  lazySchema(() => z.object({ botId: botIdSchema }));

/**
 * `registered`: credentials stored, never installed. `installed`: a
 * workspace holds the app. `uninstalled`: it was installed and Slack or a
 * member removed it; the credentials stay, so a new install needs no new
 * registration.
 */
export const SLACK_INSTALL_STATES = [
  "registered",
  "installed",
  "uninstalled",
] as const;
export type SlackInstallState = (typeof SLACK_INSTALL_STATES)[number];

/** A bot's app as its members see it. No secret is ever part of it. */
export interface SlackAppView {
  readonly botId: string;
  readonly appId: string;
  readonly clientId: string;
  readonly installState: SlackInstallState;
  readonly teamId: string | null;
  readonly teamName: string | null;
  readonly botUserId: string | null;
  /** Epoch ms of the latest install; kept through an uninstall. */
  readonly installedAt: number | null;
}

export const slackAppViewSchema: z.ZodType<SlackAppView> = lazySchema(() =>
  z.object({
    botId: botIdSchema,
    appId: slackIdSchema,
    clientId: z.string(),
    installState: z.enum(SLACK_INSTALL_STATES),
    teamId: slackIdSchema.nullable(),
    teamName: z.string().nullable(),
    botUserId: slackIdSchema.nullable(),
    installedAt: z.number().int().nullable(),
  }),
);

/** `read`: the bot's app, or `null` when none is registered. */
export interface SlackAppReadResponse {
  readonly app: SlackAppView | null;
}

export const slackAppReadResponseSchema: z.ZodType<SlackAppReadResponse> =
  lazySchema(() => z.object({ app: slackAppViewSchema.nullable() }));

/** `register` and `disconnect`: the app as the write left it. */
export interface SlackAppResponse {
  readonly app: SlackAppView;
}

export const slackAppResponseSchema: z.ZodType<SlackAppResponse> = lazySchema(
  () => z.object({ app: slackAppViewSchema }),
);

/** `manifest`: the JSON text a member creates the bot's app from in Slack. */
export interface SlackAppManifestResponse {
  readonly manifest: string;
}

export const slackAppManifestResponseSchema: z.ZodType<SlackAppManifestResponse> =
  lazySchema(() => z.object({ manifest: z.string() }));

/** `install-url`: Slack's consent URL, single use, good until `expiresAt` (epoch ms). */
export interface SlackAppInstallUrlResponse {
  readonly url: string;
  readonly expiresAt: number;
}

export const slackAppInstallUrlResponseSchema: z.ZodType<SlackAppInstallUrlResponse> =
  lazySchema(() => z.object({ url: z.string(), expiresAt: z.number().int() }));

/**
 * The server's error body (`{ statusCode, error, code }`). `code` is the word
 * a client branches on; `error` is the server's own sentence, which the
 * clients do not show.
 */
export interface SlackAppRefusalBody {
  readonly code: string;
}

export const slackAppRefusalBodySchema: z.ZodType<SlackAppRefusalBody> =
  lazySchema(() => z.object({ code: z.string().min(1) }));

/** This deployment has no public base URL for Slack (`503`): manifest and install. */
export const SLACK_APP_REFUSAL_NOT_CONFIGURED = "slack_not_configured";
/** The bot has no Slack app registered (`404`): install URL and disconnect. */
export const SLACK_APP_REFUSAL_APP_NOT_FOUND = "slack_app_not_found";
/** The app id is registered to another bot (`409`): register. */
export const SLACK_APP_REFUSAL_APP_TAKEN = "slack_app_taken";
/** The caller is not a member of the bot, or the bot is gone (`404`): every route. */
export const SLACK_APP_REFUSAL_BOT_NOT_FOUND = "NOT_FOUND";
