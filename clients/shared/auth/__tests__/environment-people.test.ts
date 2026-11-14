import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchEnvironmentPerson } from "../environment-people";

const AUTHN_BASE_URL = "https://authn.example.test";
const BEARER = "person-read-test-bearer";
const ENVIRONMENT_ID = "team/alpha";
const USER_ID = "user/42";
const PERSON_URL =
  "https://authn.example.test/api/v3/environments/team%2Falpha/people/user%2F42";

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function stubFetch(
  response: (request: CapturedRequest) => Response | Promise<Response>,
): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const request = { url, init };
    requests.push(request);
    return Promise.resolve(response(request));
  });
  return requests;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readPerson(signal: AbortSignal | null = null) {
  return fetchEnvironmentPerson(
    AUTHN_BASE_URL,
    BEARER,
    ENVIRONMENT_ID,
    USER_ID,
    signal,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authn environment person read", () => {
  it("reads the requested person at the encoded environment route with the sign-in", async () => {
    const person = {
      userId: USER_ID,
      name: "Riya",
      handle: "riya-handle",
      avatarUrl: "https://images.example.test/riya.png",
    };
    const requests = stubFetch(() => jsonResponse(person));

    const result = await readPerson();

    expect(result).toEqual({ kind: "found", person });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(PERSON_URL);
    expect(requests[0]?.init?.method).toBe("GET");
    expect(requests[0]?.init?.redirect).toBe("manual");
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${BEARER}`);
    expect(headers.get("Accept")).toBe("application/json");
    expect(requests[0]?.init?.body).toBeUndefined();
  });

  it("keeps an unnamed person's non-null handle in the found answer", async () => {
    const person = {
      userId: USER_ID,
      name: null,
      handle: "riya-handle",
      avatarUrl: null,
    };
    stubFetch(() => jsonResponse(person));

    await expect(readPerson()).resolves.toEqual({ kind: "found", person });
  });

  it("maps authn's 404 to not-found", async () => {
    stubFetch(() => new Response(null, { status: 404 }));

    await expect(readPerson()).resolves.toEqual({ kind: "not-found" });
  });

  it.each([302, 401, 403, 500])(
    "does not follow or accept an HTTP %s answer",
    async (status) => {
      const requests = stubFetch(() => new Response(null, { status }));

      await expect(readPerson()).rejects.toThrow();

      expect(requests).toHaveLength(1);
      expect(requests[0]?.init?.redirect).toBe("manual");
    },
  );

  it.each([
    {
      label: "a response naming another user",
      person: {
        userId: "different-user",
        name: "Riya",
        handle: "riya-handle",
        avatarUrl: null,
      },
    },
    {
      label: "an extra response field",
      person: {
        userId: USER_ID,
        name: "Riya",
        handle: "riya-handle",
        avatarUrl: null,
        extra: "not part of the contract",
      },
    },
    {
      label: "a null handle",
      person: {
        userId: USER_ID,
        name: "Riya",
        handle: null,
        avatarUrl: null,
      },
    },
  ])("refuses $label", async ({ person }) => {
    stubFetch(() => jsonResponse(person));

    await expect(readPerson()).rejects.toThrow();
  });

  it("refuses a response that is not JSON", async () => {
    stubFetch(() => new Response("not-json", { status: 200 }));

    await expect(readPerson()).rejects.toThrow();
  });
});
