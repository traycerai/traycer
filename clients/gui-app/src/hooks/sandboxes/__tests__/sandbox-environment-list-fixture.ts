import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentDirectoryResult } from "@traycer-clients/shared/host-client/environment-directory";
import { useAuthStore } from "@/stores/auth/auth-store";
import { createFakeEnvironmentCloudTransport } from "../../../../__tests__/create-fake-runner-host";

export type SandboxBillingEnvironmentAnswer =
  | { readonly kind: "ready"; readonly role: "admin" | "editor" | "viewer" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed" };

/** The team the served environment belongs to, as the person's account names it. */
export interface BillingTeam {
  readonly id: string;
  readonly slug: string;
}

export const ACME_TEAM: BillingTeam = { id: "team-a", slug: "acme" };

function buildEnvironment(
  environmentId: string,
  role: "admin" | "editor" | "viewer",
  team: BillingTeam,
): EnvironmentDescriptorV11 {
  return {
    environmentId,
    ownerKind: "organization",
    ownerId: team.id,
    roomId: `room-${team.id}`,
    label: team.slug,
    effectiveRole: role,
    kind: "team",
    hostCount: 0,
    providerHandle: team.slug,
  };
}

/**
 * Serves the account's environment list, and the cloud reads that join each
 * row's role, on `auth` (the one a surface reads through `useHostBinding()`):
 * the team's row at the role `answer` names, never answered while loading, and
 * a no-response while failed. A surface whose `useHostBinding` is mocked to a
 * fake binding serves it on that binding's auth.
 */
export function serveEnvironmentList(
  auth: object,
  options: {
    readonly answer: SandboxBillingEnvironmentAnswer;
    readonly environmentId: string;
    readonly team: BillingTeam;
    readonly onRead: (() => void) | null;
  },
): void {
  const { answer, environmentId, team, onRead } = options;
  const rows = [
    buildEnvironment(
      environmentId,
      answer.kind === "ready" ? answer.role : "viewer",
      team,
    ),
  ];
  // The join names the team by its slug from the person's own account.
  useAuthStore.setState({
    shareableTeams: rows.flatMap((row) =>
      row.ownerKind === "organization" && row.providerHandle !== null
        ? [{ teamId: row.ownerId, slug: row.providerHandle, avatarUrl: null }]
        : [],
    ),
  });
  Object.assign(auth, {
    listEnvironments: (): Promise<EnvironmentDirectoryResult> => {
      onRead?.();
      if (answer.kind === "loading") return new Promise(() => undefined);
      if (answer.kind === "failed")
        return Promise.resolve({ kind: "no_response" });
      return Promise.resolve({ kind: "ok", list: { environments: rows } });
    },
    environmentCloud: () => ({
      authnBaseUrl: "http://localhost:5005",
      bearer: { kind: "cloud", getBearerToken: () => "test-bearer" },
      transport: createFakeEnvironmentCloudTransport({
        environments: () => rows,
      }),
      onOriginSignIn: () => true,
    }),
  });
}
