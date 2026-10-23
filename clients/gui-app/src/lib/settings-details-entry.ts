import type { QueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

export interface DetailsSubject {
  readonly environmentId: string;
  /** Built-ins: secret, member, plan, host_settings, move, chip and sandbox.
   * Open to additional providers without changing the drawer contract.
   */
  readonly kind: string;
  readonly key: string;
}

export type DetailsReaderScope = "full" | "own" | "status_only";

export interface DetailsRecovery {
  readonly kind: "repair" | "install" | "retry" | "overview";
  readonly hostId: string;
}

/** Metadata only: never add values, tokens, credentials or arbitrary payloads.
 * Host names and actor labels must already be authorized by the provider.
 */
export interface DetailsHostStatus {
  readonly hostId: string;
  readonly name: string;
  readonly item: string | null;
  readonly state: string;
  readonly reason: string | null;
  readonly at: number | null;
  readonly lastReportedAt: number | null;
  readonly recovery: DetailsRecovery | null;
}

export interface DetailsItemStatus {
  readonly subject: DetailsSubject;
  readonly title: string;
  readonly summary: string;
  readonly at: number | null;
}

/** Value-free current evidence, already filtered to the reader's authority. */
export interface DetailsStatus {
  readonly summary: string;
  readonly currentVersion: string | null;
  readonly changedBy: string | null;
  readonly changedAt: number | null;
  readonly reason: string | null;
  readonly hosts: readonly DetailsHostStatus[];
  /** Page-level entries, including retained removed-secret metadata. */
  readonly items?: readonly DetailsItemStatus[];
}

export interface DetailsHistoryEntry {
  readonly at: number;
  readonly actor: {
    readonly label: string;
    readonly tombstoned: boolean;
  } | null;
  readonly operation: string;
  readonly outcome: string;
  readonly hosts: readonly DetailsHostStatus[];
}

/** Value-free history: server readerScope governs both display and export. */
export interface DetailsHistory {
  readonly readerScope: DetailsReaderScope;
  readonly entries: readonly DetailsHistoryEntry[];
}

/** A typed, value-free export. No unstructured diagnostic payload is allowed. */
export interface DetailsExport {
  readonly subject: DetailsSubject;
  readonly title: string;
  readonly exportedAt: number;
  readonly status: DetailsStatus;
  readonly history: DetailsHistory;
}

/** All three results contain metadata only, never a setting or secret value.
 * Providers recheck authorization on retrieval and filter names themselves;
 * the drawer must not infer authorization from local membership or host data.
 */
export interface DetailsEntry {
  readonly subject: DetailsSubject;
  readonly title: string;
  readonly status: () => DetailsStatus;
  readonly history: () => DetailsHistory;
  readonly exportDiagnostics: () => Promise<DetailsExport>;
}

export interface DetailsProviderContext {
  readonly hostId: string | null;
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
}

export type DetailsProvider = (
  subject: DetailsSubject,
  context: DetailsProviderContext,
) => Promise<DetailsEntry>;
