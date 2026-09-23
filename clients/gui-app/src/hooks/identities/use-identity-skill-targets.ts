/**
 * The identities a skill can be installed into, as skill-composer targets.
 *
 * Reads `agentIdentity.list` from the caller's host and gives each row an
 * `onMutate` that routes the composer's inspect/import through
 * `agentIdentity.skills.*` on that same host. Gated on the host advertising
 * `agentIdentity.skills.import`: a host with the identity family but not the
 * installer offers no identity targets rather than ones that fail on submit.
 *
 * `pinned` is the identity a caller is already showing (the identity view's
 * "Install skill"): it is a target from the first render, before the list has
 * answered, and keeps the title the caller knows.
 */
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import {
  identitySkillMutate,
  type IdentitySkillTarget,
} from "@/lib/identities/skill-install-target";
import {
  useIdentitySkillsImportForClient,
  useIdentitySkillsInspectForClient,
} from "./use-identity-mutations";
import { useIdentityListForClient } from "./use-identity-queries";

export const IDENTITY_SKILL_IMPORT_METHOD = "agentIdentity.skills.import";

export function useIdentitySkillTargets(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  /** Whether to read the list at all (the composer is open). */
  readonly enabled: boolean;
  readonly pinned: {
    readonly identityId: string;
    readonly title: string;
  } | null;
  readonly onImported: (identityId: string, paths: readonly string[]) => void;
}): {
  readonly supported: boolean;
  readonly targets: readonly IdentitySkillTarget[];
  readonly pending: boolean;
} {
  const supported = useHostSupportsMethod(
    args.hostId,
    IDENTITY_SKILL_IMPORT_METHOD,
  );
  const list = useIdentityListForClient(args.client, args.enabled && supported);
  const inspect = useIdentitySkillsInspectForClient(args.client);
  const importSkills = useIdentitySkillsImportForClient(args.client);

  const rows: { readonly identityId: string; readonly title: string }[] = [];
  if (supported) {
    if (args.pinned !== null) rows.push(args.pinned);
    for (const identity of list.data?.identities ?? []) {
      if (identity.identityId === args.pinned?.identityId) continue;
      rows.push({ identityId: identity.identityId, title: identity.title });
    }
  }
  const targets = rows.map((row): IdentitySkillTarget => ({
    identityId: row.identityId,
    title: row.title,
    onMutate: identitySkillMutate({
      identityId: row.identityId,
      inspect: (request) => inspect.mutateAsync(request),
      importSkills: (request) => importSkills.mutateAsync(request),
      onImported: (paths) => args.onImported(row.identityId, paths),
    }),
  }));
  return {
    supported,
    targets,
    pending: inspect.isPending || importSkills.isPending,
  };
}

/**
 * The same targets on the app-wide host, for a surface that installs through
 * that host already (the provider Skills tab's composer).
 */
export function useActiveHostIdentitySkillTargets(enabled: boolean): {
  readonly supported: boolean;
  readonly targets: readonly IdentitySkillTarget[];
  readonly pending: boolean;
} {
  const client = useHostClient();
  return useIdentitySkillTargets({
    client,
    hostId: client.getActiveHostId(),
    enabled,
    pinned: null,
    onImported: () => {},
  });
}
