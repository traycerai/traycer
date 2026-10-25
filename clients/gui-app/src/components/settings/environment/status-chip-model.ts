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

/**
 * How the chip names a set of hosts: "<A>", "<A> and <B>", "<A>, <B> and 1
 * more", and from four on "<n> <plural>".
 */
export function namedHosts(
  names: readonly string[],
  plural: "hosts" | "computers",
): string {
  if (names.length >= 4) return `${names.length} ${plural}`;
  const first = names.at(0) ?? "";
  const second = names.at(1);
  if (second === undefined) return first;
  return names.length === 2
    ? `${first} and ${second}`
    : `${first}, ${second} and 1 more`;
}

/**
 * The chip's line. `emptyText` is what it reads while no host runs the
 * configuration: Personal names computers and sandboxes, a team its hosts.
 */
export function configurationChipState(
  hosts: readonly ConfigurationChipHost[],
  savingOffline: boolean,
  emptyText: string,
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
  if (hosts.length === 0) return { text: emptyText, tone: "info" };
  return {
    text: `✓ On ${namedHosts(
      hosts.map((host) => host.name),
      "hosts",
    )}`,
    tone: "success",
  };
}
