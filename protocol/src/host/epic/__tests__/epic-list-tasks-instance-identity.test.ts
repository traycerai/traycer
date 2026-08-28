import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { epicListTasksUpgradeV10ToV11 } from "@traycer/protocol/host/epic/contracts";
import {
  listTasksRequestSchema,
  listTasksRequestSchemaV11,
  listTasksResponseSchema,
  listTasksResponseSchemaPre13,
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
  // The LATEST minor - bump alongside `latestMinor` in the registry. This
  // test exists to catch a latest contract that drifted off the canonical
  // instances, so it must track latest rather than a fixed minor.
  const hostContract =
    hostRpcRegistry["epic.listTasks"][1].versions[3].contract;

  it("host request schema is the canonical listTasksRequestSchema instance", () => {
    expect(hostContract.requestSchema).toBe(listTasksRequestSchema);
  });

  it("host response schema is the canonical listTasksResponseSchema instance", () => {
    expect(hostContract.responseSchema).toBe(listTasksResponseSchema);
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
