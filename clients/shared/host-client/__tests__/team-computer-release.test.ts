import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { releaseTeamComputerViaHttp } from "../team-computer-release";

const BASE = "https://authn.example.test";
const BEARER = "member-session-token";
const HOST_ID = "6f1c2a4e-3b5d-4c7e-8f90-a1b2c3d4e5f6";
const ENVIRONMENT_ID = "env_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TIMEOUT_MS = 10_000;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(
  respond: (url: string, init: RequestInit) => Promise<Response>,
): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) =>
    respond(String(input), init ?? {}),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function release() {
  return releaseTeamComputerViaHttp(BASE, BEARER, HOST_ID, ENVIRONMENT_ID);
}

function onlyCall(fetchMock: Mock<typeof fetch>): {
  readonly url: string;
  readonly init: RequestInit;
} {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [input, init] = fetchMock.mock.calls[0];
  if (init === undefined) throw new Error("fetch was called without init");
  return { url: String(input), init };
}

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("team computer release request", () => {
  it("POSTs the selected host and team with the member bearer", async () => {
    const fetchMock = stubFetch(
      async () => new Response(null, { status: 204 }),
    );

    await release();

    const { url, init } = onlyCall(fetchMock);
    expect(url).toBe(`${BASE}/api/v3/hosts/${HOST_ID}/team-release`);
    expect(init.method).toBe("POST");
    expect(headerOf(init, "Authorization")).toBe(`Bearer ${BEARER}`);
    expect(headerOf(init, "Accept")).toBe("application/json");
    expect(headerOf(init, "Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      environmentId: ENVIRONMENT_ID,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("team computer release results", () => {
  it("treats a bodyless 204 as success", async () => {
    stubFetch(async () => new Response(null, { status: 204 }));

    await expect(release()).resolves.toEqual({ kind: "ok" });
  });

  it("maps 404 to a non-disclosing not-found result", async () => {
    const privateBody = "private host or team details";
    stubFetch(async () => new Response(privateBody, { status: 404 }));

    const result = await release();

    expect(result).toEqual({ kind: "not-found" });
    expect(JSON.stringify(result)).not.toContain(privateBody);
  });

  it("maps the typed 409 refusal to the fixed not-computer result", async () => {
    stubFetch(async () =>
      jsonResponse(409, {
        code: "host_return_not_computer",
        message: "private diagnostic details",
      }),
    );

    await expect(release()).resolves.toEqual({ kind: "not-computer" });
  });

  it.each([401, 403])("maps HTTP %i to unauthorized", async (status) => {
    stubFetch(async () => jsonResponse(status, { message: "private" }));

    await expect(release()).resolves.toEqual({ kind: "unauthorized" });
  });

  it.each([
    {
      name: "invalid JSON",
      respond: () =>
        new Response("private malformed response", { status: 409 }),
    },
    {
      name: "a different refusal code",
      respond: () => jsonResponse(409, { code: "private_unknown_code" }),
    },
  ])(
    "maps a 409 with $name to network-error without its body",
    async ({ respond }) => {
      stubFetch(async () => respond());

      const result = await release();

      expect(result).toEqual({ kind: "network-error" });
      expect(JSON.stringify(result)).not.toMatch(/private|unknown_code/);
    },
  );

  it("maps a transport error to network-error without its message", async () => {
    stubFetch(async () => {
      throw new Error("private transport detail");
    });

    const result = await release();

    expect(result).toEqual({ kind: "network-error" });
    expect(JSON.stringify(result)).not.toContain("private transport detail");
  });
});

describe("team computer release timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("settles an unresponsive fetch as network-error without exposing late response details", async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    let settled = false;
    const pending = release();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = await pending;
    expect(settled).toBe(true);
    expect(result).toEqual({ kind: "network-error" });
    expect(JSON.stringify(result)).not.toContain("private late body");

    const late = new Response("private late body", { status: 409 });
    const lateText = vi.spyOn(late, "text");
    answer(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(lateText).not.toHaveBeenCalled();
  });
});
