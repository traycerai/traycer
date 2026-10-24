import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { removalLabel } from "@/components/settings/details/details-copy";
import type { HostRpcRegistry } from "@/lib/host";
import type {
  DetailsItemStatus,
  DetailsProviderContext,
  DetailsStatus,
  DetailsSubject,
} from "@/lib/settings-details-entry";

type SecretsList = ResponseOfMethod<
  HostRpcRegistry,
  "environment.secrets.list"
>;

function secretInventory(
  subject: DetailsSubject,
  list: SecretsList,
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
        summary: removalLabel(removed.removal.outcome),
        at: removed.removal.destroyedAt ?? removed.removal.revokedAt,
      })),
  ];
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
  const removal = versions?.removal ?? removed?.removal ?? null;
  return {
    title,
    status: {
      ...status,
      summary: removal === null ? "Set" : removalLabel(removal.outcome),
      currentVersion: current === undefined ? null : String(current.ordinal),
      reason:
        removal === null
          ? null
          : `${removal.targets.filter((target) => target.state === "confirmed").length} of ${removal.targets.length} copies removed`,
    },
  };
}

export async function loadSecretDetails(
  subject: DetailsSubject,
  context: DetailsProviderContext,
  status: DetailsStatus,
): Promise<{ readonly title: string; readonly status: DetailsStatus }> {
  const list = await context.client.requestWithSignalRequiringHostMethodVersion(
    "environment.secrets.list",
    { environmentId: subject.environmentId },
    undefined,
    { method: "environment.secrets.list", version: { major: 1, minor: 1 } },
  );
  if (subject.key.length > 0)
    return singleSecretDetails(subject, context, status, list);
  return {
    title: "Secrets",
    status: {
      ...status,
      summary: "Secrets and recent removals",
      items: secretInventory(subject, list),
    },
  };
}
