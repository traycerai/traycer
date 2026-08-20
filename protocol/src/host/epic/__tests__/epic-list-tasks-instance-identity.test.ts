import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { epicListTasksUpgradeV10ToV11 } from "@traycer/protocol/host/epic/contracts";
import {
  listTasksRequestSchema,
  listTasksRequestSchemaV11,
  listTasksResponseSchema,
  listTasksResponseSchemaV13,
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
  // The LATEST installed minor, which `@1.4` now is. The index is spelled
  // rather than derived because the invariant is about the canonical contract
  // specifically; a derived lookup would keep passing while silently pointing
  // at whatever happened to be last.
  const hostContract =
    hostRpcRegistry["epic.listTasks"][1].versions[4].contract;

  it("host request schema is the canonical listTasksRequestSchema instance", () => {
    expect(hostContract.requestSchema).toBe(listTasksRequestSchema);
  });

  it("host response schema is the canonical listTasksResponseSchema instance", () => {
    expect(hostContract.responseSchema).toBe(listTasksResponseSchema);
  });

  it("keeps the released `@1.3` response frozen against the `@1.4` growth", () => {
    const v13 = hostRpcRegistry["epic.listTasks"][1].versions[3].contract;
    expect(v13.responseSchema).toBe(listTasksResponseSchemaV13);
    // `completeness` and the per-row `preservation` marker are `@1.4` only;
    // a `@1.3` peer's schema strips both, which is what makes the minor
    // additive rather than a redefinition of a released shape.
    // A ROW is carried, not just the top-level key: with `tasks: []` the
    // per-row half of the claim above was asserted by the comment alone, and
    // nothing would have failed if `@1.3`'s row schema had grown
    // `preservation` too.
    const page = {
      tasks: [{ epic: null, phase: null, preservation: "orphaned-local-edits" }],
      hasMore: false,
      completeness: {
        cloudPage: "unavailable",
        facets: "partial",
        localRows: "present",
        sort: "loaded-union",
      },
    };
    expect(listTasksResponseSchemaV13.parse(page)).toEqual({
      tasks: [{ epic: null, phase: null }],
      hasMore: false,
    });
    const parsed = listTasksResponseSchema.parse(page);
    expect(parsed.completeness).toEqual(page.completeness);
    expect(parsed.tasks[0]?.preservation).toBe("orphaned-local-edits");
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
});
