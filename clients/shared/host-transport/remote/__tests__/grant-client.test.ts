import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAttachGrantProvider,
  mintAttachGrantViaHttp,
} from "../grant-client";

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

describe("mintAttachGrantViaHttp plan-restricted discrimination", () => {
  it("403 + reason plan_restricted → plan-restricted (entitlement, not auth)", async () => {
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
    expect(await mintAttachGrantViaHttp(AUTHN, HOST_ID, BEARER)).toEqual({
      kind: "plan-restricted",
    });
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

  it("surfaces plan-restricted distinctly; collapses other failures to unavailable", async () => {
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
    expect(await provider()).toEqual({ kind: "plan-restricted" });

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
