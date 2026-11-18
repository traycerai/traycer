import { expect, it } from "vitest";
import { readEnvironmentList } from "../environment-list";
import type { EnvironmentCloud } from "../environment-cloud";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";

it("joins the host count and organization label to a team row", async () => {
  const cloud: EnvironmentCloud = {
    authnBaseUrl: "https://authn.example/",
    bearer: { kind: "cloud", getBearerToken: () => "test-token" },
    onOriginSignIn: () => true,
    transport: async ({ url }) => {
      if (url.endsWith("/api/v3/environments/team-a/hosts")) {
        return {
          status: 200,
          text: JSON.stringify({ hosts: [{ purgePending: false }] }),
        };
      }
      if (url.endsWith("/api/v3/environments/team-a/members")) {
        return {
          status: 200,
          text: JSON.stringify({ viewer: { effectiveRole: "admin" } }),
        };
      }
      throw new Error("Unexpected environment read");
    },
  };
  const directory: readonly EnvironmentDescriptor[] = [
    {
      environmentId: "team-a",
      ownerKind: "organization",
      ownerId: "org-a",
      roomId: "room-a",
      label: "Acme",
    },
  ];
  const failedRows: string[] = [];

  const environments = await readEnvironmentList(
    cloud,
    directory,
    [{ id: "org-a", slug: "acme" }],
    (environmentId, facts) => failedRows.push(`${environmentId}:${facts}`),
  );

  expect(environments).toMatchObject([
    {
      environmentId: "team-a",
      label: "Acme",
      kind: "team",
      hostCount: 1,
    },
  ]);
  expect(failedRows).toEqual([]);
});
