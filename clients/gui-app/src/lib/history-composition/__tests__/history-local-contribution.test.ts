import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { ViewReplicaAddress } from "@traycer-clients/shared/view-replica/identity";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
} from "@traycer/protocol/auth/request-context";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import type { LocalHistoryReadResponse } from "@traycer/protocol/host/epic/local-history";
import type {
  ListTaskLight,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HistoryHostContribution } from "../compose-history-page";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  __resetHistoryContributionsForTests,
  applyHistoryContributionToCachedPage,
  noteUnfilteredHistoryContribution,
  noteUnfilteredHistoryContributionPending,
  readHistoryHostContribution,
  unfilteredHistoryContribution,
  subscribeUnfilteredHistoryContributions,
} from "../history-local-contribution";

const ACCOUNT = "account-1";

function task(id: string, recentAt: number | undefined): ListTaskLight {
  return {
    epic: {
      light: {
        id,
        title: id,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        createdBy: "u",
        version: "1",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    recentAt,
  };
}

function response(
  overrides: Partial<LocalHistoryReadResponse>,
): LocalHistoryReadResponse {
  return {
    complete: true,
    willComplete: true,
    localHomeRows: [],
    preservedRows: [],
    tombstonedEpicIds: [],
    localRows: "none",
    ...overrides,
  };
}

/** A real client whose host answers `epic.localHistory.read` from `answers`, in order. */
function clientAnswering(
  answers: readonly (LocalHistoryReadResponse | Error)[],
): {
  client: HostClient<typeof hostRpcRegistry>;
  asked: boolean[];
} {
  const asked: boolean[] = [];
  const queue = [...answers];
  const messenger = new MockHostMessenger<typeof hostRpcRegistry>({
    registry: hostRpcRegistry,
    handlers: {
      "epic.localHistory.read": (params) => {
        asked.push(params.awaitComplete);
        const next = queue.shift();
        if (next === undefined) throw new Error("no scripted answer left");
        if (next instanceof Error) throw next;
        return next;
      },
    },
    requestId: () => "request",
  });
  const root = new HostClient({
    registry: hostRpcRegistry,
    messenger,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  });
  root.setRequestContext(
    createRequestContext({
      identity: identityFromAuthenticatedUser(
        createAuthenticatedUserFixture(undefined),
      ),
      bearerToken: "bearer",
      origin: "renderer",
      connectionId: undefined,
      operationId: undefined,
      externalAbortSignal: undefined,
      cloudAuthorized: true,
    }),
  );
  return {
    client: root.createRequesterForHostId(mockLocalHostEntry.hostId),
    asked,
  };
}

const readFrom = (
  client: HostClient<typeof hostRpcRegistry> | null,
  options: {
    readonly signal: AbortSignal | undefined;
    readonly onIncomplete: (() => void) | null;
  },
) =>
  readHistoryHostContribution({
    client,
    filters: null,
    signal: options.signal,
    onIncomplete: options.onIncomplete,
  });

describe("readHistoryHostContribution", () => {
  it("contributes a complete answer", async () => {
    const complete = response({ tombstonedEpicIds: ["gone"] });
    const { client, asked } = clientAnswering([complete]);

    const contribution = await readFrom(client, {
      signal: undefined,
      onIncomplete: null,
    });

    expect(contribution).toEqual({ kind: "contributed", read: complete });
    expect(asked).toEqual([false]);
  });

  it("is absent without a client, and on a failed read", async () => {
    expect(
      await readFrom(null, { signal: undefined, onIncomplete: null }),
    ).toEqual({ kind: "absent" });

    const { client } = clientAnswering([new Error("unreachable")]);
    expect(
      await readFrom(client, { signal: undefined, onIncomplete: null }),
    ).toEqual({ kind: "absent" });
  });

  it("rethrows when the caller aborted", async () => {
    const { client } = clientAnswering([new Error("unreachable")]);
    const controller = new AbortController();
    controller.abort(new Error("caller gone"));

    await expect(
      readFrom(client, { signal: controller.signal, onIncomplete: null }),
    ).rejects.toThrow();
  });

  it("re-reads once with awaitComplete after a store that may still open, telling the caller once", async () => {
    const complete = response({ localRows: "present" });
    const { client, asked } = clientAnswering([
      response({ complete: false, willComplete: true }),
      complete,
    ]);
    const onIncomplete = vi.fn();

    const contribution = await readFrom(client, {
      signal: undefined,
      onIncomplete,
    });

    expect(contribution).toEqual({ kind: "contributed", read: complete });
    expect(asked).toEqual([false, true]);
    expect(onIncomplete).toHaveBeenCalledTimes(1);
  });

  it("is absent when the host will not complete", async () => {
    const { client, asked } = clientAnswering([
      response({ complete: false, willComplete: false }),
    ]);

    expect(
      await readFrom(client, { signal: undefined, onIncomplete: null }),
    ).toEqual({ kind: "absent" });
    expect(asked).toEqual([false]);
  });
});

describe("applyHistoryContributionToCachedPage", () => {
  afterEach(() => {
    __resetHistoryContributionsForTests();
  });

  const page: ListTasksResponse = {
    tasks: [task("a", 5), task("b", 9)],
    hasMore: false,
    completeness: {
      cloudPage: "settled",
      facets: "server",
      localRows: "none",
      sort: "server",
    },
  };

  function address(requestScope: string): ViewReplicaAddress {
    return {
      accountId: ACCOUNT,
      service: "epic.listTasks",
      servingTier: "tier",
      requestScope,
    };
  }

  it("composes the pool's page alone, stating reduced coverage, when no host id is known", () => {
    const composed = applyHistoryContributionToCachedPage(
      page,
      address("{}"),
      null,
    );

    expect(composed?.tasks).toEqual(page.tasks);
    expect(composed?.completeness).toMatchObject({
      facets: "partial",
      localRows: "truncated",
    });
  });

  it("holds the paint while the contribution is unlearned or pending", () => {
    expect(
      applyHistoryContributionToCachedPage(page, address("{}"), "host-1"),
    ).toBeNull();

    noteUnfilteredHistoryContribution(ACCOUNT, "host-1", { kind: "pending" });
    expect(
      applyHistoryContributionToCachedPage(page, address("{}"), "host-1"),
    ).toBeNull();
  });

  it("applies a learned contribution with the sort parsed from the request scope", () => {
    noteUnfilteredHistoryContribution(ACCOUNT, "host-1", {
      kind: "contributed",
      read: response({
        localHomeRows: [task("local", 7)],
        tombstonedEpicIds: ["a"],
        localRows: "present",
      }),
    });

    const composed = applyHistoryContributionToCachedPage(
      page,
      address(JSON.stringify({ sort: "recent" })),
      "host-1",
    );

    expect(composed?.tasks.map((row) => row.epic?.light?.id)).toEqual([
      "b",
      "local",
    ]);
    expect(composed?.completeness).toMatchObject({
      sort: "loaded-union",
      localRows: "present",
    });
  });

  it("does not order by recency when the scope's sort is not recent, or is unparseable", () => {
    noteUnfilteredHistoryContribution(ACCOUNT, "host-1", {
      kind: "contributed",
      read: response({
        localHomeRows: [task("local", 1)],
        localRows: "present",
      }),
    });

    const byTitle = applyHistoryContributionToCachedPage(
      page,
      address(JSON.stringify({ sort: "title-asc" })),
      "host-1",
    );
    expect(byTitle?.tasks.map((row) => row.epic?.light?.id)).toEqual([
      "local",
      "a",
      "b",
    ]);

    const garbled = applyHistoryContributionToCachedPage(
      page,
      address("not json"),
      "host-1",
    );
    expect(garbled?.tasks.map((row) => row.epic?.light?.id)).toEqual([
      "b",
      "a",
      "local",
    ]);
  });

  it("tells subscribers when a contribution is noted, until they unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUnfilteredHistoryContributions(listener);

    noteUnfilteredHistoryContribution(ACCOUNT, "host-1", { kind: "absent" });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    noteUnfilteredHistoryContribution(ACCOUNT, "host-1", { kind: "absent" });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("noteUnfilteredHistoryContributionPending", () => {
  afterEach(() => {
    __resetHistoryContributionsForTests();
  });

  it("restores the absence it replaced when abandoned, telling subscribers", () => {
    const listener = vi.fn();
    subscribeUnfilteredHistoryContributions(listener);

    const abandon = noteUnfilteredHistoryContributionPending(ACCOUNT, "host-1");
    expect(unfilteredHistoryContribution(ACCOUNT, "host-1")).toEqual({
      kind: "pending",
    });
    expect(listener).toHaveBeenCalledTimes(1);

    abandon();
    expect(unfilteredHistoryContribution(ACCOUNT, "host-1")).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("restores the previous learned state when abandoned", () => {
    noteUnfilteredHistoryContribution(ACCOUNT, "host-1", { kind: "absent" });

    const abandon = noteUnfilteredHistoryContributionPending(ACCOUNT, "host-1");
    abandon();

    expect(unfilteredHistoryContribution(ACCOUNT, "host-1")).toEqual({
      kind: "absent",
    });
  });

  it("lets a later note win over a stale abandon", () => {
    const abandon = noteUnfilteredHistoryContributionPending(ACCOUNT, "host-1");
    const learned: HistoryHostContribution = {
      kind: "contributed",
      read: response({ tombstonedEpicIds: ["gone"] }),
    };
    noteUnfilteredHistoryContribution(ACCOUNT, "host-1", learned);
    const listener = vi.fn();
    subscribeUnfilteredHistoryContributions(listener);

    abandon();

    expect(unfilteredHistoryContribution(ACCOUNT, "host-1")).toBe(learned);
    expect(listener).not.toHaveBeenCalled();
  });
});
