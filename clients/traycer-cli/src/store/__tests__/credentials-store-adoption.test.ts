import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredCredentials } from "@traycer/protocol/config/credentials";
import type { CredentialsMutationStore } from "@traycer/protocol/config/credentials-mutation";
import type { AuthTokenRefreshResult } from "../../../../shared/auth/auth-validation";
import { MutableBearerLease } from "../../../../shared/auth/bearer-source";
import {
  SIGN_OUT_ARMS,
  standSignOutArm,
} from "../../internal/__tests__/sign-out-arms-test-support";
import type { Environment } from "../../runner/environment";
import {
  createCliCredentialsStore,
  createStoreBackedRevalidator,
} from "../credentials-store";

// The lease's one writer follows the file (model P, M). The real credentials
// store over a file in a temp directory, with real timers: every interleaving is
// gated on an event (a held read or rotation, a save landing), never on time.

const USER_ID = "user-1";
const SIGN_IN_A = "sign-in-a";
const SIGN_IN_B = "sign-in-b";
const SIGN_IN_C = "sign-in-c";

const authn = vi.hoisted(() => ({
  /** The credentials file under test; empty until a test points the store at its own directory. */
  path: "",
  /** What authn's refresh answers, in the order asked. */
  refreshes: [] as Array<
    | { readonly kind: "refreshed"; readonly token: string }
    | { readonly kind: "rejected" }
  >,
}));

vi.mock("../paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../paths")>();
  return {
    ...actual,
    cliCredentialsPath: (_environment: Environment): string => {
      if (authn.path === "") throw new Error("no credentials file under test");
      return authn.path;
    },
  };
});

vi.mock("../../../../shared/auth/auth-validation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/auth-validation")
    >();
  return {
    ...actual,
    refreshOnceAbortable: async (): Promise<AuthTokenRefreshResult> => {
      const answer = authn.refreshes.shift();
      if (answer === undefined)
        throw new Error("authn was asked for a refresh no test expected");
      return answer.kind === "refreshed"
        ? {
            kind: "refreshed",
            token: answer.token,
            refreshToken: `rt-${answer.token}`,
          }
        : { kind: "rejected", rejection: { kind: "credential", revocation: null } };
    },
  };
});

interface Gate {
  readonly reached: Promise<void>;
  readonly release: Promise<void>;
  readonly markReached: () => void;
  readonly open: () => void;
}

/** One event the test waits for (`reached`) and one it later fires (`open`). */
function gate(): Gate {
  const marks = { markReached: () => undefined, open: () => undefined };
  const reached = new Promise<void>((resolve) => {
    marks.markReached = resolve;
  });
  const release = new Promise<void>((resolve) => {
    marks.open = resolve;
  });
  return { reached, release, ...marks };
}

/** The store, with each read in `gates` held after it has taken its snapshot; later reads pass through. */
function holdingReads(
  store: CredentialsMutationStore,
  gates: readonly Gate[],
): { readonly store: CredentialsMutationStore; readonly started: () => number } {
  let started = 0;
  return {
    started: () => started,
    store: {
      ...store,
      read: async () => {
        const held = gates[started];
        started += 1;
        const snapshot = await store.read();
        held?.markReached();
        await held?.release;
        return snapshot;
      },
    },
  };
}

const credentialsOf = (token: string): StoredCredentials => ({
  token,
  refreshToken: `rt-${token}`,
  savedAt: "2026-01-01T00:00:00.000Z",
  user: { id: USER_ID, email: "user@example.test", name: "User" },
});

let workDir = "";

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "traycer-store-adoption-"));
  authn.path = join(workDir, "credentials");
  authn.refreshes.splice(0);
});

afterEach(async () => {
  authn.path = "";
  await rm(workDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
});

describe("the lease follows the credentials file through one serialised path", () => {
  it("holds the newest sign-in when two adopting reads snapshot the file on either side of a sibling's save", async () => {
    const store = createCliCredentialsStore();
    const otherProcess = createCliCredentialsStore();
    await store.signIn(credentialsOf(SIGN_IN_B), false, null);
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const gates = [gate(), gate()];
    const held = holdingReads(store, gates);
    const revalidator = createStoreBackedRevalidator({
      store: held.store,
      lease,
      signal: null,
    });

    // The first read snapshots B; then a sibling saves C; a second adoption is asked.
    const first = revalidator.adoptStoredSignIn();
    await gates[0]?.reached;
    await otherProcess.signIn(credentialsOf(SIGN_IN_C), false, null);
    const second = revalidator.adoptStoredSignIn();

    // The first returns before the second's snapshot is let go, and then the second.
    gates[0]?.open();
    await first;
    await gates[1]?.reached;
    gates[1]?.open();
    await second;

    expect(lease.getBearerToken()).toBe(SIGN_IN_C);
    store.dispose();
    otherProcess.dispose();
  });

  it("answers a caller that arrives during a read by a read that started after it arrived", async () => {
    const store = createCliCredentialsStore();
    const otherProcess = createCliCredentialsStore();
    await store.signIn(credentialsOf(SIGN_IN_B), false, null);
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const gates = [gate()];
    const held = holdingReads(store, gates);
    const revalidator = createStoreBackedRevalidator({
      store: held.store,
      lease,
      signal: null,
    });

    const first = revalidator.adoptStoredSignIn();
    await gates[0]?.reached;
    // A sibling saves C and a caller arrives, both while the first read is held.
    await otherProcess.signIn(credentialsOf(SIGN_IN_C), false, null);
    const second = revalidator.adoptStoredSignIn();

    // One read runs at a time: the caller's own read has not started.
    expect(held.started()).toBe(1);
    gates[0]?.open();
    await first;
    await second;

    expect(held.started()).toBe(2);
    expect(lease.getBearerToken()).toBe(SIGN_IN_C);
    store.dispose();
    otherProcess.dispose();
  });

  it("never installs a rotation's result over a newer adoption", async () => {
    const store = createCliCredentialsStore();
    const otherProcess = createCliCredentialsStore();
    await store.signIn(credentialsOf(SIGN_IN_A), false, null);
    authn.refreshes.push({ kind: "refreshed", token: SIGN_IN_B });
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    // The rotation commits B and is then held before it hands its result back.
    const rotated = gate();
    const rotatingStore: CredentialsMutationStore = {
      ...store,
      rotate: async (args) => {
        const result = await store.rotate(args);
        rotated.markReached();
        await rotated.release;
        return result;
      },
    };
    const rotating = createStoreBackedRevalidator({
      store: rotatingStore,
      lease,
      signal: null,
    }).rotateSignIn();
    await rotated.reached;

    // A sibling saves C and an adoption installs it while the rotation's result is out.
    await otherProcess.signIn(credentialsOf(SIGN_IN_C), false, null);
    await createStoreBackedRevalidator({
      store,
      lease,
      signal: null,
    }).adoptStoredSignIn();
    expect(lease.getBearerToken()).toBe(SIGN_IN_C);

    // The result lands afterwards: it must not move the lease back to B.
    rotated.open();
    await rotating;
    expect(lease.getBearerToken()).toBe(SIGN_IN_C);
    store.dispose();
    otherProcess.dispose();
  });

  it("carries, on a rejected rotation, the sign-in the locked rotation tried", async () => {
    const store = createCliCredentialsStore();
    await store.signIn(credentialsOf(SIGN_IN_A), false, null);
    authn.refreshes.push({ kind: "rejected" });
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);

    const result = await createStoreBackedRevalidator({
      store,
      lease,
      signal: null,
    }).rotateSignIn();

    expect(result).toMatchObject({ outcome: "rejected", refused: SIGN_IN_A });
    store.dispose();
  });

  // The three arms that answer "rejected" with no refresh to follow carry the
  // sign-in the lease held, as authn's own refusal does.
  it.each(SIGN_OUT_ARMS)(
    "answers rejected for the lease's sign-in when the file is in the %s arm",
    async (arm) => {
      const store = createCliCredentialsStore();
      const otherProcess = createCliCredentialsStore();
      await store.signIn(credentialsOf(SIGN_IN_A), false, null);
      await standSignOutArm(arm, {
        credentialsPath: authn.path,
        otherProcess,
        credentials: credentialsOf(SIGN_IN_A),
      });
      const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);

      const result = await createStoreBackedRevalidator({
        store,
        lease,
        signal: null,
      }).rotateSignIn();

      expect(result).toMatchObject({ outcome: "rejected", refused: SIGN_IN_A });
      expect(lease.getBearerToken()).toBe(SIGN_IN_A);
      store.dispose();
      otherProcess.dispose();
    },
  );
});
