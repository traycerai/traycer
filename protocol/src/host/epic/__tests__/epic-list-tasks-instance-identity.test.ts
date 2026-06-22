import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  listTasksRequestSchema,
  listTasksResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * Hard invariant for the partial CloudData → protocol migration:
 *
 *   hostRpcRegistry["epic.listTasks"]
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
  const hostContract =
    hostRpcRegistry["epic.listTasks"][1].versions[0].contract;

  it("host request schema is the canonical listTasksRequestSchema instance", () => {
    expect(hostContract.requestSchema).toBe(listTasksRequestSchema);
  });

  it("host response schema is the canonical listTasksResponseSchema instance", () => {
    expect(hostContract.responseSchema).toBe(listTasksResponseSchema);
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
});
