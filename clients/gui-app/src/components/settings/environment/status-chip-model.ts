import type { DetailsHostStatus } from "@/lib/settings-details-entry";

export interface ConfigurationChipHost {
  readonly hostId: string;
  readonly name: string;
  readonly state:
    | "applied"
    | "applying"
    | "unsupported"
    | "not_applied"
    | "waiting_resume";
  readonly lastReportedAt: number | null;
  readonly rows: readonly DetailsHostStatus[];
}

export interface ConfigurationChipState {
  readonly text: string;
  readonly tone: "success" | "warning" | "info";
}

function hostNames(hosts: readonly ConfigurationChipHost[]): string {
  if (hosts.length >= 4) return `${hosts.length} hosts`;
  const first = hosts.at(0)?.name ?? "";
  const second = hosts.at(1)?.name;
  if (second === undefined) return first;
  return hosts.length === 2
    ? `${first} and ${second}`
    : `${first}, ${second} and 1 more`;
}

export function configurationChipState(
  hosts: readonly ConfigurationChipHost[],
  savingOffline: boolean,
): ConfigurationChipState {
  if (savingOffline) return { text: "Saving when back online", tone: "info" };
  const unsupported = hosts.find((host) => host.state === "unsupported");
  if (unsupported !== undefined)
    return {
      text: `Update ${unsupported.name} to use your settings`,
      tone: "info",
    };
  const failed = hosts.find((host) => host.state === "not_applied");
  if (failed !== undefined) {
    const count = failed.rows.filter(
      (row) => row.state === "not_applied",
    ).length;
    return { text: `${count} not applied on ${failed.name}`, tone: "warning" };
  }
  const applying = hosts.find(
    (host) => host.state === "applying" || host.state === "waiting_resume",
  );
  if (applying !== undefined)
    return { text: `Applying on ${applying.name}…`, tone: "info" };
  if (hosts.length === 0) return { text: "No hosts yet", tone: "info" };
  return { text: `✓ On ${hostNames(hosts)}`, tone: "success" };
}
