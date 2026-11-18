import { describe, expect, it } from "vitest";
import {
  createDesktopBearerVerifier,
  type DesktopBearerVerifier,
} from "../bearer-verifier";
import {
  createSigningKey,
  encodeSegment,
  jwksResponse,
  userBearerClaims,
} from "./jws-fixture";

const AUTHN_BASE_URL = "https://authn.example.test";
const USER_ID = "user-victim";

interface Harness {
  readonly verifier: DesktopBearerVerifier;
  readonly urls: string[];
  advance(ms: number): void;
  serve(keys: readonly Record<string, unknown>[]): void;
  fail(): void;
}

function buildHarness(
  initialKeys: readonly Record<string, unknown>[],
  nowMs: number,
): Harness {
  const urls: string[] = [];
  let clock = nowMs;
  let keys: readonly Record<string, unknown>[] | null = initialKeys;
  const verifier = createDesktopBearerVerifier({
    authnBaseUrl: AUTHN_BASE_URL,
    fetchImpl: (input) => {
      urls.push(input);
      if (keys === null) {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve(jwksResponse(keys));
    },
    now: () => clock,
  });
  return {
    verifier,
    urls,
    advance: (ms) => {
      clock += ms;
    },
    serve: (next) => {
      keys = next;
    },
    fail: () => {
      keys = null;
    },
  };
}

describe("desktop bearer verifier", () => {
  const nowMs = Date.UTC(2026, 8, 2, 12, 0, 0);

  it("accepts an authentic bearer for the profile it was sent with", async () => {
    const key = createSigningKey("kid-1", "bearer");
    const harness = buildHarness([key.publicJwk], nowMs);

    const token = key.sign(userBearerClaims(USER_ID, nowMs + 60_000));

    expect(await harness.verifier.verify(token, USER_ID)).toBeNull();
    expect(harness.urls).toEqual([`${AUTHN_BASE_URL}/api/jwks`]);

    // The key set is cached: a second verify does not re-fetch.
    expect(await harness.verifier.verify(token, USER_ID)).toBeNull();
    expect(harness.urls).toHaveLength(1);
  });

  it("refuses a token whose signature was forged over authentic claims", async () => {
    const key = createSigningKey("kid-1", "bearer");
    const attacker = createSigningKey("kid-1", "bearer");
    const harness = buildHarness([key.publicJwk], nowMs);

    // Same `kid`, a key authn-v3 never published.
    const forged = attacker.sign(userBearerClaims(USER_ID, nowMs + 60_000));

    expect(await harness.verifier.verify(forged, USER_ID)).toBe(
      "bad-signature",
    );
  });

  it("refuses an authentic token minted for another account", async () => {
    const key = createSigningKey("kid-1", "bearer");
    const harness = buildHarness([key.publicJwk], nowMs);

    const attackerToken = key.sign(
      userBearerClaims("user-attacker", nowMs + 60_000),
    );

    expect(await harness.verifier.verify(attackerToken, USER_ID)).toBe(
      "subject-mismatch",
    );
  });

  it("refuses an expired token", async () => {
    const key = createSigningKey("kid-1", "bearer");
    const harness = buildHarness([key.publicJwk], nowMs);

    const token = key.sign(userBearerClaims(USER_ID, nowMs - 120_000));

    expect(await harness.verifier.verify(token, USER_ID)).toBe("expired");
  });

  it("refuses a token signed with a key of another class", async () => {
    // A leaked attach-grant/service key must not verify a bearer: the `kid`
    // resolves only against the bearer-class partition, so the published set
    // carries no usable key at all.
    const key = createSigningKey("kid-1", "attach-grant");
    const harness = buildHarness([key.publicJwk], nowMs);

    const token = key.sign(userBearerClaims(USER_ID, nowMs + 60_000));

    expect(await harness.verifier.verify(token, USER_ID)).toBe(
      "key-source-unavailable",
    );
  });

  it("refuses an unsigned token that names its own algorithm", async () => {
    const key = createSigningKey("kid-1", "bearer");
    const harness = buildHarness([key.publicJwk], nowMs);

    const header = encodeSegment({ alg: "none", typ: "JWT", kid: "kid-1" });
    const payload = encodeSegment(userBearerClaims(USER_ID, nowMs + 60_000));

    expect(
      await harness.verifier.verify(`${header}.${payload}.`, USER_ID),
    ).toBe("unsupported-algorithm");
  });

  it("follows a key rotation once the refetch cooldown has passed", async () => {
    const oldKey = createSigningKey("kid-old", "bearer");
    const newKey = createSigningKey("kid-new", "bearer");
    const harness = buildHarness([oldKey.publicJwk], nowMs);

    expect(
      await harness.verifier.verify(
        oldKey.sign(userBearerClaims(USER_ID, nowMs + 60_000)),
        USER_ID,
      ),
    ).toBeNull();

    harness.serve([newKey.publicJwk]);
    const rotated = newKey.sign(userBearerClaims(USER_ID, nowMs + 60_000));

    // Inside the cooldown an unknown `kid` is not chased - the same bound the
    // host runs with, so a forged `kid` cannot become a refetch storm. The
    // set that stays silent about it was fetched before the rotation, so its
    // silence is not a verdict.
    expect(await harness.verifier.verify(rotated, USER_ID)).toBe(
      "signing-key-unconfirmed",
    );

    harness.advance(61_000);
    expect(await harness.verifier.verify(rotated, USER_ID)).toBeNull();
  });

  it("refuses rather than accepts when the key source cannot be reached", async () => {
    const key = createSigningKey("kid-1", "bearer");
    const harness = buildHarness([key.publicJwk], nowMs);
    harness.fail();

    const token = key.sign(userBearerClaims(USER_ID, nowMs + 60_000));

    expect(await harness.verifier.verify(token, USER_ID)).toBe(
      "key-source-unavailable",
    );
  });

  it("costs one JWKS attempt per verify while the key source is down", async () => {
    // The refetch cooldown applies from the FIRST attempt, so a renderer
    // looping `authSessionSet` against a down authn is not a 2x amplifier.
    const key = createSigningKey("kid-1", "bearer");
    const harness = buildHarness([key.publicJwk], nowMs);
    harness.fail();
    const token = key.sign(userBearerClaims(USER_ID, nowMs + 60_000));

    expect(await harness.verifier.verify(token, USER_ID)).toBe(
      "key-source-unavailable",
    );
    expect(harness.urls).toHaveLength(1);

    // And nothing at all until the cooldown has passed.
    expect(await harness.verifier.verify(token, USER_ID)).toBe(
      "key-source-unavailable",
    );
    expect(harness.urls).toHaveLength(1);
  });

  it("keeps an unknown kid unconfirmed after a failed refetch until a refetch answers", async () => {
    const key = createSigningKey("kid-1", "bearer");
    const harness = buildHarness([key.publicJwk], nowMs);
    const stranger = createSigningKey("kid-stranger", "bearer");
    const strangerToken = stranger.sign(
      userBearerClaims(USER_ID, nowMs + 10 * 60_000),
    );

    expect(
      await harness.verifier.verify(
        key.sign(userBearerClaims(USER_ID, nowMs + 10 * 60_000)),
        USER_ID,
      ),
    ).toBeNull();

    // A refetch attempt fails while the fetched set is still inside its max
    // age: an outage, so the `kid` is inconclusive.
    harness.advance(61_000);
    harness.fail();
    expect(await harness.verifier.verify(strangerToken, USER_ID)).toBe(
      "key-source-unavailable",
    );

    // Inside the cooldown there is no new attempt. The set we hold is inside
    // its max age again, so this is no outage - but a check that fetched
    // nothing cannot call the `kid` unknown either.
    harness.advance(1_000);
    expect(await harness.verifier.verify(strangerToken, USER_ID)).toBe(
      "signing-key-unconfirmed",
    );
    expect(harness.urls).toHaveLength(2);

    // A full cooldown after the failed attempt the refetch is made, and a set
    // that still lacks the `kid` is the answer.
    harness.serve([key.publicJwk]);
    harness.advance(60_000);
    expect(await harness.verifier.verify(strangerToken, USER_ID)).toBe(
      "unknown-signing-key",
    );
    expect(harness.urls).toHaveLength(3);
  });

  it("calls a kid missing from the set it just fetched unknown", async () => {
    const key = createSigningKey("kid-1", "bearer");
    const stranger = createSigningKey("kid-stranger", "bearer");
    const harness = buildHarness([key.publicJwk], nowMs);

    expect(
      await harness.verifier.verify(
        stranger.sign(userBearerClaims(USER_ID, nowMs + 60_000)),
        USER_ID,
      ),
    ).toBe("unknown-signing-key");
    expect(harness.urls).toHaveLength(1);
  });

  it("calls a kid missing from a cached set unconfirmed, without a fetch, inside the cooldown", async () => {
    const key = createSigningKey("kid-1", "bearer");
    const stranger = createSigningKey("kid-stranger", "bearer");
    const harness = buildHarness([key.publicJwk], nowMs);

    // Another verify fetched the set moments ago.
    expect(
      await harness.verifier.verify(
        key.sign(userBearerClaims(USER_ID, nowMs + 60_000)),
        USER_ID,
      ),
    ).toBeNull();
    expect(harness.urls).toHaveLength(1);

    harness.advance(1_000);
    expect(
      await harness.verifier.verify(
        stranger.sign(userBearerClaims(USER_ID, nowMs + 60_000)),
        USER_ID,
      ),
    ).toBe("signing-key-unconfirmed");
    expect(harness.urls).toHaveLength(1);
  });

  it("allows the next key fetch one cooldown after a successful attempt", async () => {
    const key = createSigningKey("kid-1", "bearer");
    const stranger = createSigningKey("kid-stranger", "bearer");
    const harness = buildHarness([key.publicJwk], nowMs);
    const strangerToken = stranger.sign(
      userBearerClaims(USER_ID, nowMs + 60_000),
    );

    harness.advance(5_000);
    expect(
      await harness.verifier.verify(
        key.sign(userBearerClaims(USER_ID, nowMs + 60_000)),
        USER_ID,
      ),
    ).toBeNull();
    const attemptedAtMs = nowMs + 5_000;
    expect(harness.verifier.nextFetchAllowedAtMs()).toBe(
      attemptedAtMs + 60_000,
    );

    // One millisecond early the forced refetch is still skipped.
    harness.advance(59_999);
    expect(await harness.verifier.verify(strangerToken, USER_ID)).toBe(
      "signing-key-unconfirmed",
    );
    expect(harness.urls).toHaveLength(1);

    // At the allowed instant it is made, and the allowance moves with it.
    harness.advance(1);
    expect(await harness.verifier.verify(strangerToken, USER_ID)).toBe(
      "unknown-signing-key",
    );
    expect(harness.urls).toHaveLength(2);
    expect(harness.verifier.nextFetchAllowedAtMs()).toBe(
      attemptedAtMs + 60_000 + 60_000,
    );
  });

  it("allows the next key fetch one cooldown after a failed attempt", async () => {
    const key = createSigningKey("kid-1", "bearer");
    const harness = buildHarness([key.publicJwk], nowMs);
    const token = key.sign(userBearerClaims(USER_ID, nowMs + 10 * 60_000));
    harness.fail();

    harness.advance(5_000);
    expect(await harness.verifier.verify(token, USER_ID)).toBe(
      "key-source-unavailable",
    );
    const attemptedAtMs = nowMs + 5_000;
    expect(harness.verifier.nextFetchAllowedAtMs()).toBe(
      attemptedAtMs + 60_000,
    );

    // One millisecond early nothing is fetched, though the source is back.
    harness.serve([key.publicJwk]);
    harness.advance(59_999);
    expect(await harness.verifier.verify(token, USER_ID)).toBe(
      "key-source-unavailable",
    );
    expect(harness.urls).toHaveLength(1);

    harness.advance(1);
    expect(await harness.verifier.verify(token, USER_ID)).toBeNull();
    expect(harness.urls).toHaveLength(2);
  });

  it("keeps verifying against the stale set while the key source is down", async () => {
    const key = createSigningKey("kid-1", "bearer");
    const harness = buildHarness([key.publicJwk], nowMs);
    const token = key.sign(userBearerClaims(USER_ID, nowMs + 60_000 * 60));

    expect(await harness.verifier.verify(token, USER_ID)).toBeNull();

    harness.fail();
    harness.advance(11 * 60_000);

    // Public key material does not stop being valid because the network did.
    expect(await harness.verifier.verify(token, USER_ID)).toBeNull();
  });
});
