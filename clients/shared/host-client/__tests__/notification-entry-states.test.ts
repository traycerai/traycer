import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { fetchNotificationEntryStatesViaHttp } from "../notification-entry-states";

const BASE = "https://server.example.test";
const BEARER = "phone-session";

// Copied from the server entry-states lock test: the two repositories cannot share a module.
const ENTRY_ID_FIXTURE = [
  "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
  "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  "not-a-uuid",
  "01234567-89AB-4CDE-8FAB-CDEF01234567",
  "01234567-89ab-4cde-8fab-cdef01234567",
] as const;

const CANONICAL_IDS = [
  "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  "01234567-89ab-4cde-8fab-cdef01234567",
] as const;

function entryId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

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

function requestBody(init: RequestInit): unknown {
  if (typeof init.body !== "string") {
    throw new Error("the entry-states request had no JSON body");
  }
  return JSON.parse(init.body);
}

function postedIds(init: RequestInit): string[] {
  const body = requestBody(init);
  if (typeof body !== "object" || body === null || !("entryIds" in body)) {
    throw new Error("the entry-states request had no entryIds");
  }
  const ids = body.entryIds;
  if (!Array.isArray(ids)) throw new Error("entryIds were not an array");
  const strings: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") throw new Error("an entry id was not a string");
    strings.push(id);
  }
  return strings;
}

function authorizationOf(init: RequestInit): string | null {
  const headers = init.headers;
  if (headers instanceof Headers) return headers.get("Authorization");
  if (headers === undefined || Array.isArray(headers)) return null;
  const value = headers.Authorization;
  return typeof value === "string" ? value : null;
}

function callInit(fetchMock: Mock<typeof fetch>, index: number): RequestInit {
  const init = fetchMock.mock.calls[index]?.[1];
  if (init === undefined) throw new Error("fetch was not called");
  return init;
}

/** One found answer for the first id of a chunk, then notFound, in asked order. */
function answersFor(ids: readonly string[]): unknown[] {
  return ids.map((entryIdValue, index) =>
    index === 0
      ? { entryId: entryIdValue, state: "found", readAt: 5, clearedAt: null }
      : { entryId: entryIdValue, state: "notFound" },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchNotificationEntryStatesViaHttp", () => {
  it("sends the shared fixture as canonical ids in first-seen order", async () => {
    const fetchMock = stubFetch(async (_url, init) =>
      jsonResponse(200, {
        entries: postedIds(init).map((entryIdValue) => ({
          entryId: entryIdValue,
          state: "notFound",
        })),
      }),
    );

    const result = await fetchNotificationEntryStatesViaHttp(
      BASE,
      BEARER,
      ENTRY_ID_FIXTURE,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://server.example.test/api/notification-feed/entry-states",
    );
    const init = callInit(fetchMock, 0);
    expect(init.method).toBe("POST");
    expect(authorizationOf(init)).toBe(`Bearer ${BEARER}`);
    expect(requestBody(init)).toEqual({ entryIds: [...CANONICAL_IDS] });
    expect(result).toEqual({
      kind: "ok",
      entries: CANONICAL_IDS.map((entryIdValue) => ({
        entryId: entryIdValue,
        state: "notFound",
      })),
    });
  });

  it("sends one hundred and fifty ids as two requests and merges the answers", async () => {
    const ids = Array.from({ length: 150 }, (_value, index) =>
      entryId(index + 1),
    );
    const fetchMock = stubFetch(async (_url, init) =>
      jsonResponse(200, { entries: answersFor(postedIds(init)) }),
    );

    const result = await fetchNotificationEntryStatesViaHttp(BASE, BEARER, ids);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = postedIds(callInit(fetchMock, 0));
    const second = postedIds(callInit(fetchMock, 1));
    expect(first).toEqual(ids.slice(0, 100));
    expect(second).toEqual(ids.slice(100));
    expect(result).toEqual({
      kind: "ok",
      entries: [...answersFor(first), ...answersFor(second)],
    });
  });

  it("maps a 404 to unavailable", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(404, {
        entries: [{ entryId: CANONICAL_IDS[0], state: "found" }],
      }),
    );

    const result = await fetchNotificationEntryStatesViaHttp(BASE, BEARER, [
      CANONICAL_IDS[0],
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("returns network-error when the answers are not the ids asked", async () => {
    stubFetch(async () =>
      jsonResponse(200, {
        entries: [{ entryId: CANONICAL_IDS[1], state: "notFound" }],
      }),
    );

    const result = await fetchNotificationEntryStatesViaHttp(BASE, BEARER, [
      CANONICAL_IDS[0],
    ]);

    expect(result).toEqual({
      kind: "network-error",
      detail: "the entry states did not match the contract",
    });
  });
});
