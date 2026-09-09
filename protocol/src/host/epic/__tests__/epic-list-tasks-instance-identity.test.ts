import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { epicListTasksUpgradeV10ToV11 } from "@traycer/protocol/host/epic/contracts";
import {
  listTasksRequestSchema,
  listTasksRequestSchemaPre16,
  listTasksRequestSchemaV11,
  listTasksResponseSchema,
  listTasksResponseSchemaPre13,
  listTasksResponseSchemaPre14,
  listTasksResponseSchemaPre15,
  listTasksResponseSchemaPre16,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * Hard invariant for the partial CloudData → protocol migration:
 *
 *   latest hostRpcRegistry["epic.listTasks"] contract
 *
 * must wire the canonical `listTasks*` schema instances exported from
 * `unary-schemas` - not merely equal shapes. Referential equality
 * (Object.is / `toBe`) catches an accidental future redefinition: if someone
 * re-declares `listTasksRequestSchema` locally, the structural test would
 * still pass, but this one will fail.
 *
 * The cloud-side (`cloudDataRpcRegistry["task.list"]`) reuse of these same
 * instances is guaranteed by construction - the cloud registry imports them
 * directly from `@traycer/protocol/host/epic/unary-schemas` - and is
 * covered on the consumer side, so protocol's own tests stay within the
 * protocol package.
 */
describe("epic.listTasks instance identity", () => {
  // The LATEST installed minor, which `@1.6` now is - bump alongside
  // `latestMinor` in the registry. The index is spelled rather than derived
  // because the invariant is about the canonical contract specifically; a
  // derived lookup would keep passing while silently pointing at whatever
  // happened to be last.
  const hostContract =
    hostRpcRegistry["epic.listTasks"][1].versions[6].contract;

  it("host request schema is the canonical listTasksRequestSchema instance", () => {
    expect(hostContract.requestSchema).toBe(listTasksRequestSchema);
  });

  it("host response schema is the canonical listTasksResponseSchema instance", () => {
    expect(hostContract.responseSchema).toBe(listTasksResponseSchema);
  });

  it("keeps v1.5 one-shot list requests and responses frozen against local-first", () => {
    const v15 = hostRpcRegistry["epic.listTasks"][1].versions[5].contract;
    expect(v15.requestSchema).toBe(listTasksRequestSchemaPre16);
    expect(v15.responseSchema).toBe(listTasksResponseSchemaPre16);

    const request = {
      limit: 20,
      filters: null,
      extensionPhaseVersion: "1.0.0",
      extensionEpicVersion: "2.0.0",
      localFirstPhase: "initial",
    } as const;
    expect(listTasksRequestSchemaPre16.parse(request)).not.toHaveProperty(
      "localFirstPhase",
    );
    expect(listTasksRequestSchema.parse(request).localFirstPhase).toBe(
      "initial",
    );

    const page = {
      tasks: [],
      hasMore: false,
      completeness: {
        cloudPage: "pending",
        facets: "partial",
        localRows: "present",
        sort: "loaded-union",
      },
    } as const;
    // Response enum growth is not silently stripped: an old host must never
    // send it. The v1.6 registry entry is projection-gated precisely because
    // the request directive below is what proves the peer can represent it.
    expect(listTasksResponseSchemaPre16.safeParse(page).success).toBe(false);
    expect(listTasksResponseSchema.parse(page).completeness?.cloudPage).toBe(
      "pending",
    );
  });

  it("keeps the `@1.4` response frozen against the `@1.5` growth", () => {
    const v14 = hostRpcRegistry["epic.listTasks"][1].versions[4].contract;
    expect(v14.responseSchema).toBe(listTasksResponseSchemaPre15);
    // `completeness` and the per-row `preservation` marker are `@1.5` only;
    // a `@1.4` peer's schema strips both, which is what makes the minor
    // additive rather than a redefinition of an installed shape.
    // A ROW is carried, not just the top-level key: with `tasks: []` the
    // per-row half of the claim above was asserted by the comment alone, and
    // nothing would have failed if `@1.4`'s row schema had grown
    // `preservation` too.
    const page = {
      tasks: [
        {
          epic: null,
          phase: null,
          home: "local",
          preservation: "orphaned-local-edits",
        },
      ],
      hasMore: false,
      completeness: {
        cloudPage: "unavailable",
        facets: "partial",
        localRows: "present",
        sort: "loaded-union",
      },
    };
    expect(listTasksResponseSchemaPre15.parse(page)).toEqual({
      tasks: [{ epic: null, phase: null, home: "local" }],
      hasMore: false,
    });
    const parsed = listTasksResponseSchema.parse(page);
    expect(parsed.completeness).toEqual(page.completeness);
    expect(parsed.tasks[0]?.preservation).toBe("orphaned-local-edits");
  });

  it("keeps the `@1.3` response frozen against the `@1.4` home marker", () => {
    const v13 = hostRpcRegistry["epic.listTasks"][1].versions[3].contract;
    expect(v13.responseSchema).toBe(listTasksResponseSchemaPre14);
    // `home` is `@1.4` only. `@1.3` still carries `chatHostIds`, so this
    // asserts the row froze at the RIGHT rung rather than at the pre-1.3 one.
    const row = {
      epic: null,
      phase: null,
      chatHostIds: ["host-a"],
      home: "local",
    };
    const frozen = listTasksResponseSchemaPre14.parse({
      tasks: [row],
      hasMore: false,
    });
    expect(frozen.tasks[0]?.chatHostIds).toEqual(["host-a"]);
    expect(frozen.tasks[0]).not.toHaveProperty("home");
  });

  it("keeps released requests frozen while the latest schema accepts last-viewed", () => {
    const request = {
      limit: 20,
      filters: null,
      sort: "last-viewed",
      extensionPhaseVersion: "1.0.0",
      extensionEpicVersion: "2.0.0",
    } as const;

    expect(listTasksRequestSchemaV11.safeParse(request).success).toBe(false);
    expect(listTasksRequestSchema.parse(request).sort).toBe("last-viewed");
  });

  it("parses server-driven history filters, sort, and facets", () => {
    expect(
      listTasksRequestSchema.parse({
        limit: 20,
        filters: {
          query: "api",
          repoIdentifiers: [{ owner: "traycer", repo: "gui-app" }],
          repoMatchMode: "all",
          workspaceIdentifiers: [
            { hostId: "host-1", workspacePath: "/repo/gui-app" },
          ],
          workspaceMatchMode: "all",
          ownershipScopes: ["mine"],
        },
        sort: "relevance",
        extensionPhaseVersion: "1.0.0",
        extensionEpicVersion: "2.0.0",
      }),
    ).toMatchObject({
      filters: {
        query: "api",
        repoMatchMode: "all",
      },
      sort: "relevance",
    });

    expect(
      listTasksResponseSchema.parse({
        tasks: [],
        hasMore: false,
        facets: {
          repos: [
            {
              repoIdentifier: { owner: "traycer", repo: "gui-app" },
              count: 1,
            },
          ],
          workspaces: [
            {
              workspaceIdentifier: {
                hostId: "host-1",
                workspacePath: "/repo/gui-app",
              },
              count: 1,
            },
          ],
          ownershipScopes: [{ value: "mine", count: 1 }],
        },
      }),
    ).toMatchObject({
      facets: {
        workspaces: [
          {
            workspaceIdentifier: {
              hostId: "host-1",
              workspacePath: "/repo/gui-app",
            },
            count: 1,
          },
        ],
        ownershipScopes: [{ value: "mine", count: 1 }],
      },
    });
  });

  it("carries personal pin state on canonical list rows", () => {
    const parsed = listTasksResponseSchema.parse({
      tasks: [
        {
          epic: null,
          phase: null,
          pinned: true,
        },
      ],
      hasMore: false,
    });
    expect(parsed.tasks[0]?.pinned).toBe(true);
  });

  it("carries optional home marker on canonical list rows", () => {
    const parsed = listTasksResponseSchema.parse({
      tasks: [
        {
          epic: null,
          phase: null,
          pinned: false,
          home: "local",
        },
      ],
      hasMore: false,
    });
    expect(parsed.tasks[0]?.home).toBe("local");
  });

  it("defaults rows from a v1.0 host to unpinned", () => {
    expect(
      epicListTasksUpgradeV10ToV11.upgradeResponse({
        tasks: [{ epic: null, phase: null }],
        hasMore: false,
      }),
    ).toEqual({
      tasks: [{ epic: null, phase: null, pinned: false }],
      hasMore: false,
    });
  });
  it("keeps chatHostIds on latest rows and drops it from the frozen pre-1.3 row", () => {
    // zod STRIPS unknown keys, so a response schema that kept the pre-1.3 row
    // would discard `chatHostIds` from every row with nothing failing - the
    // field would just never arrive. Parse, don't typecheck, to catch that.
    const row = {
      epic: null,
      phase: null,
      pinned: false,
      chatHostIds: ["host-a"],
    };
    const latest = listTasksResponseSchema.parse({
      tasks: [row],
      hasMore: false,
    });
    expect(latest.tasks[0]?.chatHostIds).toEqual(["host-a"]);

    const frozen = listTasksResponseSchemaPre13.parse({
      tasks: [row],
      hasMore: false,
    });
    expect(frozen.tasks[0]).not.toHaveProperty("chatHostIds");
  });
});
