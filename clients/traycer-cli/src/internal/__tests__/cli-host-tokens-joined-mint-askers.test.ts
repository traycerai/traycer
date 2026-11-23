import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredCredentials } from "@traycer/protocol/config/credentials";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import type { HostTokenTable } from "../../../../shared/auth/host-token-store";
import type { HostTokenMintOutcome } from "../../../../shared/auth/host-token-source";
import type { Environment } from "../../runner/environment";
import { createCliCredentialsStore } from "../../store/credentials-store";
import {
  acquireCliSignIn,
  type CliHostBearer,
  type CliSignInHandle,
} from "../cli-host-tokens";
import { nextCasePerson } from "./case-person-test-support";

// Two handles of one person ask fresh for the one host process's token with
// their own exits, over the real token path and a real credentials file,
// against a scripted authn. The second handle's ask joins the request the
// first started. A request authn was sent stays out while any asker still
// waits for it, and is aborted only once every asker has left.

const SIGN_IN = "sign-in-joined-askers";

const harness = vi.hoisted(() => ({
  /**
   * Every authn request in the order sent, with the signal it was sent under.
   * Each is held until the test answers it; `abortedWhenAnswered` is its
   * signal's state at that moment.
   */
  mints: [] as Array<{
    readonly hostId: string;
    readonly signIn: string;
    readonly signal: AbortSignal;
    readonly answer: (outcome: HostTokenMintOutcome) => void;
    abortedWhenAnswered: boolean | null;
  }>,
  table: new Map() as HostTokenTable,
}));

const credentialsFile = vi.hoisted(() => ({ path: "" }));

vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return {
    ...actual,
    cliCredentialsPath: (_environment: Environment): string => {
      if (credentialsFile.path === "")
        throw new Error("no credentials file under test");
      return credentialsFile.path;
    },
  };
});

vi.mock("@traycer-clients/shared/auth/host-token-file", () => ({
  createHostTokenFilePersistence: () => ({
    load: async () => harness.table,
    update: async (change: (table: HostTokenTable) => HostTokenTable) => {
      harness.table = change(harness.table);
      return harness.table;
    },
  }),
}));

vi.mock(
  "@traycer-clients/shared/host-transport/remote/grant-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/grant-client")
      >();
    return {
      ...actual,
      mintHostTokenViaHttp: (
        _authnBaseUrl: string,
        hostId: string,
        signIn: string,
        signal: AbortSignal,
      ): Promise<HostTokenMintOutcome> =>
        new Promise<HostTokenMintOutcome>((resolve) => {
          const request = {
            hostId,
            signIn,
            signal,
            abortedWhenAnswered: null as boolean | null,
            answer: (outcome: HostTokenMintOutcome): void => {
              request.abortedWhenAnswered = signal.aborted;
              resolve(outcome);
            },
          };
          harness.mints.push(request);
          // An aborted request answers nothing usable, as the wire does.
          signal.addEventListener(
            "abort",
            () => resolve({ kind: "unavailable", detail: "aborted" }),
            { once: true },
          );
        }),
    };
  },
);

let userId = "";
let hostId = "";
let hostCount = 0;
let workDir = "";

const credentialsOf = (token: string): StoredCredentials => ({
  token,
  refreshToken: `rt-${token}`,
  savedAt: "2026-01-01T00:00:00.000Z",
  user: { id: userId, email: "user@example.test", name: "User" },
});

beforeEach(async () => {
  userId = nextCasePerson().userId;
  harness.mints.splice(0);
  harness.table = new Map();
  hostCount += 1;
  hostId = `88888888-8888-4888-8888-${String(hostCount).padStart(12, "0")}`;
  processReleasedHosts.forgetAll();
  workDir = await mkdtemp(join(tmpdir(), "traycer-joined-askers-"));
  credentialsFile.path = join(workDir, "credentials");
});

afterEach(async () => {
  processReleasedHosts.forgetAll();
  credentialsFile.path = "";
  await rm(workDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
});

/** The host-only token an answer hands the caller, or null for a failure. */
function tokenOf(answer: CliHostBearer): string | null {
  return answer.kind === "ok" ? answer.bearer.getBearerToken() : null;
}

/** Lets what an abort or a start set going run its continuations. */
const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

async function twoHandles(): Promise<{
  readonly first: CliSignInHandle;
  readonly second: CliSignInHandle;
}> {
  const store = createCliCredentialsStore();
  await store.signIn(credentialsOf(SIGN_IN), false, null);
  store.dispose();
  processReleasedHosts.observeInstance(hostId, "boot-1");
  const person = {
    token: SIGN_IN,
    authnBaseUrl: "https://authn.test",
    userId,
  };
  const first = await acquireCliSignIn(person, null);
  const second = await acquireCliSignIn(person, null);
  return { first, second };
}

/** The first handle's ask starts the one request; the second handle's ask then joins it. */
async function secondJoinsFirst(
  first: CliSignInHandle,
  firstExit: AbortSignal | null,
  second: CliSignInHandle,
  secondExit: AbortSignal | null,
): Promise<{
  readonly askedByFirst: Promise<CliHostBearer>;
  readonly askedBySecond: Promise<CliHostBearer>;
}> {
  const askedByFirst = first.tokens.mintFresh(hostId, firstExit);
  while (harness.mints.length === 0) await flush();
  const askedBySecond = second.tokens.mintFresh(hostId, secondExit);
  await flush();
  return { askedByFirst, askedBySecond };
}

/** Answers the `index`th request authn was sent with a bought token. */
function answerWithToken(index: number): void {
  const request = harness.mints[index];
  if (request === undefined) throw new Error("no such request was sent");
  request.answer({
    kind: "ok",
    token: {
      token: `host-token-bought-${index}`,
      expiresAtMs: Date.now() + 3_600_000,
    },
  });
}

describe("two handles of one person asking fresh for one host process's token", () => {
  it("keeps the one request out for the second handle when the first handle's ask ends", async () => {
    const { first, second } = await twoHandles();
    try {
      const firstExit = new AbortController();
      const { askedByFirst, askedBySecond } = await secondJoinsFirst(
        first,
        firstExit.signal,
        second,
        null,
      );

      firstExit.abort();
      await flush();
      answerWithToken(0);

      expect(tokenOf(await askedBySecond)).toBe("host-token-bought-0");
      expect(tokenOf(await askedByFirst)).toBeNull();
      expect(harness.mints).toHaveLength(1);
      expect(harness.mints[0]?.abortedWhenAnswered).toBe(false);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("keeps the one request out for the second handle when the first handle is disposed", async () => {
    const { first, second } = await twoHandles();
    try {
      const { askedByFirst, askedBySecond } = await secondJoinsFirst(
        first,
        null,
        second,
        null,
      );

      first.dispose();
      await flush();
      answerWithToken(0);

      expect(tokenOf(await askedBySecond)).toBe("host-token-bought-0");
      expect(tokenOf(await askedByFirst)).toBeNull();
      expect(harness.mints).toHaveLength(1);
      expect(harness.mints[0]?.abortedWhenAnswered).toBe(false);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("aborts the one request once both handles' asks have ended", async () => {
    const { first, second } = await twoHandles();
    try {
      const firstExit = new AbortController();
      const secondExit = new AbortController();
      const { askedByFirst, askedBySecond } = await secondJoinsFirst(
        first,
        firstExit.signal,
        second,
        secondExit.signal,
      );

      firstExit.abort();
      secondExit.abort();
      await flush();

      expect(harness.mints).toHaveLength(1);
      expect(harness.mints[0]?.signal.aborted).toBe(true);
      expect(tokenOf(await askedByFirst)).toBeNull();
      expect(tokenOf(await askedBySecond)).toBeNull();
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});

const SIGN_IN_NEXT = "sign-in-joined-askers-next";

/** Handles of the person, each a separate token session; the host process is observed unless `observed` says it is not. */
async function handlesOf(
  count: number,
  observed: boolean,
): Promise<readonly CliSignInHandle[]> {
  const store = createCliCredentialsStore();
  await store.signIn(credentialsOf(SIGN_IN), false, null);
  store.dispose();
  if (observed) processReleasedHosts.observeInstance(hostId, "boot-1");
  const person = {
    token: SIGN_IN,
    authnBaseUrl: "https://authn.test",
    userId,
  };
  const handles: CliSignInHandle[] = [];
  for (let at = 0; at < count; at += 1)
    handles.push(await acquireCliSignIn(person, null));
  return handles;
}

/** Another process signs the person in again; `reader` reads it into the person's lease. */
async function storedSignInMovesOn(reader: CliSignInHandle): Promise<void> {
  const other = createCliCredentialsStore();
  await other.signIn(credentialsOf(SIGN_IN_NEXT), false, null);
  other.dispose();
  await reader.revalidator.adoptStoredSignIn();
}

/** Settles once authn has been sent `count` requests. */
async function untilSent(count: number): Promise<void> {
  while (harness.mints.length < count) await flush();
}

/**
 * That no ask of the person for the host is waiting any more: one more ask
 * with its own exit, ended, has its request aborted at once. A waiter left
 * behind by an earlier ask would keep it out.
 */
async function expectNoWaiterLeft(handle: CliSignInHandle): Promise<void> {
  const before = harness.mints.length;
  const exit = new AbortController();
  const asked = handle.tokens.mintFresh(hostId, exit.signal);
  await untilSent(before + 1);
  exit.abort();
  await flush();
  expect(harness.mints[before]?.signal.aborted).toBe(true);
  expect(tokenOf(await asked)).toBeNull();
}

describe("asks of one person for one host on different sign-ins", () => {
  /** The first handle asks on the sign-in the file holds; the stored sign-in moves on; the second handle asks on the new one. */
  async function oneEachOnItsOwnSignIn(): Promise<{
    readonly firstExit: AbortController;
    readonly secondExit: AbortController;
    readonly askedByFirst: Promise<CliHostBearer>;
    readonly askedBySecond: Promise<CliHostBearer>;
    readonly handles: readonly CliSignInHandle[];
  }> {
    const handles = await handlesOf(3, true);
    const [first, second] = handles;
    const firstExit = new AbortController();
    const secondExit = new AbortController();
    const askedByFirst = first.tokens.mintFresh(hostId, firstExit.signal);
    await untilSent(1);
    await storedSignInMovesOn(second);
    const askedBySecond = second.tokens.mintFresh(hostId, secondExit.signal);
    await untilSent(2);
    return { firstExit, secondExit, askedByFirst, askedBySecond, handles };
  }

  it("keeps the first sign-in's request out while the second sign-in's asker still waits", async () => {
    const { firstExit, askedByFirst, askedBySecond, handles } =
      await oneEachOnItsOwnSignIn();
    try {
      expect(harness.mints.map((mint) => mint.signIn)).toEqual([
        SIGN_IN,
        SIGN_IN_NEXT,
      ]);

      firstExit.abort();
      await flush();

      expect(harness.mints).toHaveLength(2);
      expect(harness.mints[0]?.signal.aborted).toBe(false);
      expect(harness.mints[1]?.signal.aborted).toBe(false);
      expect(tokenOf(await askedByFirst)).toBeNull();

      answerWithToken(1);
      expect(tokenOf(await askedBySecond)).toBe("host-token-bought-1");
      await expectNoWaiterLeft(handles[2]);
    } finally {
      for (const handle of handles) handle.dispose();
    }
  });

  it("aborts the first sign-in's request once its asker has left and the second sign-in's has been answered", async () => {
    const { firstExit, askedByFirst, askedBySecond, handles } =
      await oneEachOnItsOwnSignIn();
    try {
      firstExit.abort();
      await flush();
      answerWithToken(1);
      expect(tokenOf(await askedBySecond)).toBe("host-token-bought-1");
      await flush();

      expect(harness.mints[0]?.signal.aborted).toBe(true);
      expect(tokenOf(await askedByFirst)).toBeNull();
      await expectNoWaiterLeft(handles[2]);
    } finally {
      for (const handle of handles) handle.dispose();
    }
  });

  it("aborts both requests once both askers' exits have ended", async () => {
    const { firstExit, secondExit, askedByFirst, askedBySecond, handles } =
      await oneEachOnItsOwnSignIn();
    try {
      firstExit.abort();
      secondExit.abort();
      await flush();

      expect(harness.mints).toHaveLength(2);
      expect(harness.mints[0]?.signal.aborted).toBe(true);
      expect(harness.mints[1]?.signal.aborted).toBe(true);
      expect(tokenOf(await askedByFirst)).toBeNull();
      expect(tokenOf(await askedBySecond)).toBeNull();
      await expectNoWaiterLeft(handles[2]);
    } finally {
      for (const handle of handles) handle.dispose();
    }
  });
});

describe("a request whose starter's exit ended while another handle's ask joined it", () => {
  /**
   * An earlier request on the first sign-in is out for the host process. The
   * stored sign-in moves on; the starter asks on the new one, the joiner joins
   * it, and the starter's exit ends. The joiner's request is then answered
   * with a token, and the earlier request is refused as the host's.
   */
  async function starterEndsJoinerLives(observed: boolean): Promise<{
    readonly answeredToJoiner: CliHostBearer;
    readonly refusalsEndingCommand: string[];
    readonly handles: readonly CliSignInHandle[];
  }> {
    const handles = await handlesOf(4, observed);
    const [earlier, starter, joiner] = handles;
    const refusalsEndingCommand: string[] = [];
    earlier.tokens.onRefusalEndingCommand((evidence) => {
      refusalsEndingCommand.push(evidence.hostId);
    });
    const askedEarlier = earlier.tokens.mintFresh(hostId, null);
    await untilSent(1);
    await storedSignInMovesOn(starter);
    const starterExit = new AbortController();
    const askedByStarter = starter.tokens.mintFresh(hostId, starterExit.signal);
    await untilSent(2);
    const askedByJoiner = joiner.tokens.mintFresh(hostId, null);
    await flush();
    expect(harness.mints).toHaveLength(2);

    starterExit.abort();
    await flush();
    answerWithToken(1);
    const answeredToJoiner = await askedByJoiner;
    expect(tokenOf(await askedByStarter)).toBeNull();
    expect(harness.mints[1]?.abortedWhenAnswered).toBe(false);

    harness.mints[0]?.answer({ kind: "not-a-member" });
    await askedEarlier;
    return { answeredToJoiner, refusalsEndingCommand, handles };
  }

  it("stores nothing for the ended starter: the joiner's write is the purchase, and an earlier request's refusal is outlived by it", async () => {
    const { answeredToJoiner, refusalsEndingCommand, handles } =
      await starterEndsJoinerLives(true);
    try {
      expect(tokenOf(answeredToJoiner)).toBe("host-token-bought-1");
      // Ordered before the purchase, the refusal ends no command.
      expect(refusalsEndingCommand).toEqual([]);
      await expectNoWaiterLeft(handles[3]);
    } finally {
      for (const handle of handles) handle.dispose();
    }
  });

  it("lets an ended starter's own kept purchase outlive the earlier refusal when the host process is not observed yet, and stores its token", async () => {
    const { answeredToJoiner, refusalsEndingCommand, handles } =
      await starterEndsJoinerLives(false);
    try {
      expect(tokenOf(answeredToJoiner)).toBe("host-token-bought-1");
      expect(harness.table.get(userId)?.get(hostId)?.token).toBe(
        "host-token-bought-1",
      );
      // The starter's own write is the kept one and moves the purchase mark, live or not: the earlier refusal ends no command.
      expect(refusalsEndingCommand).toEqual([]);
      await expectNoWaiterLeft(handles[3]);
    } finally {
      for (const handle of handles) handle.dispose();
    }
  });

  it("lets a disposed handle's kept purchase outlive the earlier refusal when its ask's own signal still lives and a known owner's joiner waits", async () => {
    const handles = await handlesOf(4, true);
    const [earlier, starter, joiner] = handles;
    const commandSignal = new AbortController();
    try {
      const refusalsEndingCommand: string[] = [];
      earlier.tokens.onRefusalEndingCommand((evidence) => {
        refusalsEndingCommand.push(evidence.hostId);
      });
      const askedEarlier = earlier.tokens.mintFresh(hostId, null);
      await untilSent(1);
      await storedSignInMovesOn(starter);
      const askedByStarter = starter.tokens.mintFresh(
        hostId,
        commandSignal.signal,
      );
      await untilSent(2);
      const askedByJoiner = joiner.tokens.mintFresh(hostId, null);
      await flush();
      expect(harness.mints).toHaveLength(2);

      // The starter's handle is disposed; its ask's own signal still lives, so its write is not fenced and lands first.
      starter.dispose();
      await flush();
      answerWithToken(1);
      expect(tokenOf(await askedByJoiner)).toBe("host-token-bought-1");
      await askedByStarter;
      expect(harness.mints[1]?.abortedWhenAnswered).toBe(false);

      harness.mints[0]?.answer({ kind: "not-a-member" });
      await askedEarlier;
      // Ordered before the starter's kept purchase, the refusal ends no command.
      expect(refusalsEndingCommand).toEqual([]);
      await expectNoWaiterLeft(handles[3]);
    } finally {
      commandSignal.abort();
      for (const handle of handles) handle.dispose();
    }
  });
});
