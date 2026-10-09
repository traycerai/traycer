import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAttachGrantProvider,
  createSandboxAttachGrantProvider,
  mintAttachGrantViaHttp,
} from "../grant-client";
import { SANDBOX_FROZEN_MESSAGE } from "../../../host-client/sandbox-control";

const AUTHN = "https://authn.test";
const HOST_ID = "host-1";
const BEARER = "user-bearer";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mintAttachGrantViaHttp", () => {
  it("parses T9's { grant, role, expires_in } shape and carries the TTL in seconds", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ grant: "jws-abc", role: "client", expires_in: 120 }, 200),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    expect(result).toEqual({
      kind: "ok",
      grant: { grant: "jws-abc", expiresInSeconds: 120 },
      sessionGrant: null,
    });

    // POST with the user bearer + a role:"client" body to the T9 endpoint.
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://authn.test/api/v3/hosts/host-1/attach-grant",
    );
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${BEARER}`);
    expect(JSON.parse(String(init?.body))).toEqual({ role: "client" });
  });

  it("maps 401/403 to unauthorized, with the status in the detail and the body alongside it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({ error: "nope" }, 403)),
    );
    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    expect(result).toMatchObject({ kind: "unauthorized" });
    if (result.kind === "unauthorized") {
      expect(result.detail).toContain("HTTP 403");
      expect(result.context).toContain("nope");
    }
  });

  it("maps a 5xx to network-error, carrying the status in the detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({}, 503)),
    );
    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    expect(result).toMatchObject({ kind: "network-error" });
    if (result.kind === "network-error") {
      expect(result.detail).toContain("HTTP 503");
    }
  });

  it("fails closed on a body missing expires_in (old ISO shape)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse({ grant: "jws", expiresAt: "2026-01-01" }, 200),
      ),
    );
    expect(await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER)).toMatchObject({
      kind: "network-error",
    });
  });

  it("maps a thrown fetch (transport/timeout) to network-error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error("boom");
      }),
    );
    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    expect(result).toMatchObject({ kind: "network-error" });
    if (result.kind === "network-error") {
      // The thrown error's message survives - a DNS failure, a refusal and the
      // mint timeout must not read identically. It survives in `context`, not
      // in `detail`: a message is per-attempt text (it carries the address the
      // attempt resolved), and `detail` is the dedup key. What discriminates
      // those three in the key is the error class and the cause's `code`, which
      // is what the fetch-throw dedup tests below pin.
      expect(result.context).toContain("boom");
    }
  });
});

describe("mintAttachGrantViaHttp 403 handling", () => {
  it("a 403 whose body carries reason plan_restricted is an ordinary unauthorized, like any other 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          {
            statusCode: 403,
            error: "Remote host connectivity requires a paid plan",
            reason: "plan_restricted",
          },
          403,
        ),
      ),
    );
    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    expect(result).toMatchObject({ kind: "unauthorized" });
    if (result.kind === "unauthorized") {
      expect(result.detail).toContain("HTTP 403");
      expect(result.context).toContain("plan_restricted");
    }
  });

  it("403 with an unparsable body stays a credential rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("nope", { status: 403 })),
    );
    expect(await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER)).toMatchObject({
      kind: "unauthorized",
    });
  });
});

describe("createAttachGrantProvider", () => {
  it("returns unavailable when signed out (no bearer)", async () => {
    const provider = createAttachGrantProvider({
      authnBaseUrl: AUTHN,
      hostId: HOST_ID,
      getBearerToken: () => null,
    });
    const provision = await provider();
    expect(provision).toMatchObject({ kind: "unavailable" });
    if (provision.kind === "unavailable") {
      // Points at sign-in state, not at authn's endpoint.
      expect(provision.detail).toContain("signed out");
    }
  });

  it("returns the minted grant on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          { grant: "jws-xyz", role: "client", expires_in: 300 },
          200,
        ),
      ),
    );
    const provider = createAttachGrantProvider({
      authnBaseUrl: AUTHN,
      hostId: HOST_ID,
      getBearerToken: () => BEARER,
    });
    expect(await provider()).toEqual({
      kind: "ok",
      grant: { grant: "jws-xyz", expiresInSeconds: 300 },
    });
  });

  it("collapses every non-ok mint to unavailable, a plan_restricted 403 body included", async () => {
    const provider = createAttachGrantProvider({
      authnBaseUrl: AUTHN,
      hostId: HOST_ID,
      getBearerToken: () => BEARER,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          { statusCode: 403, error: "x", reason: "plan_restricted" },
          403,
        ),
      ),
    );
    expect(await provider()).toMatchObject({ kind: "unavailable" });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse({ statusCode: 403, error: "revoked" }, 403),
      ),
    );
    expect(await provider()).toMatchObject({ kind: "unavailable" });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({}, 503)),
    );
    expect(await provider()).toMatchObject({ kind: "unavailable" });
  });
});

describe("mint failure detail", () => {
  it("carries a 500 body through the provider - the body frequently names the outage", async () => {
    // The real staging outage body: authn had no attach-grant signing key.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          {
            statusCode: 500,
            message: `JWE key with ID 'signing class "attach-grant"' not found`,
          },
          500,
        ),
      ),
    );
    const provider = createAttachGrantProvider({
      authnBaseUrl: AUTHN,
      hostId: HOST_ID,
      getBearerToken: () => BEARER,
    });
    const provision = await provider();
    expect(provision).toMatchObject({ kind: "unavailable" });
    if (provision.kind === "unavailable") {
      expect(provision.detail).toContain("HTTP 500");
      expect(provision.context).toContain("attach-grant");
    }
  });

  it("keeps the body OUT of the dedup key, so a varying body cannot defeat the throttle", async () => {
    // `detail` is what `DialFailureLog` compares to decide whether anything
    // changed. Two attempts against the same fault must produce the same
    // `detail` even when the server tags each response differently - otherwise
    // every retry reads as a cause change and the throttle is bypassed.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse({ error: "internal", request_id: "req-1" }, 500),
      ),
    );
    const first = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse({ error: "internal", request_id: "req-2" }, 500),
      ),
    );
    const second = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    if (first.kind !== "network-error" || second.kind !== "network-error") {
      throw new Error("expected two network-error results");
    }
    expect(first.detail).toBe(second.detail);
    expect(first.context).not.toBe(second.context);
    expect(first.context).toContain("req-1");
  });

  it("keeps a per-attempt ADDRESS out of the dedup key on the fetch-throw path", async () => {
    // The other half of the same rule, on the path that never reaches a
    // response at all. `connect ECONNREFUSED 10.0.0.1:443` names the address
    // THIS attempt resolved, so a multi-address endpoint (or a proxy pool)
    // rotates it while the outage never changes - and a `detail` built from
    // that message would read as a fresh cause on every single retry.
    const details = new Set<string>();
    const contexts: string[] = [];
    for (const address of ["10.0.0.1:443", "10.0.0.2:443", "10.0.0.3:443"]) {
      const cause = new Error(`connect ECONNREFUSED ${address}`);
      Object.assign(cause, { code: "ECONNREFUSED" });
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => {
          throw new TypeError("fetch failed", { cause });
        }),
      );
      const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
      if (result.kind !== "network-error") {
        throw new Error(`expected network-error, got ${result.kind}`);
      }
      details.add(result.detail);
      contexts.push(result.context);
    }
    // One unchanged fault: one unchanged key.
    expect(details.size).toBe(1);
    expect([...details][0]).toContain("ECONNREFUSED");
    // ...and the address is still REPORTED, just as context rather than as
    // identity - so a reader can still see which endpoint refused.
    expect(contexts).toEqual([
      "fetch failed: connect ECONNREFUSED 10.0.0.1:443",
      "fetch failed: connect ECONNREFUSED 10.0.0.2:443",
      "fetch failed: connect ECONNREFUSED 10.0.0.3:443",
    ]);
  });

  it("separates two DIFFERENT network faults, so the key is not stable-by-being-useless", async () => {
    // Guards the obvious over-correction: collapsing every fetch throw to one
    // constant would also dedup perfectly, and would hide a DNS failure
    // turning into a refusal.
    const refused = new Error("connect ECONNREFUSED 10.0.0.1:443");
    Object.assign(refused, { code: "ECONNREFUSED" });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("fetch failed", { cause: refused });
      }),
    );
    const first = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);

    const notFound = new Error("getaddrinfo ENOTFOUND authn.test");
    Object.assign(notFound, { code: "ENOTFOUND" });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("fetch failed", { cause: notFound });
      }),
    );
    const second = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);

    if (first.kind !== "network-error" || second.kind !== "network-error") {
      throw new Error("expected two network-error results");
    }
    expect(first.detail).not.toBe(second.detail);
    expect(first.detail).toContain("ECONNREFUSED");
    expect(second.detail).toContain("ENOTFOUND");
  });

  it("stops READING an oversized body rather than buffering it to truncate it", async () => {
    // The 200-character log cap is not a memory cap: `response.text()` would
    // decode the whole body first, and a 5xx here enters the session's
    // forever-retrying mint loop. This body never ends, so anything that
    // buffers it to completion hangs here instead of returning.
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let chunksPulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        chunksPulled += 1;
        controller.enqueue(chunk);
      },
      cancel: () => {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(body, { status: 502 })),
    );
    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    if (result.kind !== "network-error") {
      throw new Error(`expected network-error, got ${result.kind}`);
    }
    expect(result.detail).toContain("HTTP 502");
    expect(result.context.length).toBeLessThan(300);
    // A couple of 64 KiB chunks at most, and the rest of the stream released
    // rather than drained into memory nobody reads.
    expect(chunksPulled).toBeLessThanOrEqual(3);
    expect(cancelled).toBe(true);
  });

  it("decodes at most the cap even when ONE chunk exceeds it", async () => {
    // The read loop only re-checks the budget between reads, so a single
    // oversized chunk would be decoded whole — into a JS string, the expensive
    // half — and the advertised cap would bound nothing. Counted at the
    // decoder, which is the thing actually paying the cost.
    const decodeSpy = vi.spyOn(TextDecoder.prototype, "decode");
    const oneHugeChunk = new TextEncoder().encode("x".repeat(1024 * 1024));
    let delivered = false;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (delivered) {
          controller.close();
          return;
        }
        delivered = true;
        controller.enqueue(oneHugeChunk);
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(body, { status: 502 })),
    );
    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    if (result.kind !== "network-error") {
      throw new Error(`expected network-error, got ${result.kind}`);
    }
    const decodedBytes = decodeSpy.mock.calls.reduce(
      (total, [input]) =>
        total + (input instanceof Uint8Array ? input.byteLength : 0),
      0,
    );
    expect(decodedBytes).toBeLessThanOrEqual(64 * 1024);
    expect(result.context.length).toBeLessThan(300);
    decodeSpy.mockRestore();
  });

  it("never echoes a 2xx body - it carries the grant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () => new Response("secret-grant-bytes {", { status: 200 }),
      ),
    );
    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    expect(result).toMatchObject({ kind: "network-error" });
    if (result.kind === "network-error") {
      expect(result.detail).not.toContain("secret-grant-bytes");
      expect(result.context).toBe("");
    }
  });
});

describe("mintAttachGrantViaHttp session grant", () => {
  it("carries the host-bound session grant authn mints beside the attach grant for a sandbox", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          {
            grant: "jws-abc",
            role: "client",
            expires_in: 120,
            session_grant: "session-jws",
            session_grant_expires_in: 600,
          },
          200,
        ),
      ),
    );
    expect(await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER)).toEqual({
      kind: "ok",
      grant: { grant: "jws-abc", expiresInSeconds: 120 },
      sessionGrant: "session-jws",
    });
  });

  it("rejects an empty session grant as a malformed body rather than reading it as a grant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          {
            grant: "jws-abc",
            role: "client",
            expires_in: 120,
            session_grant: "",
          },
          200,
        ),
      ),
    );
    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    expect(result.kind).toBe("network-error");
  });
});

describe("createSandboxAttachGrantProvider", () => {
  const deps = (token: string | null) => ({
    authnBaseUrl: AUTHN,
    hostId: HOST_ID,
    getBearerToken: () => token,
  });

  it("returns the attach grant and exposes the session grant minted for the same attach", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          {
            grant: "jws-abc",
            role: "client",
            expires_in: 120,
            session_grant: "session-1",
          },
          200,
        ),
      ),
    );
    const source = createSandboxAttachGrantProvider(deps(BEARER));
    expect(source.readSessionGrant()).toBeNull();

    expect(await source.provider()).toEqual({
      kind: "ok",
      grant: { grant: "jws-abc", expiresInSeconds: 120 },
    });
    expect(source.readSessionGrant()).toBe("session-1");
  });

  it("fails closed when authn mints no session grant for a sandbox, never falling back to the user bearer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          { grant: "jws-abc", role: "client", expires_in: 120 },
          200,
        ),
      ),
    );
    const source = createSandboxAttachGrantProvider(deps(BEARER));
    expect(await source.provider()).toEqual({
      kind: "unavailable",
      detail: "authn minted no session grant for a sandbox target",
      context: "",
    });
    expect(source.readSessionGrant()).toBeNull();
  });

  it("keeps the last session grant through a failed re-mint and replaces it on the next good one", async () => {
    const answers = [
      jsonResponse(
        { grant: "g1", role: "client", expires_in: 120, session_grant: "s1" },
        200,
      ),
      jsonResponse({}, 503),
      jsonResponse(
        { grant: "g2", role: "client", expires_in: 120, session_grant: "s2" },
        200,
      ),
    ];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => answers[call++]),
    );
    const source = createSandboxAttachGrantProvider(deps(BEARER));
    await source.provider();
    expect(source.readSessionGrant()).toBe("s1");
    expect((await source.provider()).kind).toBe("unavailable");
    expect(source.readSessionGrant()).toBe("s1");
    await source.provider();
    expect(source.readSessionGrant()).toBe("s2");
  });

  it("says there is no user bearer, and calls authn not at all, when signed out", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const source = createSandboxAttachGrantProvider(deps(null));
    expect(await source.provider()).toEqual({
      kind: "unavailable",
      detail: "no user bearer available (signed out?)",
      context: "",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("mintAttachGrantViaHttp 402 handling", () => {
  const FROZEN_DETAIL =
    "authn refused the mint: the sandbox is frozen (HTTP 402 sandbox_frozen)";

  it("maps a 402 whose JSON body code is sandbox_frozen to sandbox-frozen, with the stable detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse({ code: "sandbox_frozen" }, 402),
      ),
    );
    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    expect(result).toMatchObject({
      kind: "sandbox-frozen",
      detail: FROZEN_DETAIL,
    });
  });

  it("keeps the same detail when the body carries extra fields, such as a message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          { code: "sandbox_frozen", message: "credits ran out at 12:03" },
          402,
        ),
      ),
    );
    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    expect(result).toMatchObject({
      kind: "sandbox-frozen",
      detail: FROZEN_DETAIL,
    });
  });

  it("leaves a 402 with any other code a network-error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse({ code: "insufficient_credit" }, 402),
      ),
    );
    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    expect(result).toMatchObject({
      kind: "network-error",
      detail: "authn answered HTTP 402",
    });
  });

  it("leaves a 402 with a non-JSON body a network-error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response("<html>payment required</html>", { status: 402 }),
      ),
    );
    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    expect(result).toMatchObject({
      kind: "network-error",
      detail: "authn answered HTTP 402",
    });
  });

  it("leaves a 402 with a JSON body that has no code a network-error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({ error: "pay up" }, 402)),
    );
    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    expect(result).toMatchObject({
      kind: "network-error",
      detail: "authn answered HTTP 402",
    });
  });

  it("keeps a 403 unauthorized even when its body names sandbox_frozen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse({ code: "sandbox_frozen" }, 403),
      ),
    );
    const result = await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER);
    expect(result).toMatchObject({ kind: "unauthorized" });
  });
});

describe("attach grant providers on a frozen sandbox", () => {
  const FROZEN_DETAIL =
    "authn refused the mint: the sandbox is frozen (HTTP 402 sandbox_frozen)";
  const deps = {
    authnBaseUrl: AUTHN,
    hostId: HOST_ID,
    getBearerToken: () => BEARER,
  };

  function stub402(body: unknown): void {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse(body, 402)),
    );
  }

  it("createAttachGrantProvider answers refused, with the SANDBOX_FROZEN fatal and the frozen copy", async () => {
    stub402({ code: "sandbox_frozen" });
    const provision = await createAttachGrantProvider(deps)();
    expect(provision).toMatchObject({
      kind: "refused",
      detail: FROZEN_DETAIL,
      fatal: {
        code: "SANDBOX_FROZEN",
        reason: SANDBOX_FROZEN_MESSAGE,
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
  });

  it("createSandboxAttachGrantProvider answers refused the same way, and keeps no session grant", async () => {
    stub402({ code: "sandbox_frozen" });
    const source = createSandboxAttachGrantProvider(deps);
    const provision = await source.provider();
    expect(provision).toMatchObject({
      kind: "refused",
      detail: FROZEN_DETAIL,
      fatal: {
        code: "SANDBOX_FROZEN",
        reason: SANDBOX_FROZEN_MESSAGE,
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
    expect(source.readSessionGrant()).toBeNull();
  });

  it("both providers keep a 402 with any other code unavailable", async () => {
    stub402({ code: "insufficient_credit" });
    expect(await createAttachGrantProvider(deps)()).toMatchObject({
      kind: "unavailable",
      detail: "authn answered HTTP 402",
    });
    expect(
      await createSandboxAttachGrantProvider(deps).provider(),
    ).toMatchObject({
      kind: "unavailable",
      detail: "authn answered HTTP 402",
    });
  });

  it("both providers keep a 403 unavailable, not refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({ error: "revoked" }, 403)),
    );
    expect(await createAttachGrantProvider(deps)()).toMatchObject({
      kind: "unavailable",
    });
    expect(
      await createSandboxAttachGrantProvider(deps).provider(),
    ).toMatchObject({ kind: "unavailable" });
  });
});
