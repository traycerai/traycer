import { readDoorReason } from "@traycer/protocol/framework/door-reason";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import {
  WsStreamClient,
  type WsStreamClientOptions,
} from "../../../shared/host-transport/ws-stream-client";
import {
  type CliHostBearer,
  type CliHostTokens,
  type CliRefusalEnding,
  HOST_TOKEN_RENEWAL_LEAD_MS,
} from "./cli-host-tokens";

/** A local stream client's options, less what {@link runLocalStream} owns. */
export type LocalStreamOptions = Omit<
  WsStreamClientOptions<HostStreamRpcRegistry>,
  "hostId" | "bearer" | "door" | "auth"
>;

/** The caller's own limit on its command. */
export interface LocalStreamLimit<T> {
  /**
   * `from-first-dial`: a span that starts when the first dial does, after any
   * mint of the token. `whole-wait`: the person's wait; a mint of the token
   * before the first dial counts against it, from when {@link runLocalStream}
   * is called, after the caller's set-up. With no mint, both start where the
   * caller's own wait started before: as the first dial's `run` starts.
   */
  readonly span: {
    readonly kind: "from-first-dial" | "whole-wait";
    readonly ms: number;
  };
  /**
   * The caller's own ending at that limit, given the refusal it was
   * answering, or `null` when the limit passed before the first dial.
   */
  readonly ended: (refusal: FatalErrorDetails | null) => Promise<T>;
}

/** One dial of {@link runLocalStream}, as its `run` sees it. */
export interface LocalStreamDial {
  /** Called on every open the host admits on this dial's client. */
  readonly onAdmitted: (listener: () => void) => void;
  /** The limit's end (epoch ms): nothing new is started before an open after it. */
  readonly endsAt: number;
  /**
   * The dial after a refused host-only token: every wait of it ends at
   * {@link endsAt}. The first dial keeps the caller's own timers.
   */
  readonly redial: boolean;
}

const LIMIT_REACHED = Symbol("limit reached");

/**
 * The one way a command dials the local host on a stream that may present a
 * held host-only token past its end. It builds the client, with that bearer
 * and no other recovery (`auth: null`), and hands it to `run`.
 *
 * With no usable token held (none, past its end, or refused), the dial waits
 * until one mint has settled, bounded by the mint's own timeouts, or by the
 * person's whole wait when the limit is one. A refusal that mint met is
 * judged here, by the gate, from the mint's own answer: one that ends the
 * command ends it before any dial, with `refused`. That mint is the one the
 * first dial's opens would have started, so they start none until the host
 * first answers or a read has no token to present; a read after that starts
 * one as before, and a `not-admitted` that waited is judged again on it. A
 * token that is usable when presented is presented at once, as before.
 *
 * If no open of the first dial was admitted and the host's last refusal on it
 * names `token_expired`, `run` runs once more on a new client. The shared
 * transport has marked the very token each refused open presented; the new
 * client presents a usable token the host has not refused, else none, and
 * probes. Nothing was admitted, so nothing ran and nothing is sent twice. The
 * caller's limit is read before that dial, with the caller's own ending.
 *
 * Every other ending, and every refusal after an admitted open, is `run`'s
 * own, unchanged.
 *
 * An admitted stream's token is renewed {@link HOST_TOKEN_RENEWAL_LEAD_MS}
 * before its end and pushed to the host in place. A renewal that fails or
 * answers late pushes nothing: the host ends the stream at that end, as before.
 */
export async function runLocalStream<T>(input: {
  readonly tokens: CliHostTokens;
  readonly hostId: string;
  readonly options: LocalStreamOptions;
  readonly limit: LocalStreamLimit<T>;
  /** The caller's ending for a refusal the gate says ends the command. */
  readonly refused: (ending: CliRefusalEnding) => Promise<T>;
  readonly run: (
    client: WsStreamClient<HostStreamRpcRegistry>,
    dial: LocalStreamDial,
  ) => Promise<T>;
}): Promise<T> {
  const { tokens, hostId, limit } = input;
  const credential = tokens.localStreamCredential(hostId);
  const wholeWaitEndsAt =
    limit.span.kind === "whole-wait" ? Date.now() + limit.span.ms : null;
  const verdict = async (): Promise<{
    readonly minted: CliHostBearer | null;
    readonly ending: CliRefusalEnding | null;
  }> => {
    const minted = await credential.prepare();
    if (minted === null || minted.kind !== "failed")
      return { minted, ending: null };
    return { minted, ending: await tokens.refusalEndingCommandNow(hostId) };
  };
  const answered = settledOf(verdict());
  const raced =
    wholeWaitEndsAt === null
      ? await answered
      : await beforeLimit(answered, wholeWaitEndsAt);
  // A mint still out is left to its handle: the command's dispose aborts it.
  if (raced === LIMIT_REACHED) return limit.ended(null);
  // A usable token needed no mint: no clock of this function is read, and the
  // caller's limit starts where it started before. Otherwise the deadline is
  // read first, whatever settled in the same turn.
  const noMint = raced.kind === "value" && raced.value.minted === null;
  if (!noMint && wholeWaitEndsAt !== null && Date.now() >= wholeWaitEndsAt)
    return limit.ended(null);
  const decided = settle(raced);
  if (decided.ending !== null) return input.refused(decided.ending);
  // A limit the mint did not spend starts with the first dial's `run`, at the
  // point the caller's own wait started before.
  const first = await dialOnce(input, credential.prepare, credential.bearer, {
    endsAt: () =>
      wholeWaitEndsAt !== null && decided.minted !== null
        ? wholeWaitEndsAt
        : Date.now() + limit.span.ms,
    redial: false,
    mintStartsBeforeAnswer: decided.minted === null,
  });
  const { endsAt } = first;
  const refusal = first.door.refusal;
  if (
    first.door.admitted ||
    refusal === null ||
    readDoorReason(refusal.doorReason) !== "token_expired"
  )
    return settle(first.settled);
  if (Date.now() >= endsAt) return limit.ended(refusal);
  const second = await dialOnce(
    input,
    credential.prepare,
    credential.redialBearer,
    { endsAt: () => endsAt, redial: true, mintStartsBeforeAnswer: true },
  );
  return settle(second.settled);
}

type Settled<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly error: unknown };

function settledOf<T>(work: Promise<T>): Promise<Settled<T>> {
  return work.then(
    (value): Settled<T> => ({ kind: "value", value }),
    (error: unknown): Settled<T> => ({ kind: "error", error }),
  );
}

function settle<T>(settled: Settled<T>): T {
  if (settled.kind === "error") throw settled.error;
  return settled.value;
}

/** `work`'s answer, or {@link LIMIT_REACHED} once `endsAt` passes first. */
function beforeLimit<V>(
  work: Promise<V>,
  endsAt: number,
): Promise<V | typeof LIMIT_REACHED> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve(LIMIT_REACHED),
      Math.max(0, endsAt - Date.now()),
    );
    void work.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/** One client, one `run`: what the door heard, and how `run` settled. */
async function dialOnce<T>(
  input: {
    readonly tokens: CliHostTokens;
    readonly hostId: string;
    readonly options: LocalStreamOptions;
    readonly run: (
      client: WsStreamClient<HostStreamRpcRegistry>,
      dial: LocalStreamDial,
    ) => Promise<T>;
  },
  startMint: () => Promise<unknown>,
  bearer: BearerSourceProvider,
  dial: {
    /** The limit's end, read once, as `run` starts. */
    readonly endsAt: () => number;
    readonly redial: boolean;
    /**
     * `false` when the mint before the dial stands in for the one its opens
     * would start: none is started until the host first answers this dial, or
     * a read has no token to present (the probe, or a wait for a token).
     */
    readonly mintStartsBeforeAnswer: boolean;
  },
): Promise<{
  readonly door: {
    readonly admitted: boolean;
    readonly refusal: FatalErrorDetails | null;
  };
  readonly endsAt: number;
  readonly settled: Settled<T>;
}> {
  const { tokens, hostId } = input;
  // What this dial's door heard: the host's latest refusal, and whether it
  // admitted any open. Admission is latched at the open's answer, before the
  // command sees the stream open. `mintMayStart`: the mint before the dial no
  // longer stands in for the next read's.
  const door: {
    admitted: boolean;
    refusal: FatalErrorDetails | null;
    mintMayStart: boolean;
  } = {
    admitted: false,
    refusal: null,
    mintMayStart: dial.mintStartsBeforeAnswer,
  };
  const admissionListeners: (() => void)[] = [];
  // One renewal timer per dial, armed on each admission on the token held
  // then, and cleared once `run` settles.
  const renewal: { timer: NodeJS.Timeout | null; settled: boolean } = {
    timer: null,
    settled: false,
  };
  const armRenewal = (): void => {
    if (renewal.timer !== null) clearTimeout(renewal.timer);
    renewal.timer = null;
    const end = tokens.heldTokenEnd(hostId);
    if (renewal.settled || end === null) return;
    renewal.timer = setTimeout(
      () => {
        renewal.timer = null;
        void tokens.renew(hostId).then((renewed) => {
          if (renewal.settled || renewed === null) return;
          if (renewed > end) client.notifyBearerRotated();
          // Armed again only on a token not yet due: the renewed one, or the
          // same one when the timer fired early. One the renewal left due is
          // not renewed again on this admission.
          if (renewed - Date.now() >= HOST_TOKEN_RENEWAL_LEAD_MS) armRenewal();
        });
      },
      Math.max(0, end - HOST_TOKEN_RENEWAL_LEAD_MS - Date.now()),
    );
  };
  const released = input.options.releasedSignOn ?? null;
  const client: WsStreamClient<HostStreamRpcRegistry> = new WsStreamClient({
    ...input.options,
    // The second dial probes exactly when its bearer has no token to present,
    // read from the one answer at the same instant: a fresh token that lands
    // is presented, and a refused one never is. Whether the stored sign-in
    // may follow the host's answer stays the live gate's
    // (`ownerSignInEligible`), read when it would be spent.
    releasedSignOn:
      dial.redial && released !== null
        ? { ...released, hostTokenUnobtainable: () => bearer() === null }
        : released,
    hostId,
    // An open with no usable token starts the mint through the one starter,
    // as every bearer read did before, but for the one already awaited.
    bearer: (selectedHostId) => {
      if (selectedHostId !== hostId) return null;
      if (door.mintMayStart) void startMint();
      const presented = bearer();
      // With nothing to present, the client probes or waits and reads again:
      // that read starts a mint, as every read did before.
      if (presented === null) door.mintMayStart = true;
      return presented;
    },
    auth: null,
    door: {
      admitted: (instance) => {
        door.admitted = true;
        door.mintMayStart = true;
        armRenewal();
        for (const listener of admissionListeners) listener();
        return tokens.admitted(instance);
      },
      refused: (details) => {
        door.refusal = details;
        door.mintMayStart = true;
      },
    },
  });
  const endsAt = dial.endsAt();
  const settled = await settledOf(
    input.run(client, {
      onAdmitted: (listener) => {
        admissionListeners.push(listener);
      },
      endsAt,
      redial: dial.redial,
    }),
  );
  renewal.settled = true;
  if (renewal.timer !== null) clearTimeout(renewal.timer);
  client.close("local-stream-settled");
  return { door, endsAt, settled };
}
