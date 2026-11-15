import { expect, it } from "vitest";
import { readConfigurationMembers } from "../configuration-members";
import type { EnvironmentCloud } from "../environment-cloud";

it("maps a member's identity and redacts a blank email", async () => {
  const cloud: EnvironmentCloud = {
    authnBaseUrl: "https://authn.example/",
    bearer: { kind: "cloud", getBearerToken: () => "test-token" },
    onOriginSignIn: () => true,
    transport: async () => ({
      status: 200,
      text: JSON.stringify({
        members: [
          {
            id: "seat-viewer",
            email: "",
            user: {
              id: "user-viewer",
              name: "View Only",
              avatarUrl: null,
            },
            effectiveRole: "editor",
            linkedPlan: false,
            inviteState: "accepted",
            invitedAddress: null,
          },
        ],
        viewer: {
          effectiveRole: "editor",
          legacyRoleNoticeSeenAt: null,
          legacyMembers: [],
        },
      }),
    }),
  };

  const answer = await readConfigurationMembers(cloud, "team-a", null, null);

  expect(answer.members).toMatchObject([
    {
      userId: "user-viewer",
      displayName: "View Only",
      avatarUrl: null,
      linkedPlan: false,
      inviteState: "accepted",
      invitedAddress: null,
      email: null,
    },
  ]);
});
