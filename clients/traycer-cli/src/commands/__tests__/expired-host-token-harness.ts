import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import { writeJsonFileAtomic } from "@traycer/protocol/config/credentials-fs";
import { cliCredentialsPath } from "@traycer/protocol/config/paths";
import type { StoredCredentials } from "@traycer/protocol/config/credentials";
import type { ConnectionManifest } from "@traycer/protocol/framework/ws-protocol";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import {
  createHostTokenFilePersistence,
  hostTokensPath,
} from "../../../../shared/auth/host-token-file";
import { serializeHostTokenFile } from "../../../../shared/auth/host-token-store";
import { resetNegotiatedManifests } from "../../../../shared/host-transport/negotiated-manifest-registry";
import { resetNegotiatedStreamVersions } from "../../../../shared/host-transport/negotiated-stream-version-registry";
import { StubStreamWebSocket } from "../../../../shared/host-transport/__testing__/stub-stream-socket";
import { config } from "../../config";
import { createCliCredentialsStore } from "../../store/credentials-store";
import {
  acquireCliSignIn,
  type CliSignInHandle,
} from "../../internal/cli-host-tokens";
import { nextCasePerson } from "../../internal/__tests__/case-person-test-support";
import type { CommandContext, CommandResult } from "../../runner/runner";
import { CliError } from "../../runner/errors";
import { makeCtx } from "./bot-test-support";
import {
  endpointDelaysMs,
  live,
  publishLag,
  rpcCalls,
  seams,
} from "./expired-host-token-seams";

/**
 * What the commands that dial the local host on a held host-only token share
 * (`worktree delete`, `bot list`, `bot checkins`, `bot post --wait`): a real
 * stored sign-in and host-token file under a temporary home, the real stream
 * client over a fake host door, and the authn mint answered by the test at its
 * HTTP edge. Nothing here names how a command opens its stream.
 */

export const STORED_SIGN_IN = "stored-sign-in";
const ELEVEN_MINUTES_MS = 11 * 60 * 1000;
const WAIT = { timeout: 5_000, interval: 5 };
/** How much later than its signed `exp` a minted token's `expiresAtMs` reads. */
export const RECEIPT_SKEW_MS = 5_000;

/** What a host-only token the host reads carries: when issued, when it ends. */
export interface TokenClaims {
  /** Distinguishes two tokens with the same times. */
  readonly tag: string;
  readonly iatSec: number;
  readonly expSec: number;
}

/** A host-only token as a session grant carries it: a JWT with a real `exp` and `iat`. */
export function jwtToken(claims: TokenClaims): string {
  const part = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({
    exp: claims.expSec,
    iat: claims.iatSec,
    jti: claims.tag,
  })}.`;
}

/** Reads the claims back, as the fake host reads a presented token. */
export function claimsOf(token: unknown): TokenClaims | null {
  if (typeof token !== "string") return null;
  const segments = token.split(".");
  if (segments.length < 3) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(segments[1] ?? "", "base64url").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = Object.fromEntries(Object.entries(parsed));
    const { exp, iat, jti } = record;
    if (typeof exp !== "number" || typeof iat !== "number") return null;
    return { tag: String(jti), iatSec: iat, expSec: exp };
  } catch {
    return null;
  }
}

const loadedAtSec = Math.floor(Date.now() / 1000);
/** The token the mint answers `ok` with, unless the case says another. */
export const FRESH_HOST_TOKEN = jwtToken({
  tag: "fresh",
  iatSec: loadedAtSec,
  expSec: loadedAtSec + 3_600,
});

/** A held host-only token: its string, and the end the store recorded. */
export interface HeldToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

/** A host-only token past its end. */
export function expiredHeldToken(): HeldToken {
  return heldEndingAt(Date.now() - ELEVEN_MINUTES_MS, "held");
}

/** A held token that ends `ms` from now (whole seconds), issued 20 minutes before its end. */
export function heldEndingIn(ms: number): HeldToken {
  return heldEndingAt(Date.now() + ms, "held");
}

function heldEndingAt(endMs: number, tag: string): HeldToken {
  const expSec = Math.floor(endMs / 1000);
  return {
    token: jwtToken({ tag, iatSec: expSec - 1_200, expSec }),
    // The receipt reads later than the signed end: what the CLI schedules
    // from is the signed `exp`.
    expiresAtMs: expSec * 1000 + RECEIPT_SKEW_MS,
  };
}

// ---- the fake host door ------------------------------------------------- //

export type Reading =
  | "admit"
  | "token-expired"
  | "released"
  | "owner-sign-in"
  | "not-admitted"
  /** The ack, and at once a `token_expired` close: the host admits, then cuts. */
  | "admit-then-expired"
  /** A refusal the client retries: the door says it may be asked again. */
  | "retryable"
  /** `token_expired` marked retryable: the client keeps its connection loop. */
  | "token-expired-retryable"
  /**
   * A bearer no script names: refused at the bearer, never admitted by
   * default, when no explicit fixture script takes precedence (see
   * `FakeHost.scriptFor`).
   */
  | "unknown-bearer";

/** What the door answers to a presented token, and when it answers. */
export interface DoorScript {
  readonly answer: Reading;
  /** `null` answers at once; otherwise the answer waits for this to settle. */
  readonly after: Promise<void> | null;
}

export const ANSWERS_AT_ONCE = (answer: Reading): DoorScript => ({
  answer,
  after: null,
});

/**
 * Every open a door refused because its bearer is one no script names, in the
 * order they came. `close` of a world fails the case when any is left: an open
 * the case did not script is a bearer it did not mean to present. This holds
 * when no explicit fixture script takes precedence: the stream door's slow
 * check and its open-index scripts (`openAt`) run first, and the legacy budget
 * fixture (budgets.test.ts, "the first dial outlasts the limit") is one
 * intentional index-driven admission.
 */
export const unscriptedBearers: { door: "stream" | "unary"; token: unknown }[] =
  [];

export interface Deferred {
  readonly promise: Promise<void>;
  readonly settle: () => void;
}

function deferred(): Deferred {
  let settle: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

export function readFrame(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("frame was not an object");
  }
  return Object.fromEntries(Object.entries(value));
}

class DoorSocket extends StubStreamWebSocket {
  constructor(
    readonly index: number,
    private readonly host: FakeHost,
  ) {
    super();
  }

  override send(data: string | Uint8Array): void {
    super.send(data);
    if (typeof data === "string") this.host.heard(this, readFrame(data));
  }
}

/** One open the host read: what it presented, and whether the mint was still out. */
export interface OpenSeen {
  readonly index: number;
  readonly token: unknown;
  readonly mintStillOut: boolean;
  /** The method of the subscribe that followed, when one did. */
  method: string | null;
}

export class FakeHost {
  readonly opens: OpenSeen[] = [];
  /** The methods this host does not serve (a host older than the command). */
  lacks: readonly string[] = [];
  /** The answer to the held, expired token; by open index, else `expired`. */
  expired: DoorScript = ANSWERS_AT_ONCE("token-expired");
  readonly expiredAt = new Map<number, DoorScript>();
  /** The answer to the host-only token the mint hands out (`FRESH_HOST_TOKEN`). */
  fresh: DoorScript = ANSWERS_AT_ONCE("admit");
  /** The answer to an open that presents the person's own stored sign-in. */
  signIn: DoorScript = ANSWERS_AT_ONCE("admit");
  /** The answer to the open of this index, whatever token it presents. */
  readonly openAt = new Map<number, DoorScript>();
  /** The answer to the placeholder an open with no token presents. */
  probe: "owner-sign-in" | "released" | "not-admitted" = "owner-sign-in";
  /** Every subscribe the host read, on any socket, in the order it came. */
  readonly subscribes: { index: number; method: string; params: unknown }[] =
    [];
  /**
   * A subscribe the host admitted and then answers with a refusal instead of
   * serving it: the request is on the wire, and the door closes on it.
   */
  refuseAfter: (method: string, params: unknown) => Reading | null = () => null;
  /** What the host serves for a subscribe: frames to send, in order. */
  serve: (method: string, params: unknown) => readonly unknown[] = () => [];
  /**
   * The capabilities the host's `openAck` advertises. A released host
   * advertises none, so a client must send it no `credentialUpdate`.
   */
  capabilities: readonly string[] = [];
  /**
   * The host's own sign-in check, when it is slower than the open's ack: a
   * token past its end is ADMITTED (the check has not answered), and when the
   * check settles the host closes that connection with `token_expired`.
   */
  slowCheck: Deferred | null = null;
  /** Serving waits for this, once set: the request is on the wire, unanswered. */
  hold: Promise<void> | null = null;
  /**
   * What each connection's watch holds: the token it was opened on, or the
   * one a `credentialUpdate` superseded it with, and where it ends.
   */
  readonly connections: { token: unknown; endMs: number; cut: boolean }[] = [];
  /** Every `credentialUpdate` frame the host read, with what it did with it. */
  readonly updates: {
    index: number;
    token: unknown;
    installed: boolean;
  }[] = [];
  private readonly sockets: DoorSocket[] = [];
  private readonly subscribed = new Map<number, Deferred>();
  private readonly opened = new Map<number, Deferred>();
  private readonly refused = new Map<number, Deferred>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly mint: MintEdge,
    private readonly expiredHeld: string,
  ) {}

  accept(): StubStreamWebSocket {
    const socket = new DoorSocket(this.sockets.length, this);
    this.sockets.push(socket);
    queueMicrotask(() => socket.fireOpen());
    return socket;
  }

  /** Settles when the host has read the open of this index. */
  private whenOpened(index: number): Promise<void> {
    return this.latch(this.opened, index).promise;
  }

  /**
   * Settles when the host has read the open of the last index of `bearers`,
   * and asserts that the opens read so far presented exactly these bearers, in
   * order: a wait for "the Nth open" that cannot be satisfied by another.
   */
  async whenOpenedAs(bearers: readonly unknown[]): Promise<void> {
    await this.whenOpened(bearers.length - 1);
    expect(
      this.opens.slice(0, bearers.length).map((open) => open.token),
    ).toEqual(bearers);
  }

  /** Settles when the host has sent its refusal on the socket of this index. */
  whenRefused(index: number): Promise<void> {
    return this.latch(this.refused, index).promise;
  }

  /** Settles when the host has read a subscribe on the socket of this index. */
  whenSubscribed(index: number): Promise<void> {
    return this.latch(this.subscribed, index).promise;
  }

  /** Settles when the host has read a `credentialUpdate` on the socket of this index. */
  async whenUpdated(index: number): Promise<void> {
    await vi.waitFor(
      () =>
        expect(this.updates.some((update) => update.index === index)).toBe(
          true,
        ),
      WAIT,
    );
  }

  /**
   * The host's watch reaches `atMs` on connection `index`: a connection whose
   * token ends by then is closed `token_expired`; one a superseding token
   * moved past it is not.
   */
  watchReaches(index: number, atMs: number): void {
    const connection = this.connections[index];
    const socket = this.sockets[index];
    if (connection === undefined || socket === undefined) return;
    if (connection.endMs > atMs || connection.cut) return;
    this.cut(index);
  }

  private cut(index: number): void {
    const connection = this.connections[index];
    const socket = this.sockets[index];
    if (connection === undefined || socket === undefined) return;
    connection.cut = true;
    socket.fireText(refusalFrame("token-expired"));
    this.latch(this.refused, index).settle();
  }

  /**
   * THE HOST HALF OF A `credentialUpdate`, AS A MODEL (the real handler is not
   * in this checkout; it is cited at ab77835c004066e819bc91773cf35b328faf0fb3).
   *
   * Invariant 1, NO ACCEPTANCE ACK: the host sends nothing back when it takes
   * (or ignores) a `credentialUpdate`. This fake sends nothing either, and a
   * test reads what the host did from `updates` and `connections`, never from
   * a reply. Modelled on traycer-host/src/transport/stream/
   * stream-connection-handler.ts:1389-1412.
   *
   * Invariant 2, INSTALL ONLY A SUPERSEDING TOKEN: the host installs the
   * offered token, and re-arms the connection's watch on its end, only when it
   * supersedes the one held (a later `iat`); a token that does not supersede
   * is ignored and the watch stays on the old end. Modelled on
   * stream-connection-handler.ts:1419-1422 and traycer-host/src/transport/rpc/
   * auth/connection-reauthorization.ts:131-149.
   *
   * The host's own proof that a `credentialUpdate` re-arms the walk against
   * the fresh token version: traycer-host/src/transport/stream/__tests__/
   * stream-reauthorization.test.ts:613 at ab77835c.
   */
  private heardUpdate(
    socket: DoorSocket,
    frame: Record<string, unknown>,
  ): void {
    const connection = this.connections[socket.index];
    const offered = claimsOf(frame.token);
    const held = claimsOf(connection?.token);
    const supersedes =
      connection !== undefined &&
      !connection.cut &&
      offered !== null &&
      held !== null &&
      offered.iatSec > held.iatSec;
    if (supersedes && connection !== undefined && offered !== null) {
      connection.token = frame.token;
      connection.endMs = offered.expSec * 1000;
    }
    this.updates.push({
      index: socket.index,
      token: frame.token,
      installed: supersedes,
    });
  }

  /** Every answer the host owed has been sent. */
  async settled(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private latch(book: Map<number, Deferred>, index: number): Deferred {
    let latch = book.get(index);
    if (latch === undefined) {
      latch = deferred();
      book.set(index, latch);
    }
    return latch;
  }

  heard(socket: DoorSocket, frame: Record<string, unknown>): void {
    if (frame.kind === "open") {
      this.readOpen(socket, frame);
      return;
    }
    if (frame.kind === "credentialUpdate") {
      this.heardUpdate(socket, frame);
      return;
    }
    if (frame.kind === "subscribe") {
      const method = String(frame.method);
      this.latch(this.subscribed, socket.index).settle();
      const seen = this.opens[socket.index];
      if (seen !== undefined) seen.method = method;
      this.subscribes.push({
        index: socket.index,
        method,
        params: frame.params,
      });
      const refusal = this.refuseAfter(method, frame.params);
      if (refusal !== null) {
        queueMicrotask(() => {
          socket.fireText(refusalFrame(refusal));
          this.latch(this.refused, socket.index).settle();
        });
        return;
      }
      const answers = this.serve(method, frame.params);
      void (async (): Promise<void> => {
        await Promise.resolve();
        if (this.hold !== null) await this.hold;
        for (const answer of answers) {
          if (!this.connections[socket.index]?.cut) socket.fireText(answer);
        }
      })();
    }
  }

  private readOpen(socket: DoorSocket, open: Record<string, unknown>): void {
    const token = open.token;
    this.opens[socket.index] = {
      index: socket.index,
      token,
      mintStillOut: this.mint.isOut(),
      method: null,
    };
    const claims = claimsOf(token);
    this.connections[socket.index] = {
      token,
      endMs: claims === null ? Number.POSITIVE_INFINITY : claims.expSec * 1000,
      cut: false,
    };
    this.latch(this.opened, socket.index).settle();
    const pastEnd = claims !== null && claims.expSec * 1000 <= Date.now();
    const checkedSlowly = this.slowCheck !== null && pastEnd;
    const script = checkedSlowly
      ? ANSWERS_AT_ONCE("admit")
      : this.scriptFor(socket.index, token);
    if (checkedSlowly && this.slowCheck !== null) {
      void this.slowCheck.promise.then(() => this.cut(socket.index));
    }
    const answering = (async (): Promise<void> => {
      // Never inside the client's own `send`: a host answers a later turn.
      await Promise.resolve();
      if (script.after !== null) await script.after;
      if (script.answer === "admit" || script.answer === "admit-then-expired") {
        socket.fireText({
          kind: "openAck",
          manifest: this.servedManifest(open.manifest),
          optionalManifest: open.optionalManifest,
          capabilities: this.capabilities,
        });
        if (script.answer === "admit-then-expired") this.cut(socket.index);
        return;
      }
      socket.fireText(refusalFrame(script.answer));
      this.latch(this.refused, socket.index).settle();
    })();
    this.pending.add(answering);
    void answering.finally(() => this.pending.delete(answering));
  }

  /**
   * The script of an open. An open-index script (`openAt`) is explicit and
   * takes precedence over the bearer's script; so does the slow check, which
   * `readOpen` consults before this. Only when none applies is an unknown
   * bearer refused.
   */
  private scriptFor(index: number, token: unknown): DoorScript {
    const named = this.openAt.get(index);
    if (named !== undefined) return named;
    if (token === this.expiredHeld)
      return this.expiredAt.get(index) ?? this.expired;
    if (token === NO_HOST_TOKEN_PROBE) {
      return ANSWERS_AT_ONCE(this.probe);
    }
    if (token === FRESH_HOST_TOKEN) return this.fresh;
    if (token === STORED_SIGN_IN) return this.signIn;
    unscriptedBearers.push({ door: "stream", token });
    return ANSWERS_AT_ONCE("unknown-bearer");
  }

  private servedManifest(manifest: unknown): ConnectionManifest {
    const asked = manifest as ConnectionManifest;
    return Object.fromEntries(
      Object.entries(asked).filter(([method]) => !this.lacks.includes(method)),
    );
  }
}

export function refusalFrame(answer: Reading): unknown {
  const named =
    answer === "token-expired"
      ? { doorReason: "token_expired", retryable: false }
      : answer === "owner-sign-in"
        ? { doorReason: "owner_sign_in", retryable: false }
        : answer === "not-admitted"
          ? { doorReason: "not_admitted", retryable: false }
          : answer === "retryable"
            ? { doorReason: "keys_unavailable", retryable: true }
            : answer === "token-expired-retryable"
              ? { doorReason: "token_expired", retryable: true }
              : {};
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: `door refused: ${answer}`,
      ...named,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

// ---- the mint, at its HTTP edge ----------------------------------------- //

export type MintAnswer =
  | "ok"
  | "unavailable"
  | "sign-in-rejected"
  | "not-a-member"
  | "not-admitted"
  | "sandbox-frozen";

interface MintRequest {
  readonly authorization: string;
  readonly at: number;
  readonly settle: (response: Response) => void;
}

/**
 * Authn's session-grant route and refresh route as the stubbed `fetch` sees
 * them. A mint request waits until the test answers it; an answer given sets
 * the answer every later request gets at once.
 */
export class MintEdge {
  readonly requests: MintRequest[] = [];
  refreshes = 0;
  /** While set, a refresh of the sign-in is not answered until it settles. */
  private refreshGate: Promise<void> | null = null;
  /** The token an `ok` answer carries; its end is signed in it. */
  issued: string = FRESH_HOST_TOKEN;
  private answer: MintAnswer | null = null;
  private waiting: MintRequest[] = [];

  /** A mint request is in flight and no answer has been given yet. */
  isOut(): boolean {
    return this.answer === null;
  }

  respond(answer: MintAnswer): void {
    this.answer = answer;
    const held = this.waiting;
    this.waiting = [];
    for (const request of held) request.settle(this.responseFor(answer));
  }

  /** Answers `answer` once `ms` have passed on the real clock. */
  respondAfter(ms: number, answer: MintAnswer): void {
    setTimeout(() => this.respond(answer), ms);
  }

  /**
   * Refresh requests are not answered until the returned function is called
   * (the world's close does not call it: the test does, in its `finally`).
   */
  holdRefreshes(): () => void {
    const gate = deferred();
    this.refreshGate = gate.promise;
    return () => {
      this.refreshGate = null;
      gate.settle();
    };
  }

  /** The answer every later mint request gets at once is cleared: they wait again. */
  hold(): void {
    this.answer = null;
  }

  install(): void {
    vi.stubGlobal(
      "fetch",
      (input: RequestInfo | URL, init: RequestInit | undefined) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url,
        );
        // As a real fetch: the init's signal, else the Request's own.
        const signal =
          init?.signal !== undefined
            ? init.signal
            : input instanceof Request
              ? input.signal
              : null;
        if (url.pathname.endsWith("/session-grant"))
          return this.mintRequest(init, signal);
        if (url.pathname.endsWith("/auth/refresh")) {
          // As a real fetch: under a signal already aborted nothing is sent.
          if (signal?.aborted === true)
            return Promise.reject(new DOMException("aborted", "AbortError"));
          this.refreshes += 1;
          const gate = this.refreshGate;
          const refused = (): Response =>
            new Response(JSON.stringify({ statusCode: 401, error: "no" }), {
              status: 401,
              headers: { "content-type": "application/json" },
            });
          if (gate === null) return Promise.resolve(refused());
          return new Promise<Response>((resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
            void gate.then(() => resolve(refused()));
          });
        }
        return Promise.reject(new Error(`unexpected fetch ${url.pathname}`));
      },
    );
  }

  private mintRequest(
    init: RequestInit | undefined,
    signal: AbortSignal | null,
  ): Promise<Response> {
    // As a real fetch: under a signal already aborted nothing is sent.
    if (signal?.aborted === true)
      return Promise.reject(new DOMException("aborted", "AbortError"));
    const headers = new Headers(init?.headers);
    return new Promise<Response>((resolve, reject) => {
      const request: MintRequest = {
        authorization: headers.get("Authorization") ?? "",
        at: Date.now(),
        settle: resolve,
      };
      this.requests.push(request);
      signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
      if (this.answer === null) this.waiting.push(request);
      else resolve(this.responseFor(this.answer));
    });
  }

  private responseFor(answer: MintAnswer): Response {
    switch (answer) {
      case "ok": {
        const endMs = (claimsOf(this.issued)?.expSec ?? 0) * 1000;
        return new Response(
          JSON.stringify({
            session_grant: this.issued,
            // The receipt reads later than the signed end: the CLI must
            // follow the signed `exp`, not the receipt.
            session_grant_expires_in: Math.max(
              1,
              Math.round((endMs - Date.now() + RECEIPT_SKEW_MS) / 1000),
            ),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      case "unavailable":
        return new Response(JSON.stringify({ message: "offline" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      case "sign-in-rejected":
        return new Response(JSON.stringify({ message: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      case "not-a-member":
        return new Response(
          JSON.stringify({ code: "team_membership_required" }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          },
        );
      case "not-admitted":
        return new Response(JSON.stringify({ message: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      case "sandbox-frozen":
        return new Response(JSON.stringify({ code: "sandbox_frozen" }), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
    }
  }
}

// ---- one case's world --------------------------------------------------- //

/** The home the mocked `node:os` points at; the test file owns it. */
export interface HomeRef {
  path: string | null;
}

export interface World {
  readonly userId: string;
  readonly hostId: string;
  readonly mint: MintEdge;
  readonly host: FakeHost;
  readonly output: CapturedOutput;
  readonly ctx: CommandContext;
  readonly expiredHeld: string;
  /** The host-only token the file holds for this host now. */
  heldToken: () => Promise<string | null>;
  close: () => Promise<void>;
}

let hostsMade = 0;

export async function openWorld(
  home: HomeRef,
  heldToken: HeldToken | "none" | null,
): Promise<World> {
  home.path = await mkdtemp(join(tmpdir(), "traycer-expired-token-"));
  const person = nextCasePerson();
  hostsMade += 1;
  const hostId = `55555555-5555-4555-8555-${String(hostsMade).padStart(12, "0")}`;
  processReleasedHosts.forgetAll();
  resetNegotiatedManifests();
  resetNegotiatedStreamVersions();
  const credentials: StoredCredentials = {
    token: STORED_SIGN_IN,
    refreshToken: `rt-${person.signIn}`,
    savedAt: "2026-01-01T00:00:00.000Z",
    user: { id: person.userId, email: "user@example.test", name: "User" },
  };
  const store = createCliCredentialsStore();
  try {
    await store.signIn(credentials, false, null);
  } finally {
    store.dispose();
  }
  const held = heldToken === "none" ? null : (heldToken ?? expiredHeldToken());
  await writeJsonFileAtomic(
    hostTokensPath(config.environment),
    serializeHostTokenFile(
      new Map([
        [person.userId, new Map(held === null ? [] : [[hostId, held]])],
      ]),
    ),
    0o600,
  );
  const mint = new MintEdge();
  mint.install();
  const output = captureOutput();
  const persistence = createHostTokenFilePersistence({
    environment: config.environment,
    lockWaitMs: 2_000,
    lockPollIntervalMs: 10,
  });
  const world: World = {
    userId: person.userId,
    hostId,
    mint,
    host: new FakeHost(mint, held?.token ?? "no-held-token"),
    output,
    ctx: makeCtx(),
    expiredHeld: held?.token ?? "no-held-token",
    heldToken: async () =>
      (await persistence.load()).get(person.userId)?.get(hostId)?.token ?? null,
    close: async () => {
      output.restore();
      live.door = null;
      publishLag.release?.();
      publishLag.hold = null;
      publishLag.written = null;
      publishLag.release = null;
      vi.unstubAllGlobals();
      const unscripted = unscriptedBearers.splice(0);
      const lockPath = `${cliCredentialsPath(config.environment)}.lock`;
      if (existsSync(lockPath)) {
        await vi.waitFor(() => expect(existsSync(lockPath)).toBe(false), {
          timeout: 10_000,
        });
      }
      const path = home.path;
      home.path = null;
      processReleasedHosts.forgetAll();
      if (path !== null)
        await rm(path, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      expect(unscripted).toEqual([]);
    },
  };
  rpcCalls.length = 0;
  endpointDelaysMs.length = 0;
  seams.endpoint = { hostId, websocketUrl: "ws://127.0.0.1:9/rpc" };
  seams.rpc = () => Promise.reject(new Error("no unary read was expected"));
  live.door = world.host;
  return world;
}

/**
 * Holds what the token source does after the mint's grant is on disk: the file
 * has the grant, and this process has not yet been told. The order is the
 * test's: `written` settles at that point, and nothing is published until
 * `release` is called. The world's close lifts it.
 */
export function holdPublication(): {
  readonly written: Promise<void>;
  readonly release: () => void;
} {
  const release = deferred();
  const written = deferred();
  publishLag.hold = release.promise;
  publishLag.written = written.settle;
  publishLag.release = release.settle;
  return { written: written.promise, release: release.settle };
}

/**
 * The person's own handle on this process's host-token source: what a choice
 * about the sign-in reads (`ownerSignInEligible`) is read through it. Dispose
 * it at the end of the case.
 */
export function personOf(world: World): Promise<CliSignInHandle> {
  return acquireCliSignIn(
    {
      token: STORED_SIGN_IN,
      authnBaseUrl: "http://authn.invalid",
      userId: world.userId,
    },
    null,
  );
}

/**
 * Settles when the answer of the mint is published in this process: the read
 * the choice about the sign-in makes (`ownerSignInEligible`) no longer holds.
 * Waiting on the file is not this: the file is written before the process
 * publishes what it wrote.
 */
export async function whenPublishedInProcess(
  person: CliSignInHandle,
  world: World,
): Promise<void> {
  await vi.waitFor(
    () => expect(person.tokens.ownerSignInEligible(world.hostId)).toBe(false),
    WAIT,
  );
}

// ---- outcomes and output -------------------------------------------------- //

export interface CapturedOutput {
  readonly lines: string[];
  restore: () => void;
}

/** Everything the command writes to the streams or the console, as text. */
function captureOutput(): CapturedOutput {
  const lines: string[] = [];
  const keep = (...parts: unknown[]): boolean => {
    lines.push(parts.map(String).join(" "));
    return true;
  };
  const spies = [
    vi.spyOn(process.stdout, "write").mockImplementation(keep),
    vi.spyOn(process.stderr, "write").mockImplementation(keep),
    vi.spyOn(console, "log").mockImplementation(keep),
    vi.spyOn(console, "info").mockImplementation(keep),
    vi.spyOn(console, "warn").mockImplementation(keep),
    vi.spyOn(console, "error").mockImplementation(keep),
  ];
  return {
    lines,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

export type Outcome =
  | { readonly kind: "completed"; readonly result: CommandResult }
  | {
      readonly kind: "failed";
      readonly code: string;
      readonly message: string;
    };

export async function settle(run: Promise<CommandResult>): Promise<Outcome> {
  try {
    return { kind: "completed", result: await run };
  } catch (error) {
    if (error instanceof CliError)
      return { kind: "failed", code: error.code, message: error.message };
    throw error;
  }
}

/** Every line the person could have read: the writes, the result's text and an error's. */
export function whatThePersonRead(world: World, outcome: Outcome): string {
  const text =
    outcome.kind === "completed"
      ? [outcome.result.human ?? "", JSON.stringify(outcome.result.data)]
      : [outcome.message];
  return [...world.output.lines, ...text].join("\n");
}

/** How a command is started, and what its normal result is. */
export interface Member {
  readonly title: string;
  /** The open that carries the fault: the expired token, refused at the door. */
  readonly faultedOpen: number;
  start: (world: World) => Promise<CommandResult>;
  /** Sets what the fake host serves and answers for this member's reads. */
  prepare: (world: World) => void;
  expectNormalResult: (outcome: Outcome) => void;
}

/** Readies the host for a member: its serving, and its earlier opens admitted. */
export function prepareHostFor(member: Member, world: World): void {
  member.prepare(world);
  for (let index = 0; index < member.faultedOpen; index += 1) {
    world.host.expiredAt.set(index, ANSWERS_AT_ONCE("admit"));
  }
}

/**
 * What a second run of the command starts with: this process's memory of what
 * the host answered to the first run is gone, as it is in a new process.
 */
export function startNewProcess(): void {
  processReleasedHosts.forgetAll();
  resetNegotiatedManifests();
  resetNegotiatedStreamVersions();
}

/** Lets the work already due settle: a mint's answer reaching its waiters. */
export function flush(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { deferred, WAIT };
