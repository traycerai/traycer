import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import { isReleasedSignInRefusal } from "@traycer-clients/shared/host-transport/released-sign-on";
import {
  localTeamAdmissionCliError,
  namedTeamAdmissionCliError,
  waitedOutBeforeOpen,
} from "./local-open-auth";
import { requireCliHostSession } from "./cli-host-tokens";
import {
  hostDoorRefusalCliError,
  hostTokenFailureCliError,
  signedOutCliError,
} from "./host-door-words";
/**
 * What the `traycer bot` commands share: finding a bot by id or title,
 * reading the environments the bots are grouped under, one `bot.subscribe`
 * snapshot, and the one line every command prints on a host that predates
 * bots.
 *
 * The host is resolved as the `agent *` commands resolve it: the local host
 * this CLI's pid metadata names (`resolveEndpoint`).
 */

import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  botListResponseSchema,
  botSubscribeServerFrameSchema,
  type BotRecord,
  type BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import { isIncompatibleCloseForMethod } from "@traycer/protocol/host-transport/stream-session";
import type { HostTransportEndpoint } from "../../../shared/host-transport/host-messenger";
import { WsStreamClient } from "../../../shared/host-transport/ws-stream-client";
import { createWhatwgStreamWebSocketFactory } from "../../../shared/host-transport/whatwg-stream-ws-factory";
import { DEFAULT_DIAL_TIMEOUT_MS } from "../../../shared/host-transport/transport-config";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { CLI_CLIENT_IDENTITY } from "../cli-version";
import { cliError, CLI_ERROR_CODES, CliError } from "../runner/errors";
import { resolveHostAuth } from "./host-auth";
import {
  callHostRpc,
  FRAME_TIMEOUT_MS,
  parseCanonicalHostResponse,
  resolveEndpoint,
  toAgentCliError,
} from "./host-rpc";

/** The one line a bot command prints on a host without bots. */
export const BOT_HOST_UPDATE_MESSAGE =
  "traycer: this host needs an update to use bots - run `traycer host update`.";

export function botHostUpdateError(): CliError {
  return cliError({
    code: CLI_ERROR_CODES.HOST_UNSUPPORTED,
    message: BOT_HOST_UPDATE_MESSAGE,
    details: { hostShouldUpgrade: true },
    exitCode: 1,
  });
}

/**
 * Runs one bot RPC through the agent commands' error boundary, replacing the
 * transport's per-method "does not support 'bot.list'" with the one line all
 * bot commands print.
 */
export async function toBotCliError<T>(call: Promise<T>): Promise<T> {
  try {
    return await toAgentCliError(call);
  } catch (error) {
    if (
      error instanceof CliError &&
      error.code === CLI_ERROR_CODES.HOST_UNSUPPORTED
    ) {
      throw botHostUpdateError();
    }
    throw error;
  }
}

export async function listBots(): Promise<readonly BotRecord[]> {
  const result = await toBotCliError(callHostRpc("bot.list", {}));
  return parseCanonicalHostResponse("bot.list", botListResponseSchema, result)
    .bots;
}

/**
 * The bot a person named: its exact id, or its title (ignoring case). A
 * title two bots share is refused with both ids, so the person can pick.
 */
export function findBot(bots: readonly BotRecord[], ref: string): BotRecord {
  const wanted = ref.trim();
  const byId = bots.find((bot) => bot.botId === wanted);
  if (byId !== undefined) return byId;
  const folded = wanted.toLowerCase();
  const byTitle = bots.filter((bot) => bot.title.toLowerCase() === folded);
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `traycer: more than one bot is called '${wanted}' - name it by id: ${byTitle.map((bot) => bot.botId).join(", ")}.`,
      details: null,
      exitCode: 1,
    });
  }
  throw cliError({
    code: CLI_ERROR_CODES.NOT_FOUND,
    message: `traycer: no bot called '${wanted}' - run \`traycer bot list\` to see yours.`,
    details: null,
    exitCode: 1,
  });
}

/**
 * Refuses unless `bot` runs on `hostId`, for what only the bot's own host can
 * do: follow a thread. `elsewhere` finishes the sentence for a bot on
 * another of the person's hosts.
 */
export function refuseUnlessBoundHere(
  bot: BotRecord,
  hostId: string,
  elsewhere: string,
): void {
  if (bot.boundHostId === hostId) return;
  refuseUnlessSomeHostRuns(bot);
  throw cliError({
    code: CLI_ERROR_CODES.INVALID_ARGUMENT,
    message: `traycer: ${bot.title} runs on another of your hosts; ${elsewhere}`,
    details: null,
    exitCode: 1,
  });
}

/**
 * Refuses a bot no host runs, for what any host serves of a running bot:
 * list its threads.
 */
export function refuseUnlessSomeHostRuns(bot: BotRecord): void {
  if (bot.boundHostId !== null) return;
  throw cliError({
    code: CLI_ERROR_CODES.INVALID_ARGUMENT,
    message: `traycer: no host runs ${bot.title}; move it to a host first.`,
    details: null,
    exitCode: 1,
  });
}

/** What the bot commands use of the stream client; a test passes a fake. */
export type BotStreamClient = Pick<
  WsStreamClient<HostStreamRpcRegistry>,
  "subscribe" | "getMethodSupport" | "close"
>;

/** One `bot.subscribe` snapshot: the bot's tasks and open requests. */
export interface BotSnapshot {
  readonly bot: BotRecord;
  readonly tasks: readonly BotTaskEntry[];
  /**
   * `null` when the host does not know the count: it is not the bot's bound
   * host, or it has not read the bot's conversations yet.
   */
  readonly openRequestCount: number | null;
}

// The mint refusal that ended a client's command: each read on it fails with
// that refusal's line, as the command did when the mint came before the dial.
const refusalEndingReads = new WeakMap<BotStreamClient, CliError>();

/**
 * The mint refusal's line when one ended the command `client` serves (it is
 * closed by then), else `null`. Every wait on the client reads it first.
 */
export function refusalEndingCommand(client: BotStreamClient): CliError | null {
  return refusalEndingReads.get(client) ?? null;
}

/**
 * Opens a stream client against the local host, as `worktree delete` does.
 * No host credential is minted: these sessions only read, and end in seconds.
 * The first dial presents the held host-only token, or probes with none,
 * while its mint runs in the background; a mint refusal that ends the command
 * closes the client.
 */
export async function openLocalStreamClient(): Promise<{
  readonly client: BotStreamClient;
  readonly endpoint: HostTransportEndpoint;
}> {
  const auth = await resolveHostAuth();
  if (auth === null) throw signedOutCliError();
  const endpoint = await resolveEndpoint();
  const hostId = endpoint.hostId;
  // The token is all these short reads need: nothing here refreshes the
  // sign-in once the client is built, so the session is released at once.
  const session = await requireCliHostSession(auth, hostId, null);
  session.dispose();
  const tokens = session.tokens;
  // Stopped when the client closes: every read on it is over by then.
  let stopRefusals: () => void = () => undefined;
  const client = new WsStreamClient<HostStreamRpcRegistry>({
    onClientClosed: (message) => {
      stopRefusals();
      console.info(message);
    },
    registry: hostStreamRpcRegistry,
    hostId,
    endpoint: () => endpoint,
    bearer: (selectedHostId) => tokens.streamBearer(selectedHostId)(),
    // The session is released, so a sign-in the host refuses ends the read.
    releasedSignOn: { ...session.releasedSignOn, recovery: null },
    userId: session.bearer.identity.userId,
    auth: null,
    // An admitted open fences off a `not-admitted` of a mint begun before it,
    // or ended while it stays admitted.
    door: {
      refused: () => undefined,
      admitted: (instance) => tokens.admitted(instance.hostId),
    },
    clock: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: createWhatwgStreamWebSocketFactory(),
    dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
    openAckTimeoutMs: STREAM_OPEN_ACK_TIMEOUT_MS,
    pingIntervalMs: STREAM_PING_INTERVAL_MS,
    pongTimeoutMs: STREAM_PONG_TIMEOUT_MS,
    initialBackoffMs: STREAM_INITIAL_BACKOFF_MS,
    maxBackoffMs: STREAM_MAX_BACKOFF_MS,
    clientIdentity: CLI_CLIENT_IDENTITY,
  });
  stopRefusals = tokens.onRefusalEndingCommand((refusedHostId, failure) => {
    if (refusedHostId !== hostId || refusalEndingReads.has(client)) return;
    refusalEndingReads.set(client, hostTokenFailureCliError(failure));
    client.close("host-token-refused");
  });
  return { client, endpoint };
}

// Stream timing, as `traycer worktree delete` and `traycer monitor` set it.
const STREAM_OPEN_ACK_TIMEOUT_MS = 10_000;
const STREAM_PING_INTERVAL_MS = 25_000;
const STREAM_PONG_TIMEOUT_MS = 60_000;
const STREAM_INITIAL_BACKOFF_MS = 500;
const STREAM_MAX_BACKOFF_MS = 30_000;

/**
 * The longest a one-shot `bot.subscribe` read waits for its snapshot: the
 * stream's own dial and open deadlines, then the response deadline a unary
 * call gets. No new number - the sum of the three the CLI already uses.
 */
export const BOT_SNAPSHOT_DEADLINE_MS =
  DEFAULT_DIAL_TIMEOUT_MS + STREAM_OPEN_ACK_TIMEOUT_MS + FRAME_TIMEOUT_MS;

/**
 * Reads one snapshot of `botId` and closes the session. `null` when the host
 * answers that the bot is gone (`deleted`). A drop, a refusal or no answer
 * within {@link BOT_SNAPSHOT_DEADLINE_MS} fails the read: this is a one-shot
 * command, not a watcher.
 */
export function readBotSnapshot(
  client: BotStreamClient,
  botId: string,
): Promise<BotSnapshot | null> {
  return new Promise<BotSnapshot | null>((resolve, reject) => {
    let settled = false;
    // The last retry cause the stream redialed before the first open: the
    // read's deadline ends with its line, not as no answer.
    let lastRetryCause: FatalErrorDetails | null = null;
    const session = client.subscribe("bot.subscribe", { botId });
    const deadline = setTimeout(() => {
      const waitedOut =
        lastRetryCause === null
          ? null
          : localTeamAdmissionCliError(lastRetryCause);
      finish(() =>
        reject(waitedOut ?? botReadFailedError(" - no answer in time")),
      );
    }, BOT_SNAPSHOT_DEADLINE_MS);
    const finish = (act: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      session.close();
      act();
    };
    let opened = false;
    session.onServerFrame((envelope) => {
      const parsed = botSubscribeServerFrameSchema.safeParse(envelope);
      if (!parsed.success) {
        finish(() => reject(unreadableStreamError()));
        return;
      }
      const frame = parsed.data;
      if (frame.kind === "snapshot") {
        finish(() =>
          resolve({
            bot: frame.bot,
            tasks: frame.tasks,
            openRequestCount: frame.openRequestCount,
          }),
        );
        return;
      }
      if (frame.kind === "deleted") finish(() => resolve(null));
    });
    session.onStatusChange((status, reason, retryCause) => {
      if (status === "open") {
        opened = true;
        lastRetryCause = null;
      }
      if (status === "connecting" || status === "open") return;
      const refused = refusalEndingCommand(client);
      if (refused !== null) {
        finish(() => reject(refused));
        return;
      }
      // Before the first open a reconnect is the stream finding its
      // credential (a released host's refusal, the probe, the owner's
      // invitation, a token still being minted) or redialing a retryable
      // refusal (`waitedOutBeforeOpen`); the read's deadline bounds it.
      if (
        status === "reconnecting" &&
        !opened &&
        waitedOutBeforeOpen(retryCause)
      ) {
        if (retryCause !== null) lastRetryCause = retryCause;
        return;
      }
      if (retryCause) {
        const admissionError = localTeamAdmissionCliError(retryCause);
        if (admissionError !== null) {
          finish(() => reject(admissionError));
          return;
        }
      }
      if (
        client.getMethodSupport("bot.subscribe") === "unsupported" ||
        isIncompatibleCloseForMethod(reason, "bot.subscribe")
      ) {
        finish(() => reject(botHostUpdateError()));
        return;
      }
      if (reason?.kind === "fatalError") {
        const details = reason.details;
        const readFailed = (): CliError =>
          botReadFailedError(` - ${details.reason}`);
        // No sign-in is refreshed while this read runs (`auth: null`), so
        // nothing here knows the machine to be signed out. A released host's
        // refusal of the sign-in reads as the released CLI printed it; a
        // current team host's refusal naming its reason, as the team's.
        const fatalError = isReleasedSignInRefusal(details)
          ? readFailed()
          : (namedTeamAdmissionCliError(details) ??
            hostDoorRefusalCliError(details, false, readFailed) ??
            localTeamAdmissionCliError(details) ??
            readFailed());
        finish(() => reject(fatalError));
        return;
      }
      finish(() => reject(botReadFailedError("")));
    });
  });
}

function botReadFailedError(detail: string): CliError {
  return cliError({
    code: CLI_ERROR_CODES.HOST_UNREACHABLE,
    message: `traycer: could not read the bot from this host${detail}. Try again.`,
    details: null,
    exitCode: 1,
  });
}

/** A frame this CLI cannot read: the host and CLI disagree on the shape. */
export function unreadableStreamError(): CliError {
  return cliError({
    code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
    message:
      "traycer: the host sent something this CLI could not read - update the CLI or the host so their versions match.",
    details: null,
    exitCode: 1,
  });
}

/** A time the person reads: UTC, to the second. */
export function formatBotTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
