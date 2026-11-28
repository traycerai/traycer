import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";

/**
 * Where a host's version-policy write goes (the Auto-update switch, Update
 * now, Install, Apply now), and whether this person may make it:
 *  - `registry` — authn's `PATCH /api/v3/hosts/:hostId`, which admits the
 *                 owner: every computer and a person's own sandbox.
 *  - `sandbox`  — a team's sandbox the signed-in person's sandbox list holds:
 *                 the control plane's `PATCH /api/sandboxes/:id/update-policy`,
 *                 which admits whoever may stop or destroy it.
 *  - `denied`   — a team's sandbox the list answered without: the control
 *                 plane refuses this person the write.
 *  - `unknown`  — a team's sandbox while the list has no answer, loading or
 *                 unreadable. Not a refusal; nothing is offered until it
 *                 answers.
 */
export type HostPolicyWriteRoute =
  | { readonly kind: "registry" }
  | { readonly kind: "sandbox"; readonly sandboxId: string }
  | { readonly kind: "denied" }
  | { readonly kind: "unknown" };

/** The one verdict every update control on the host takes. */
export function hostPolicyWritable(route: HostPolicyWriteRoute): boolean {
  return route.kind === "registry" || route.kind === "sandbox";
}

/**
 * The route for `hostId`. The sandbox list is the control plane's answer to
 * who reaches a sandbox: it lists exactly the rows its stop and destroy admit
 * for this person.
 */
export function useHostPolicyWriteRoute(
  hostId: string | null,
): HostPolicyWriteRoute {
  const entry = useHostDirectoryEntry(hostId);
  const list = useSandboxList().data ?? null;
  const teamSandbox =
    entry !== null &&
    isRemoteHostDirectoryEntry(entry) &&
    entry.sandbox !== null &&
    entry.owner?.kind === "team";
  if (!teamSandbox) return { kind: "registry" };
  if (list === null) return { kind: "unknown" };
  const row = list.sandboxes.find((sandbox) => sandbox.hostId === hostId);
  return row === undefined
    ? { kind: "denied" }
    : { kind: "sandbox", sandboxId: row.id };
}
