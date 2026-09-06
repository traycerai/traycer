import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthCodeExchangeResult } from "@traycer-clients/shared/auth/auth-validation";
import type { AuthIdentityValidationResult } from "@traycer-clients/shared/auth/auth-validation-types";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import {
  runAppSessionMint,
  WEB_MINT_NAVIGATION_KEY,
  WEB_MINT_TARGET_KEY,
  WEB_MINT_VERIFIER_KEY,
  webCryptoPkce,
  type AppSessionMintOutcome,
  type MintLocation,
  type MintPkce,
  type MintScratchpad,
} from "@traycer-clients/webapp/app-session-mint";
import {
  WebTokenStore,
  type WebCredentialRefresh,
  type WebCredentialStorage,
  type WebIdentityProbe,
  type WebLockManager,
} from "@traycer-clients/webapp/web-token-store";

/**
 * The one origin this shell is served from: the web dashboard's own, which is
 * what makes `/login/app` a same-origin relative hop and what authn's CORS
 * admits (see `vite.config.ts`).
 */
const ORIGIN = "https://platform.test";

/** The deep link the visitor actually asked for, query and fragment included. */
const DEEP_LINK = "/app/epics/epic-1?tab=plan#step-2";

const IDENTITY = createAuthenticatedUserFixture(undefined);

// ---------------------------------------------------------------------------
// The platform, as doubles
// ---------------------------------------------------------------------------

/** One `localStorage` behind N contexts of the origin, as a browser has. */
class FakeOrigin {
  private readonly values = new Map<string, string>();
  private readonly contexts: Map<string, (() => void)[]>[] = [];

  openContext(): WebCredentialStorage {
    const handlers = new Map<string, (() => void)[]>();
    this.contexts.push(handlers);
    return {
      read: (key) => this.values.get(key) ?? null,
      write: (key, value) => {
        this.values.set(key, value);
        this.broadcast(handlers, key);
      },
      remove: (key) => {
        this.values.delete(key);
        this.broadcast(handlers, key);
      },
      onExternalChange: (key, handler) => {
        const existing = handlers.get(key) ?? [];
        existing.push(handler);
        handlers.set(key, existing);
      },
    };
  }

  keys(): string[] {
    return Array.from(this.values.keys()).sort();
  }

  private broadcast(writer: Map<string, (() => void)[]>, key: string): void {
    for (const context of this.contexts) {
      if (context === writer) continue;
      for (const handler of context.get(key) ?? []) {
        handler();
      }
    }
  }
}

const serialLocks: WebLockManager = {
  runExclusive: (name, task) => {
    void name;
    return task();
  },
};

const unusedRefresh: WebCredentialRefresh = async () => ({ kind: "rejected" });
const unusedProbe: WebIdentityProbe = async () => ({ kind: "network-error" });

function storeOver(storage: WebCredentialStorage): WebTokenStore {
  return new WebTokenStore({
    storage,
    locks: serialLocks,
    authnBaseUrl: ORIGIN,
    refresh: unusedRefresh,
    probeIdentity: unusedProbe,
  });
}

/**
 * Authn's two halves of this flow: `issue-code` (which the dashboard calls
 * with its own session) and `exchange-code` (which this shell calls with the
 * verifier). Codes are single-use and PKCE-bound - the two properties the
 * whole design rests on.
 */
class FakeAuthn {
  readonly exchangeAttempts: string[] = [];
  private readonly issued = new Map<string, string>();
  private counter = 0;

  issueCode(codeChallenge: string): string {
    this.counter += 1;
    const code = `code-${this.counter}`;
    this.issued.set(code, codeChallenge);
    return code;
  }

  get issuedCount(): number {
    return this.counter;
  }

  readonly exchange = async (
    code: string,
    codeVerifier: string,
  ): Promise<AuthCodeExchangeResult> => {
    this.exchangeAttempts.push(code);
    const challenge = this.issued.get(code);
    if (challenge === undefined) {
      // Unknown, expired or already spent - authn answers 4xx, which the
      // shared client maps to a terminal `rejected`.
      return { kind: "rejected" };
    }
    this.issued.delete(code);
    if (challengeOf(codeVerifier) !== challenge) {
      return { kind: "rejected" };
    }
    return {
      kind: "exchanged",
      token: `access-${code}`,
      refreshToken: `refresh-${code}`,
    };
  };
}

/**
 * The S256 derivation as AUTHN computes it
 * (`createHash("sha256").update(verifier).digest("base64url")`, mirrored from
 * the deployed `exchange-code` route). The doubles verify against this rather
 * than against the client helper, so a client-side derivation that drifted
 * from the server's would fail here instead of agreeing with itself.
 */
function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

let verifierSerial = 0;

const testPkce: MintPkce = {
  generateVerifier: () => {
    verifierSerial += 1;
    return `verifier-${verifierSerial}`;
  },
  deriveChallenge: webCryptoPkce.deriveChallenge,
};

/** Where the browser ends up after the dashboard serves one URL. */
interface Dashboard {
  visit(rawUrl: string): string;
}

/**
 * The sign-in handoff as DEPLOYED, not as would be convenient. This shell is a
 * pure consumer of that contract, so a double written against a friendlier one
 * would certify nothing - every behaviour below is one this flow actually has
 * to survive:
 *
 *  - the handoff persists the redirect uri and the PKCE challenge as soon as
 *    it is reached, before any auth gate can turn a signed-out visitor around;
 *  - with a session it issues a one-time code and returns to the redirect uri
 *    with `code` SET on it - which is why a fragment survives, and why a
 *    `code` the destination already carried does not;
 *  - it is not reachable signed out: that visitor is bounced to sign-in, which
 *    carries the redirect uri onward and keeps a stored challenge as long as
 *    the redirect uri has not changed;
 *  - after sign-in, the continuation picks its destination from what survived:
 *    a redirect uri WITH a challenge is this app's handoff, a redirect uri
 *    alone is the editor-extension one, which hands back an encrypted token
 *    payload and never a code;
 *  - a missing redirect uri or challenge is a terminal error page that
 *    redirects nowhere.
 */
class DeployedDashboardStub implements Dashboard {
  private redirectUri: string | null = null;
  private challenge: string | null = null;
  private challengeMethod: string | null = null;

  constructor(
    private readonly authn: FakeAuthn,
    private signedIn: boolean,
  ) {}

  visit(rawUrl: string): string {
    const url = new URL(rawUrl);
    if (url.pathname === "/login/app") {
      return this.visitLoginApp(url);
    }
    if (url.pathname === "/login") {
      return this.visitLogin(url);
    }
    throw new Error(`the stub serves no route at ${url.pathname}`);
  }

  private visitLoginApp(url: URL): string {
    this.persistRedirectUri(url.searchParams.get("redirect_uri"));
    this.persistChallenge(
      url.searchParams.get("code_challenge"),
      url.searchParams.get("code_challenge_method"),
    );
    if (!this.signedIn) {
      const next = new URL("/login", ORIGIN);
      const explicit = validRedirectUri(url.searchParams.get("redirect_uri"));
      if (explicit !== null) {
        next.searchParams.set("redirect_uri", explicit);
      }
      next.searchParams.set("redirectTo", `${url.pathname}${url.search}`);
      return next.toString();
    }
    const redirectUri = validRedirectUri(url.searchParams.get("redirect_uri"));
    const challenge = url.searchParams.get("code_challenge") ?? this.challenge;
    if (redirectUri === null || challenge === null) {
      return url.toString();
    }
    const code = this.authn.issueCode(challenge);
    this.clearBundle();
    const back = new URL(redirectUri, ORIGIN);
    back.searchParams.set("code", code);
    return back.toString();
  }

  private visitLogin(url: URL): string {
    const previous = this.redirectUri;
    const redirectUri = this.persistRedirectUri(
      url.searchParams.get("redirect_uri"),
    );
    const challengeParam = url.searchParams.get("code_challenge");
    if (challengeParam !== null && challengeParam.length > 0) {
      this.persistChallenge(
        challengeParam,
        url.searchParams.get("code_challenge_method"),
      );
    } else if (redirectUri === null || redirectUri !== previous) {
      this.persistChallenge(null, null);
    }
    // The visitor completes a full sign-in here; the continuation below is
    // what the callback runs once the session exists.
    this.signedIn = true;
    return this.continueAfterSignIn();
  }

  private continueAfterSignIn(): string {
    if (this.redirectUri !== null && this.challenge !== null) {
      const next = new URL("/login/app", ORIGIN);
      next.searchParams.set("redirect_uri", this.redirectUri);
      next.searchParams.set("code_challenge", this.challenge);
      next.searchParams.set(
        "code_challenge_method",
        this.challengeMethod ?? "S256",
      );
      return this.visitLoginApp(next);
    }
    if (this.redirectUri !== null) {
      const back = new URL(this.redirectUri, ORIGIN);
      back.searchParams.set("traycer-tokens", "encrypted-extension-payload");
      this.clearBundle();
      return back.toString();
    }
    return new URL("/settings", ORIGIN).toString();
  }

  private persistRedirectUri(candidate: string | null): string | null {
    this.redirectUri = validRedirectUri(candidate);
    return this.redirectUri;
  }

  private persistChallenge(
    challenge: string | null,
    method: string | null,
  ): void {
    if (challenge === null || challenge.length === 0) {
      this.challenge = null;
      this.challengeMethod = null;
      return;
    }
    this.challenge = challenge;
    this.challengeMethod =
      method !== null && method.length > 0 ? method : "S256";
  }

  private clearBundle(): void {
    this.redirectUri = null;
    this.challenge = null;
    this.challengeMethod = null;
  }
}

/**
 * The handoff's redirect-uri validation, relative arm: a same-origin
 * reference is admitted as given, a protocol-relative one is not.
 */
function validRedirectUri(candidate: string | null): string | null {
  if (candidate === null || candidate.length === 0) return null;
  return candidate.startsWith("/") && !candidate.startsWith("//")
    ? candidate
    : null;
}

interface MintOverrides {
  readonly exchange:
    | ((code: string, codeVerifier: string) => Promise<AuthCodeExchangeResult>)
    | undefined;
  readonly probeIdentity:
    | ((token: string) => Promise<AuthIdentityValidationResult>)
    | undefined;
  readonly pkce: MintPkce | undefined;
}

const NO_OVERRIDES: MintOverrides = {
  exchange: undefined,
  probeIdentity: undefined,
  pkce: undefined,
};

const validIdentity = async (
  token: string,
): Promise<AuthIdentityValidationResult> => {
  void token;
  return { kind: "valid", user: IDENTITY };
};

/**
 * The tab's address bar. A live view rather than a snapshot: the flow re-reads
 * it after scrubbing a spent code out, and the retry it may then start has to
 * see the scrubbed value.
 */
class TabLocation implements MintLocation {
  constructor(private readonly tab: Tab) {}

  get href(): string {
    return this.tab.href;
  }

  navigate(url: string): void {
    this.tab.navigations.push(url);
    this.tab.href = url;
  }

  rewrite(url: string): void {
    this.tab.href = new URL(url, this.tab.href).toString();
  }
}

/**
 * One browser tab: its address bar, its `sessionStorage`, and its view of the
 * origin's shared credential slot.
 */
class Tab {
  href: string;
  readonly navigations: string[] = [];
  readonly slots = new Map<string, string>();
  readonly store: WebTokenStore;
  readonly location: MintLocation;
  readonly scratchpad: MintScratchpad;

  constructor(
    private readonly authn: FakeAuthn,
    storage: WebCredentialStorage,
    path: string,
  ) {
    this.href = new URL(path, ORIGIN).toString();
    this.store = storeOver(storage);
    this.location = new TabLocation(this);
    this.scratchpad = {
      read: (key) => this.slots.get(key) ?? null,
      write: (key, value) => {
        this.slots.set(key, value);
      },
      remove: (key) => {
        this.slots.delete(key);
      },
    };
  }

  boot(overrides: MintOverrides): Promise<AppSessionMintOutcome> {
    return runAppSessionMint({
      location: this.location,
      scratchpad: this.scratchpad,
      tokenStore: this.store,
      authnBaseUrl: ORIGIN,
      exchange: overrides.exchange ?? this.authn.exchange,
      probeIdentity: overrides.probeIdentity ?? validIdentity,
      pkce: overrides.pkce ?? testPkce,
    });
  }
}

/**
 * Drives boot → dashboard → boot until the flow settles, with a hard cap.
 *
 * The cap is not a convenience: "never a redirect loop" is an acceptance
 * criterion, and an unbounded driver would express a regression as a hung
 * test rather than a failed one.
 */
async function settle(
  tab: Tab,
  dashboard: Dashboard,
  overrides: MintOverrides,
): Promise<AppSessionMintOutcome> {
  for (let hop = 0; hop < 8; hop += 1) {
    const outcome = await tab.boot(overrides);
    if (outcome.kind !== "navigating") {
      return outcome;
    }
    tab.href = serveDashboard(dashboard, tab.href);
  }
  throw new Error("the mint never settled: the flow looped");
}

/**
 * Runs the dashboard's own hops - the sign-out bounce to `/login`, the
 * sign-in, the continuation back to `/login/app` - until the browser lands
 * somewhere this shell serves again. Those hops are invisible to the shell,
 * which is the point: they are what "signed out" costs, and this flow's own
 * navigation budget must not be charged for them.
 */
function serveDashboard(dashboard: Dashboard, from: string): string {
  let href = from;
  for (let hop = 0; hop < 6; hop += 1) {
    href = dashboard.visit(href);
    if (!new URL(href).pathname.startsWith("/login")) {
      return href;
    }
  }
  throw new Error(`the dashboard never released the browser (${href})`);
}

interface World {
  readonly authn: FakeAuthn;
  readonly dashboard: DeployedDashboardStub;
  readonly origin: FakeOrigin;
  readonly tab: Tab;
}

function buildWorld(signedIn: boolean): World {
  const authn = new FakeAuthn();
  const origin = new FakeOrigin();
  return {
    authn,
    dashboard: new DeployedDashboardStub(authn, signedIn),
    origin,
    tab: new Tab(authn, origin.openContext(), DEEP_LINK),
  };
}

/**
 * A dashboard whose handoff URL has lost the challenge before it arrives -
 * the mutation the both-parameters rule exists to catch.
 */
function challengeStripping(dashboard: Dashboard): Dashboard {
  return {
    visit: (rawUrl) => {
      const url = new URL(rawUrl);
      url.searchParams.delete("code_challenge");
      url.searchParams.delete("code_challenge_method");
      return dashboard.visit(url.toString());
    },
  };
}

/** A dashboard that always sends the visitor back with nothing to spend. */
const codelessDashboard: Dashboard = {
  visit: (rawUrl) => {
    const redirectUri =
      new URL(rawUrl).searchParams.get("redirect_uri") ?? DEEP_LINK;
    return new URL(redirectUri, ORIGIN).toString();
  },
};

// ---------------------------------------------------------------------------

describe("silent sibling mint", () => {
  it("mints a credential from a signed-in dashboard with no interaction", async () => {
    const world = buildWorld(true);

    const outcome = await settle(world.tab, world.dashboard, NO_OVERRIDES);

    expect(outcome).toEqual({ kind: "minted" });
    // One bounce out and one landing back: the whole cost of the handoff.
    expect(world.tab.navigations).toHaveLength(1);
    expect(world.authn.exchangeAttempts).toHaveLength(1);
    const stored = await world.tab.store.get();
    expect(stored?.token).toBe("access-code-1");
    expect(stored?.refreshToken).toBe("refresh-code-1");
    expect(stored?.user.id).toBe(IDENTITY.user.id);
    expect(stored?.user.email).toBe(IDENTITY.user.email);
  });

  it("sends both PKCE parameters with the redirect uri", async () => {
    const world = buildWorld(true);

    await settle(world.tab, world.dashboard, NO_OVERRIDES);

    const handoff = new URL(world.tab.navigations[0] ?? "");
    expect(handoff.origin).toBe(ORIGIN);
    expect(handoff.pathname).toBe("/login/app");
    expect(handoff.searchParams.get("redirect_uri")).toBe(DEEP_LINK);
    expect(handoff.searchParams.get("code_challenge_method")).toBe("S256");
    expect(handoff.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
  });

  it("returns to the exact deep path with query and fragment, and no code", async () => {
    const world = buildWorld(true);

    await settle(world.tab, world.dashboard, NO_OVERRIDES);

    expect(world.tab.href).toBe(new URL(DEEP_LINK, ORIGIN).toString());
  });

  it("derives a challenge authn's own hash agrees with", async () => {
    const world = buildWorld(true);
    const verifiers: string[] = [];

    await settle(world.tab, world.dashboard, {
      ...NO_OVERRIDES,
      pkce: {
        generateVerifier: () => {
          const verifier = `verifier-pinned-${verifiers.length}`;
          verifiers.push(verifier);
          return verifier;
        },
        deriveChallenge: webCryptoPkce.deriveChallenge,
      },
    });

    // The exchange only succeeds because the doubles re-derive the challenge
    // the way authn does; this states the agreement directly rather than
    // leaving it implied by a passing round trip.
    const handoff = new URL(world.tab.navigations[0] ?? "");
    expect(handoff.searchParams.get("code_challenge")).toBe(
      challengeOf(verifiers[0] ?? ""),
    );
  });

  it("does nothing when a credential is already stored", async () => {
    const world = buildWorld(true);
    await world.tab.store.signIn(
      { token: "existing", refreshToken: "existing-refresh" },
      { id: "user-1", email: "user-1@example.test", name: "User One" },
    );

    const outcome = await settle(world.tab, world.dashboard, NO_OVERRIDES);

    expect(outcome).toEqual({ kind: "stored-credential" });
    expect(world.tab.navigations).toEqual([]);
    expect(world.authn.issuedCount).toBe(0);
  });
});

describe("signed-out continuation", () => {
  it("comes back with a code after a full sign-in", async () => {
    const world = buildWorld(false);

    const outcome = await settle(world.tab, world.dashboard, NO_OVERRIDES);

    expect(outcome).toEqual({ kind: "minted" });
    expect(world.tab.href).toBe(new URL(DEEP_LINK, ORIGIN).toString());
    // Still ONE navigation from this shell: the sign-in hops happen inside the
    // dashboard, and the visitor comes back with a spendable code the first
    // time - no second attempt was needed.
    expect(world.tab.navigations).toHaveLength(1);
  });

  it("without the challenge the same sign-in returns no code at all", async () => {
    const world = buildWorld(false);

    // The mutation: this shell forgets the challenge on the way out. Nothing
    // errors - the dashboard's continuation simply selects the EXTENSION
    // handoff, which hands back `traycer-tokens` instead of a code.
    const outcome = await world.tab.boot(NO_OVERRIDES);
    world.tab.href = serveDashboard(
      challengeStripping(world.dashboard),
      world.tab.href,
    );

    expect(outcome).toEqual({ kind: "navigating" });
    const landing = new URL(world.tab.href);
    expect(landing.pathname).toBe("/app/epics/epic-1");
    expect(landing.searchParams.has("traycer-tokens")).toBe(true);
    expect(landing.searchParams.has("code")).toBe(false);
    expect(world.authn.issuedCount).toBe(0);
    // And it does not merely cost a retry: the second attempt reaches a
    // now-signed-in `/login/app` with no challenge anywhere, which is that
    // page's terminal "restart sign-in from the app" state - it redirects
    // nowhere, so the visitor is parked on the dashboard instead of being
    // handed back to the device flow.
    expect(await world.tab.boot(NO_OVERRIDES)).toEqual({ kind: "navigating" });
    expect(() =>
      serveDashboard(challengeStripping(world.dashboard), world.tab.href),
    ).toThrow(/never released the browser/);
  });
});

describe("bounded retry", () => {
  it("retries once and then falls back, never looping", async () => {
    const world = buildWorld(true);

    // A dashboard that never appends a code - the shape every disappointment
    // takes on the way back (cancelled, expired, a continuation that chose
    // another handoff).
    const outcome = await settle(world.tab, codelessDashboard, NO_OVERRIDES);

    expect(outcome).toEqual({
      kind: "device-flow-fallback",
      reason: "no-code-returned",
    });
    expect(world.tab.navigations).toHaveLength(2);
  });

  it("retries a rejected code once, with a fresh challenge", async () => {
    const world = buildWorld(true);

    const outcome = await settle(world.tab, world.dashboard, {
      ...NO_OVERRIDES,
      exchange: async (code) => {
        void code;
        return { kind: "rejected" };
      },
    });

    const challenges = world.tab.navigations.map((navigation) =>
      new URL(navigation).searchParams.get("code_challenge"),
    );
    expect(outcome).toEqual({
      kind: "device-flow-fallback",
      reason: "code-rejected",
    });
    expect(world.tab.navigations).toHaveLength(2);
    // A retry that re-used the first verifier would re-present a secret the
    // failed round trip may already have leaked into a redirect URL.
    expect(new Set(challenges).size).toBe(2);
  });

  it("falls back rather than retrying forever when authn is unreachable", async () => {
    const world = buildWorld(true);

    const outcome = await settle(world.tab, world.dashboard, {
      ...NO_OVERRIDES,
      exchange: async () => ({ kind: "network-error" }),
    });

    expect(outcome).toEqual({
      kind: "device-flow-fallback",
      reason: "exchange-unreachable",
    });
    expect(world.tab.navigations).toHaveLength(2);
  });

  it("falls back when the pair cannot be attributed to an identity", async () => {
    const world = buildWorld(true);

    const outcome = await settle(world.tab, world.dashboard, {
      ...NO_OVERRIDES,
      probeIdentity: async () => ({ kind: "network-error" }),
    });

    expect(outcome).toEqual({
      kind: "device-flow-fallback",
      reason: "identity-unresolved",
    });
    expect(await world.tab.store.get()).toBeNull();
  });
});

describe("single-use handoff material", () => {
  it("clears the handoff and the budget once a credential lands", async () => {
    const world = buildWorld(true);

    await settle(world.tab, world.dashboard, NO_OVERRIDES);

    expect(world.tab.slots.has(WEB_MINT_VERIFIER_KEY)).toBe(false);
    expect(world.tab.slots.has(WEB_MINT_TARGET_KEY)).toBe(false);
    expect(world.tab.slots.has(WEB_MINT_NAVIGATION_KEY)).toBe(false);
  });

  it("never re-presents a spent code on a reload", async () => {
    const world = buildWorld(true);
    await settle(world.tab, world.dashboard, NO_OVERRIDES);
    const landing = new URL(world.tab.href);
    landing.searchParams.set("code", "code-1");
    world.tab.href = landing.toString();

    const outcome = await world.tab.boot(NO_OVERRIDES);

    expect(outcome).toEqual({ kind: "stored-credential" });
    expect(world.authn.exchangeAttempts).toEqual(["code-1"]);
  });

  it("treats a code with no handoff in flight as the page's own query", async () => {
    const world = buildWorld(true);
    const foreign = new URL(DEEP_LINK, ORIGIN);
    foreign.searchParams.set("code", "page-value");
    world.tab.href = foreign.toString();

    const outcome = await world.tab.boot(NO_OVERRIDES);

    // This tab is waiting for nothing, so the parameter is not auth material
    // at all: spending it would burn a code whose round trip may still be live
    // elsewhere, and scrubbing it would take a value off a page that owns it.
    expect(outcome).toEqual({ kind: "navigating" });
    expect(world.authn.exchangeAttempts).toEqual([]);
    expect(
      new URL(world.tab.navigations[0] ?? "").searchParams.get("redirect_uri"),
    ).toBe(`${foreign.pathname}${foreign.search}${foreign.hash}`);
  });
});

describe("destination fidelity", () => {
  it("returns a destination that carries its own code parameter intact", async () => {
    const world = buildWorld(true);
    const target = "/app/epics/epic-1?code=page-value&tab=plan#step-2";
    world.tab.href = new URL(target, ORIGIN).toString();

    const outcome = await settle(world.tab, world.dashboard, NO_OVERRIDES);

    // The handoff SETS its code on the destination it is given, so the value
    // the page owned is gone from the landing URL and no inspection of that
    // URL could recover it. Restoring the remembered destination is what makes
    // the round trip lossless.
    expect(outcome).toEqual({ kind: "minted" });
    expect(world.tab.href).toBe(new URL(target, ORIGIN).toString());
    expect(world.authn.exchangeAttempts).toEqual(["code-1"]);
  });

  it("hands the whole destination to the handoff, code parameter included", async () => {
    const world = buildWorld(true);
    const target = "/app/epics/epic-1?code=page-value&tab=plan#step-2";
    world.tab.href = new URL(target, ORIGIN).toString();

    await settle(world.tab, world.dashboard, NO_OVERRIDES);

    expect(
      new URL(world.tab.navigations[0] ?? "").searchParams.get("redirect_uri"),
    ).toBe(target);
  });
});

describe("two tabs of one origin", () => {
  it("adopts a sibling's credential instead of starting its own mint", async () => {
    const authn = new FakeAuthn();
    const origin = new FakeOrigin();
    const first = new Tab(authn, origin.openContext(), DEEP_LINK);
    const second = new Tab(authn, origin.openContext(), "/app/");

    // The sibling commits DURING this tab's challenge derivation - the window
    // between deciding to mint and leaving the page.
    const outcome = await second.boot({
      ...NO_OVERRIDES,
      pkce: {
        generateVerifier: () => "verifier-second",
        deriveChallenge: async (verifier) => {
          await first.store.signIn(
            { token: "sibling-access", refreshToken: "sibling-refresh" },
            { id: "user-1", email: "user-1@example.test", name: "User One" },
          );
          return challengeOf(verifier);
        },
      },
    });

    expect(outcome).toEqual({ kind: "stored-credential" });
    expect(second.navigations).toEqual([]);
    expect((await second.store.get())?.token).toBe("sibling-access");
  });

  it("spends no code when a sibling committed before the landing", async () => {
    const authn = new FakeAuthn();
    const origin = new FakeOrigin();
    const dashboard = new DeployedDashboardStub(authn, true);
    const tab = new Tab(authn, origin.openContext(), DEEP_LINK);
    const sibling = new Tab(authn, origin.openContext(), "/app/");

    // This tab is away on its handoff when the sibling signs in, so the code
    // it comes back holding is already redundant.
    expect(await tab.boot(NO_OVERRIDES)).toEqual({ kind: "navigating" });
    tab.href = serveDashboard(dashboard, tab.href);
    await sibling.store.signIn(
      { token: "sibling-access", refreshToken: "sibling-refresh" },
      { id: "user-1", email: "user-1@example.test", name: "User One" },
    );

    const outcome = await tab.boot(NO_OVERRIDES);

    // Not merely "a credential exists afterwards": nothing was spent to get
    // there, and the sibling's pair is the one that survived. An exchange here
    // would mint a SECOND session for a user who already has one, and the
    // later write would displace the pair every other tab is holding.
    expect(outcome).toEqual({ kind: "stored-credential" });
    expect(authn.exchangeAttempts).toEqual([]);
    expect((await tab.store.get())?.token).toBe("sibling-access");
    expect(tab.href).toBe(new URL(DEEP_LINK, ORIGIN).toString());
  });

  it("a tab blind to that write navigates a signed-in visitor away", async () => {
    const authn = new FakeAuthn();
    const origin = new FakeOrigin();
    const shared = origin.openContext();
    const first = new Tab(authn, shared, DEEP_LINK);
    // The discriminating control: same race, but this tab's view of the origin
    // never reports what the sibling wrote. That is precisely a mint that does
    // not re-read - and it takes the visitor away from a page they can already
    // see.
    const blind = new Tab(authn, { ...shared, read: () => null }, "/app/");

    const outcome = await blind.boot({
      ...NO_OVERRIDES,
      pkce: {
        generateVerifier: () => "verifier-blind",
        deriveChallenge: async (verifier) => {
          await first.store.signIn(
            { token: "sibling-access", refreshToken: "sibling-refresh" },
            { id: "user-1", email: "user-1@example.test", name: "User One" },
          );
          return challengeOf(verifier);
        },
      },
    });

    expect(outcome).toEqual({ kind: "navigating" });
    expect(blind.navigations).toHaveLength(1);
  });
});

describe("adoption releases the budget", () => {
  it("a tab that adopted a sibling's credential can mint again after signing out", async () => {
    const authn = new FakeAuthn();
    const origin = new FakeOrigin();
    const dashboard = new DeployedDashboardStub(authn, true);
    const tab = new Tab(authn, origin.openContext(), DEEP_LINK);
    const sibling = new Tab(authn, origin.openContext(), "/app/");

    // Both navigations spent against a handoff that never returns a code.
    await settle(tab, codelessDashboard, NO_OVERRIDES);
    expect(tab.navigations).toHaveLength(2);
    // A sibling signs in, this tab adopts, and then the user signs out.
    await sibling.store.signIn(
      { token: "sibling-access", refreshToken: "sibling-refresh" },
      { id: "user-1", email: "user-1@example.test", name: "User One" },
    );
    expect(await tab.boot(NO_OVERRIDES)).toEqual({ kind: "stored-credential" });
    await tab.store.delete();

    const outcome = await settle(tab, dashboard, NO_OVERRIDES);

    // The counter bounds ONE unsuccessful stretch. Carrying it across a
    // session that has since begun and ended would strand this still-open tab
    // on the device flow forever.
    expect(outcome).toEqual({ kind: "minted" });
    expect(tab.slots.has(WEB_MINT_NAVIGATION_KEY)).toBe(false);
  });

  it("a budget kept across adoption sends the next boot straight to the device flow", async () => {
    const authn = new FakeAuthn();
    const origin = new FakeOrigin();
    const dashboard = new DeployedDashboardStub(authn, true);
    const tab = new Tab(authn, origin.openContext(), DEEP_LINK);

    // The discriminating control: the same sequence with the counter left
    // behind by hand, which is exactly what an adoption arm that does not
    // clear it produces.
    await settle(tab, codelessDashboard, NO_OVERRIDES);
    tab.slots.set(WEB_MINT_NAVIGATION_KEY, "2");

    const outcome = await settle(tab, dashboard, NO_OVERRIDES);

    expect(outcome).toEqual({
      kind: "device-flow-fallback",
      reason: "no-code-returned",
    });
  });
});

describe("sign-out scope", () => {
  it("app sign-out leaves another app's storage on the origin untouched", async () => {
    const origin = new FakeOrigin();
    const dashboardContext = origin.openContext();
    // Another app's credential on this same origin is a stranger to this
    // shell: a different key, written by a writer this store knows nothing
    // about and must not disturb.
    dashboardContext.write("other-app-storage", '{"credential":"x"}');
    const tab = new Tab(new FakeAuthn(), origin.openContext(), DEEP_LINK);
    await tab.store.signIn(
      { token: "app-access", refreshToken: "app-refresh" },
      { id: "user-1", email: "user-1@example.test", name: "User One" },
    );

    await tab.store.delete();

    expect(origin.keys()).toEqual(["other-app-storage"]);
  });
});
