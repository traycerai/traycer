import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptEnvironmentInvitation,
  fetchEnvironmentInvitations,
} from "../environment-invitations";

const AUTHN_BASE_URL = "https://authn.example.test";
const BEARER = "invitation-test-bearer";
const LIST_URL = `${AUTHN_BASE_URL}/api/v3/environments/me/invitations`;
const ACCEPT_URL = `${LIST_URL}/accept`;

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function stubFetch(
  response: (request: CapturedRequest) => Response | Promise<Response>,
): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    let url: string;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else {
      url = input.url;
    }
    const request = { url, init };
    requests.push(request);
    return Promise.resolve(response(request));
  });
  return requests;
}

function jsonResponse(body: unknown, status: number | undefined): Response {
  return new Response(JSON.stringify(body), {
    status: status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("environment invitation authn requests", () => {
  it("lists pending invitations with the bearer and explicit acceptance opt-out", async () => {
    const requests = stubFetch(() =>
      jsonResponse(
        {
          invitations: [
            {
              environmentId: "env-beta",
              teamName: "Beta",
              role: "viewer",
              paidPlan: true,
            },
          ],
        },
        undefined,
      ),
    );
    const caller = new AbortController();

    const answer = await fetchEnvironmentInvitations(
      AUTHN_BASE_URL,
      BEARER,
      caller.signal,
    );

    expect(answer.invitations.map((item) => item.environmentId)).toEqual([
      "env-beta",
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(LIST_URL);
    expect(requests[0]?.init?.method).toBe("GET");
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${BEARER}`);
    expect(headers.get("x-traycer-invite-acceptance")).toBe("explicit");
    expect(requests[0]?.init?.signal).not.toBe(caller.signal);
    expect(requests[0]?.init?.body).toBeNull();
  });

  it("posts only the reviewed environment id when accepting", async () => {
    const requests = stubFetch(() =>
      jsonResponse({ outcome: "accepted" }, undefined),
    );

    const answer = await acceptEnvironmentInvitation(
      AUTHN_BASE_URL,
      BEARER,
      "env-beta",
    );

    expect(answer).toEqual({ outcome: "accepted" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(ACCEPT_URL);
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.body).toBe(
      JSON.stringify({ environmentId: "env-beta" }),
    );
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${BEARER}`);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("x-traycer-invite-acceptance")).toBe("explicit");
  });

  it("bounds authorization and server errors without exposing response bodies", async () => {
    stubFetch(() => new Response("private server detail", { status: 403 }));

    await expect(
      fetchEnvironmentInvitations(AUTHN_BASE_URL, BEARER, null),
    ).rejects.toThrow("Sign in again to review team invitations.");

    vi.restoreAllMocks();
    stubFetch(() => new Response("private server detail", { status: 503 }));

    await expect(
      fetchEnvironmentInvitations(AUTHN_BASE_URL, BEARER, null),
    ).rejects.toThrow("Couldn't reach team invitations. Try again.");
  });

  it("returns a bounded error for invalid JSON and invalid invitation data", async () => {
    stubFetch(() => new Response("raw secret response", { status: 200 }));

    await expect(
      fetchEnvironmentInvitations(AUTHN_BASE_URL, BEARER, null),
    ).rejects.toThrow("Couldn't read team invitations. Try again.");

    vi.restoreAllMocks();
    stubFetch(() =>
      jsonResponse({ invitations: [{ environmentId: "env-beta" }] }, undefined),
    );

    await expect(
      fetchEnvironmentInvitations(AUTHN_BASE_URL, BEARER, null),
    ).rejects.toThrow("Couldn't read team invitations. Try again.");
  });

  it("forwards caller cancellation through its bounded request signal", async () => {
    const observedSignals: AbortSignal[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        return Promise.reject(new Error("Expected an abort signal"));
      }
      observedSignals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });
    const caller = new AbortController();
    const pending = fetchEnvironmentInvitations(
      AUTHN_BASE_URL,
      BEARER,
      caller.signal,
    );

    expect(observedSignals).toHaveLength(1);
    expect(observedSignals[0]?.aborted).toBe(false);
    caller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(observedSignals[0]?.aborted).toBe(true);
  });
});

describe("environment invitation acceptance on a fetch that ignores its signal", () => {
  // The literal 15 s `requestInvitations` passes to `composeRequestAbort`.
  const REQUEST_TIMEOUT_MS = 15_000;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects at the deadline with a timeout when the request never completes", async () => {
    // Like CapacitorHttp's patched fetch: the signal is dropped, so only the
    // deadline can settle the request.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>(() => undefined),
    );
    let settled = false;

    const pending = acceptEnvironmentInvitation(
      AUTHN_BASE_URL,
      BEARER,
      "env-beta",
    );
    const rejection = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    void pending.catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await rejection;
  });

  it("rejects at the deadline as unconfirmed when a 200 body never arrives", async () => {
    const response = new Response(null, { status: 200 });
    const json = vi
      .spyOn(response, "json")
      .mockImplementation(() => new Promise<unknown>(() => undefined));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    let settled = false;

    const pending = acceptEnvironmentInvitation(
      AUTHN_BASE_URL,
      BEARER,
      "env-beta",
    );
    const rejection = expect(pending).rejects.toThrow(
      "Couldn't confirm this invitation. Check your teams and try again.",
    );
    void pending.catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(json).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await rejection;
  });
});
