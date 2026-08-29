import { MutationObserver, onlineManager } from "@tanstack/react-query";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";

// Regression coverage for the wake-from-sleep freeze: Chromium can report
// `navigator.onLine === false` indefinitely after an OS sleep/wake in the
// desktop shell, and under TanStack's default `networkMode: "online"` that
// silently parked every query (`fetchStatus: "paused"`) and every mutation
// (paused-pending) until the app was relaunched - send / next-steps buttons
// went inert while the stream layer (wired to the OS resume pulse) kept
// flowing. The app's `networkMode: "always"` default must keep both running
// regardless of what the browser thinks connectivity is; host RPCs target the
// loopback host anyway.
describe("createAppQueryClient while the browser reports offline", () => {
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it("still fetches queries", async () => {
    onlineManager.setOnline(false);
    const client = createAppQueryClient();
    const result = await client.fetchQuery({
      queryKey: ["offline-regression", "query"],
      queryFn: () => Promise.resolve("fetched"),
    });
    expect(result).toBe("fetched");
    expect(
      client.getQueryCache().find({
        queryKey: ["offline-regression", "query"],
      })?.state.fetchStatus,
    ).not.toBe("paused");
  });

  it("still runs mutations instead of pausing them", async () => {
    onlineManager.setOnline(false);
    const client = createAppQueryClient();
    const observer = new MutationObserver(client, {
      mutationFn: () => Promise.resolve("sent"),
    });
    const mutation = observer.mutate();
    // The paused-pending state is the dead-button symptom: `mutate()` accepted
    // the click but nothing will ever run until connectivity is re-reported.
    expect(observer.getCurrentResult().isPaused).toBe(false);
    await expect(mutation).resolves.toBe("sent");
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Runs a failing query through the real client and returns the `error` object
 * the app-wide `onError` actually emitted, parsed back out of the structured
 * console line. No mocking of the logger: what this asserts is exactly the text
 * a support log would carry.
 */
async function loggedErrorFieldsForQueryFailure(
  failure: Error,
): Promise<Record<string, unknown>> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const client = createAppQueryClient();
    await client
      .fetchQuery({
        // `failure` belongs in the key because `queryFn` closes over it. The
        // name is carried too: keys hash through `JSON.stringify`, an `Error`
        // serializes to `{}`, and without it both cases would collide on one
        // cache entry.
        queryKey: ["failure-logging", failure.name, failure],
        queryFn: () => Promise.reject(failure),
        retry: false,
      })
      .catch(() => undefined);
    const line = warn.mock.calls
      .map((call) => String(call[0]))
      .find((text) => text.includes("[query] request failed"));
    if (line === undefined) {
      throw new Error("the query failure was never logged");
    }
    const parsed: unknown = JSON.parse(line.slice(line.indexOf("{")));
    if (!isRecord(parsed) || !isRecord(parsed.fields)) {
      throw new Error("the logged line carried no fields");
    }
    const described = parsed.fields.error;
    if (!isRecord(described)) {
      throw new Error("the logged fields carried no error");
    }
    return described;
  } finally {
    warn.mockRestore();
  }
}

// This callback fires BEFORE a hook's own `onError`, so what it records is what
// a support log actually carries - and it cannot be undone downstream.
//
// A `HostRpcError` must be logged in FULL: summarizing it reduced every report
// to `{ name: "HostRpcError", messageLength: 198, stack: null }`, which is why
// traycerai/traycer#1556 could not be diagnosed from its own logs.
//
// Everything else must stay SUMMARIZED. Six hooks feeding this cache
// deliberately call `appLogger.errorSummary` in their own `onError` because
// their messages quote the user - `use-epic-export-artifacts-mutation` throws
// `"<artifact.title>" is still loading.`. A global full log defeats all six,
// and it does so silently, which is how it shipped the first time.
describe("createAppQueryClient failure logging", () => {
  it("summarizes a non-host error whose message quotes the user", async () => {
    const described = await loggedErrorFieldsForQueryFailure(
      new Error("“Q3 revenue teardown” is still loading."),
    );
    expect(described.message).toBeUndefined();
    expect(described.stack).toBeNull();
    expect(described.messageLength).toBe(
      "“Q3 revenue teardown” is still loading.".length,
    );
    expect(JSON.stringify(described)).not.toContain("Q3 revenue teardown");
  });

  it("records a HostRpcError in full, with its structured attribution", async () => {
    const described = await loggedErrorFieldsForQueryFailure(
      new HostRpcError({
        code: "RPC_ERROR",
        message: "worktree.create failed: branch already checked out",
        requestId: "req-8821",
        method: "worktree.create",
        fatalDetails: null,
      }),
    );
    expect(described.message).toBe(
      "worktree.create failed: branch already checked out",
    );
    expect(described.messageLength).toBeUndefined();
    expect(described.code).toBe("RPC_ERROR");
    expect(described.method).toBe("worktree.create");
    expect(described.requestId).toBe("req-8821");
  });
});
