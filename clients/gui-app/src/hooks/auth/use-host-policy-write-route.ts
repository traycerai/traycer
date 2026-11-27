import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";

/**
 * Where a host's version-policy write goes (the Auto-update switch, Update
 * now, Apply now):
 *  - `registry`    — authn's `PATCH /api/v3/hosts/:hostId`, which admits the
 *                    owner: every computer and a person's own sandbox.
 *  - `sandbox`     — a team's sandbox the signed-in person's sandbox list
 *                    holds: the control plane's
 *                    `PATCH /api/sandboxes/:id/update-policy`, which admits
 *                    whoever may stop or destroy it.
 *  - `unreachable` — a team's sandbox the list does not hold (or not yet):
 *                    the control plane would refuse the write, so nothing
 *                    offers it.
 */
export type HostPolicyWriteRoute =
  | { readonly kind: "registry" }
  | { readonly kind: "sandbox"; readonly sandboxId: string }
  | { readonly kind: "unreachable" };

/**
 * The route for `hostId`. The sandbox list is the control plane's answer to
 * who reaches a sandbox: it lists exactly the rows its stop and destroy admit
 * for this person.
 */
export function useHostPolicyWriteRoute(hostId: string): HostPolicyWriteRoute {
  const entry = useHostDirectoryEntry(hostId);
  const sandboxes = useSandboxList().data;
  const teamSandbox =
    entry !== null &&
    isRemoteHostDirectoryEntry(entry) &&
    entry.sandbox !== null &&
    entry.owner?.kind === "team";
  if (!teamSandbox) return { kind: "registry" };
  const row = sandboxes?.sandboxes.find((sandbox) => sandbox.hostId === hostId);
  return row === undefined
    ? { kind: "unreachable" }
    : { kind: "sandbox", sandboxId: row.id };
}
