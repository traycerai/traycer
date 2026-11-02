import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { removalLabel } from "@/components/settings/details/details-copy";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import type {
  EnvironmentSecretRemoval,
  EnvironmentSecretRemovalV12,
} from "@traycer/protocol/host/environment-schemas";
import {
  failedHostsText,
  removalWithFailures,
} from "@/components/settings/secrets/secret-removal-lines";
import type {
  DetailsHostStatus,
  DetailsItemStatus,
  DetailsProviderContext,
  DetailsStatus,
  DetailsSubject,
} from "@/lib/settings-details-entry";

type SecretsList = ResponseOfMethod<
  HostRpcRegistry,
  "environment.secrets.list"
>;

const FAILED_STATES = new Set(["failed", "not_applied"]);

/**
 * The page's "Now": where the configuration's secrets stand on the hosts
 * running it. "Applied on 2 hosts" when every host applied them, "Not
 * applied on dev-box" when a host could not, "Applying on dev-box…" while a
 * host has not reported the latest change.
 */
export function secretsHostSummary(
  hosts: readonly DetailsHostStatus[],
): string {
  if (hosts.length === 0) return "Not on any host";
  const failing = hosts.filter((host) => FAILED_STATES.has(host.state));
  if (failing.length === 1) return `Not applied on ${failing[0].name}`;
  if (failing.length > 1) return `Not applied on ${failing.length} hosts`;
  const waiting = hosts.filter((host) => host.state !== "applied");
  if (waiting.length === 1) return `Applying on ${waiting[0].name}…`;
  if (waiting.length > 1) return `Applying on ${waiting.length} hosts…`;
  return hosts.length === 1
    ? "Applied on 1 host"
    : `Applied on ${hosts.length} hosts`;
}

/**
 * A removal still under way: its outcome, then a host that couldn't delete
 * its copy ("Cleanup requested · dev-box couldn't delete its copy"), else
 * which hosts still hold one ("Cleanup requested · waiting for dev-box"). A
 * host the removal names by id only takes its name from the page's host rows.
 */
export function pendingRemovalSummary(
  removal: EnvironmentSecretRemovalV12,
  hosts: readonly DetailsHostStatus[],
): string {
  const nameOf = (target: EnvironmentSecretRemovalV12["targets"][number]) =>
    target.hostName ??
    hosts.find((host) => host.hostId === target.hostId)?.name ??
    "a host";
  const label = removalLabel(removal.outcome);
  const failed = failedHostsText(removal, nameOf);
  if (failed !== null) return `${label} · ${failed}`;
  const waiting = removal.targets.filter(
    (target) => target.target === "host" && target.state === "requested",
  );
  if (waiting.length > 1)
    return `${label} · waiting for ${waiting.length} hosts`;
  if (waiting.length === 0) return label;
  return `${label} · waiting for ${nameOf(waiting[0])}`;
}

/**
 * How far a removal has got, counted in hosts: the broker's own slots are
 * copies of the secret the person never sees, and counting them made a
 * removal look further behind than it was.
 */
function hostsRemovedLine(removal: EnvironmentSecretRemovalV12): string {
  const removed = removal.targets.filter(
    (target) => target.target === "host" && target.state === "confirmed",
  ).length;
  return removed === 1
    ? "Removed from 1 host"
    : `Removed from ${removed} hosts`;
}

function secretInventory(
  subject: DetailsSubject,
  list: SecretsList,
  hosts: readonly DetailsHostStatus[],
): readonly DetailsItemStatus[] {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1_000;
  return [
    ...list.secrets
      .filter(
        (secret) =>
          !list.removed.some((removed) => removed.id === secret.secretId),
      )
      .map((secret) => ({
        subject: {
          environmentId: subject.environmentId,
          kind: "secret",
          key: secret.secretId,
        },
        title: secret.name,
        summary: "Set",
        at: secret.updatedAt,
        retryable: false,
      })),
    ...list.removed
      .filter(
        ({ removal }) =>
          removal.outcome !== "destroyed" ||
          (removal.destroyedAt !== null && removal.destroyedAt >= cutoff),
      )
      .map((removed) => ({
        subject: {
          environmentId: subject.environmentId,
          kind: "secret",
          key: removed.id,
        },
        title: removed.name,
        ...(removed.removal.outcome === "destroyed"
          ? {
              summary: removalLabel(removed.removal.outcome),
              at: removed.removal.destroyedAt ?? removed.removal.revokedAt,
              retryable: false,
            }
          : {
              summary: pendingRemovalSummary(removed.removal, hosts),
              at: null,
              retryable: true,
            }),
      })),
  ];
}

/**
 * The versions read's removal when there is one (the newer fact, which
 * follows a Retry), else the list's; with the list's failures either way.
 */
function newestRemoval(
  read: EnvironmentSecretRemoval | null,
  listed: EnvironmentSecretRemovalV12 | null,
): EnvironmentSecretRemovalV12 | null {
  const newest = read ?? listed;
  return newest === null ? null : removalWithFailures(newest, listed);
}

/** One secret's "Now": Set, or how far its removal reached. */
function singleSecretSummary(
  removal: EnvironmentSecretRemovalV12 | null,
  hosts: readonly DetailsHostStatus[],
): string {
  if (removal === null) return "Set";
  if (removal.outcome === "destroyed") return removalLabel(removal.outcome);
  return pendingRemovalSummary(removal, hosts);
}

async function singleSecretDetails(
  subject: DetailsSubject,
  context: DetailsProviderContext,
  status: DetailsStatus,
  list: SecretsList,
): Promise<{ readonly title: string; readonly status: DetailsStatus }> {
  const secret = list.secrets.find((entry) => entry.secretId === subject.key);
  const removed = list.removed.find((entry) => entry.id === subject.key);
  const title = secret?.name ?? removed?.name;
  if (title === undefined)
    throw new Error("This secret is no longer available.");
  const versions =
    removed?.removal.outcome === "destroyed"
      ? null
      : await context.client.requestWithSignalRequiringHostMethodVersion(
          "environment.secrets.versions",
          { environmentId: subject.environmentId, secretId: subject.key },
          undefined,
          {
            method: "environment.secrets.versions",
            version: { major: 1, minor: 1 },
          },
        );
  const current = versions?.versions.find((version) => version.current);
  const removal = newestRemoval(
    versions?.removal ?? null,
    removed?.removal ?? null,
  );
  return {
    title,
    status: {
      ...status,
      summary: singleSecretSummary(removal, status.hosts),
      retryable: removal !== null && removal.outcome !== "destroyed",
      currentVersion: current === undefined ? null : String(current.ordinal),
      reason: removal === null ? null : hostsRemovedLine(removal),
    },
  };
}

/**
 * The configuration's secrets, read the way the Secrets page reads them: the
 * same request under the SAME WHOLE KEY, so one list answers both and a shared
 * Retry can read the structured host failure (`failedAt`) that the version
 * read does not carry.
 *
 * The page's read appends the viewer to its key
 * (`useEnvironmentSecretsQuery`'s `cacheKeyIdentity`), because a
 * configuration-scoped list is one viewer's answer, so the viewer is part of
 * the key here too. An imperative read under a key of its own would file a
 * second entry that no observer ever refetches, and a sweep over the method's
 * scope would go on reading its answer long after the page's own had moved on.
 *
 * `staleTime: 0` keeps the read itself. Every open asks the host again, as
 * the direct call did, so the answer is as fresh and as authorized as before;
 * the cache holds the result, never a licence to skip the request.
 */
async function readSecretsList(
  environmentId: string,
  context: DetailsProviderContext,
): Promise<SecretsList> {
  const viewerId = useAuthStore.getState().contextMetadata?.userId ?? "";
  return context.queryClient.fetchQuery({
    queryKey: [
      ...hostQueryKeys.method<HostRpcRegistry, "environment.secrets.list">(
        hostRpcServingTierHostId(
          "environment.secrets.list",
          context.hostId,
          readProcessHostRpcTierPlan(),
          null,
        ),
        "environment.secrets.list",
        { environmentId },
      ),
      viewerId,
    ],
    queryFn: ({ signal }) =>
      context.client.requestWithSignalRequiringHostMethodVersion(
        "environment.secrets.list",
        { environmentId },
        signal,
        { method: "environment.secrets.list", version: { major: 1, minor: 1 } },
      ),
    staleTime: 0,
    retry: false,
  });
}

export async function loadSecretDetails(
  subject: DetailsSubject,
  context: DetailsProviderContext,
  status: DetailsStatus,
): Promise<{ readonly title: string; readonly status: DetailsStatus }> {
  const list = await readSecretsList(subject.environmentId, context);
  if (subject.key.length > 0)
    return singleSecretDetails(subject, context, status, list);
  return {
    title: "Secrets",
    status: {
      ...status,
      summary: secretsHostSummary(status.hosts),
      items: secretInventory(subject, list, status.hosts),
    },
  };
}
