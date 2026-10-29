import { queryOptions } from "@tanstack/react-query";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { ENVIRONMENT_ITEM_KINDS } from "@traycer/protocol/host/environment-schemas";
import type {
  DetailsEntry,
  DetailsHistory,
  DetailsHostStatus,
  DetailsProviderContext,
  DetailsRecovery,
  DetailsStatus,
  DetailsSubject,
} from "@/lib/settings-details-entry";
import { registerDetailsProvider } from "@/lib/settings-details-entry";
import { recoveryForHost } from "@/components/settings/details/details-copy";

import { loadSecretDetails } from "@/components/settings/details/secret-details-status";
import { sandboxDetailsProvider } from "@/lib/sandboxes/sandbox-details-provider";
import { hostQueryKeys, sandboxQueryKeys } from "@/lib/query-keys";
import type {
  SandboxSummary,
  SandboxListResponse,
} from "@traycer/protocol/host/sandbox-control";
import { useAuthStore } from "@/stores/auth/auth-store";
import { unusedSettingLabel } from "@/components/settings/details/details-unused-setting";
import { sandboxSettingsFailed } from "@traycer/protocol/host/sandbox-settings";

type HistoryResponse = ResponseOfMethod<HostRpcRegistry, "environment.history">;
type HistorySubject = RequestOfMethod<
  HostRpcRegistry,
  "environment.history"
>["subject"];

const TITLES: Readonly<Record<string, string>> = {
  secret: "Secrets",
  member: "Member details",
  plan: "Plan details",
  host_settings: "Settings",
  move: "Move to Personal",
  chip: "Settings delivery",
};

function historySubject(subject: DetailsSubject): HistorySubject {
  if (subject.kind === "chip" || subject.key.length === 0) return null;
  return { kind: subject.kind, key: subject.key };
}

/** A host's state for the read's subject; the chip's subject names no item. */
function hostStatus(
  host: HistoryResponse["hostStates"][number],
  itemKind: string | null,
): DetailsHostStatus {
  return {
    hostId: host.hostId,
    name: host.hostName,
    item: host.state === "not_used" ? unusedSettingLabel(host.reason) : null,
    state: host.state,
    reason: null,
    at: host.at,
    lastReportedAt: host.lastReportedAt,
    recovery:
      host.state === "not_used"
        ? null
        : recoveryForHost(host.state, host.reason, host.hostId, itemKind),
  };
}

/**
 * The drawer's `Now`: `<n> not applied on <host>` while a host reports an
 * item it couldn't apply, `Applying on <host>…` while one has an item on its
 * way, else `Applied on <n> hosts`.
 */
export function detailsNowSummary(hosts: readonly DetailsHostStatus[]): string {
  const usedHosts = hosts.filter((host) => host.state !== "not_used");
  if (usedHosts.length === 0 && hosts.length > 0)
    return "No settings to apply on sandboxes";
  const failed = usedHosts.find(
    (host) => host.state === "not_applied" || host.state === "failed",
  );
  if (failed !== undefined) {
    const count = usedHosts.filter(
      (host) =>
        host.hostId === failed.hostId &&
        (host.state === "not_applied" || host.state === "failed"),
    ).length;
    return `${count} not applied on ${failed.name}`;
  }
  const applying = usedHosts.find((host) => host.state !== "applied");
  if (applying !== undefined) return `Applying on ${applying.name}…`;
  const count = new Set(usedHosts.map((host) => host.hostId)).size;
  if (count === 0) return "Not on any host";
  return count === 1 ? "Applied on 1 host" : `Applied on ${count} hosts`;
}

function detailsHistory(history: HistoryResponse): DetailsHistory {
  return {
    readerScope: history.readerScope,
    entries:
      history.readerScope === "status_only"
        ? []
        : history.entries.map((entry) => ({
            at: entry.at,
            actor: entry.actor,
            operation: entry.operation,
            outcome: entry.outcome,
            hosts: [],
          })),
  };
}

type CurrentEnvironmentStatus = ResponseOfMethod<
  HostRpcRegistry,
  "environment.status"
>;

function currentSandboxState(
  previous: string,
  sandbox: SandboxSummary | null,
  status: CurrentEnvironmentStatus | null,
): string {
  if (
    sandbox?.guestConfigured === false ||
    (status !== null && sandboxSettingsFailed(status.items))
  )
    return "not_applied";
  if (status === null) return previous;
  const waiting =
    status.receivedRevision === null ||
    status.items.some(
      (item) => item.status === "pending" || item.status === "received",
    );
  return waiting ? "received" : "applied";
}

/** Recovery admission and guest evidence come from the current sandbox, independently of history. */
function deliveryRecovery(
  host: DetailsHostStatus,
  sandbox: SandboxSummary | null,
  state: string,
  isSandbox: boolean,
): DetailsRecovery | null {
  if (!isSandbox || (state !== "failed" && state !== "not_applied")) {
    return host.recovery;
  }
  return {
    kind: "apply",
    hostId: host.hostId,
    guestSetupFailed:
      sandbox === null ? null : sandbox.guestConfigured === false,
  };
}

/** Join current sandbox delivery with authorized history, preserving offline evidence. */
async function deliveryHostRows(input: {
  readonly host: DetailsHostStatus;
  readonly sandbox: SandboxSummary | null;
  readonly unusedListed: boolean;
  readonly context: DetailsProviderContext;
  readonly diagnostics: boolean;
}): Promise<DetailsHostStatus[]> {
  const { host, sandbox, context, diagnostics } = input;
  if (sandbox !== null && sandbox.state !== "awake")
    return [{ ...host, name: sandbox.displayName }];
  const requestStatus = () =>
    context.client
      .createRequesterForHostId(host.hostId)
      .request("environment.status", {});
  const status = await context.queryClient
    .fetchQuery(
      queryOptions({
        queryKey: hostQueryKeys.method<HostRpcRegistry, "environment.status">(
          host.hostId,
          "environment.status",
          {},
        ),
        queryFn: requestStatus,
        staleTime: 0,
        retry: false,
      }),
    )
    .catch(() => null);
  const unused =
    status?.items.filter((item) => item.status === "not_used") ?? [];
  const isSandbox = sandbox !== null || unused.length > 0;
  const state = isSandbox
    ? currentSandboxState(host.state, sandbox, status)
    : host.state;
  const current: DetailsHostStatus = {
    ...host,
    name: sandbox?.displayName ?? host.name,
    state,
    reason: diagnostics ? host.reason : null,
    recovery: deliveryRecovery(host, sandbox, state, isSandbox),
  };
  if (diagnostics && status !== null)
    return [
      current,
      ...status.items.map(
        ({ key: itemKey, status: state, code }): DetailsHostStatus => ({
          ...current,
          item: itemKey,
          state,
          reason: code,
          recovery: null,
        }),
      ),
    ];
  return [
    current,
    ...(input.unusedListed ? [] : unused).map(
      ({ key: itemKey }): DetailsHostStatus => ({
        ...current,
        item: unusedSettingLabel(itemKey),
        state: "not_used",
        recovery: null,
      }),
    ),
  ];
}

/** All reads here run inside the drawer's Query, including the fresh export read.
 * Current host names come only from the server's separately authorized status;
 * historical actor labels come only from its reader-filtered history.
 */
async function environmentDetailsProvider(
  subject: DetailsSubject,
  context: DetailsProviderContext,
): Promise<DetailsEntry> {
  return loadEnvironmentDetails(subject, context, false);
}

async function loadEnvironmentDetails(
  subject: DetailsSubject,
  context: DetailsProviderContext,
  diagnostics: boolean,
): Promise<DetailsEntry> {
  const response = await context.client.request("environment.history", {
    environmentId: subject.environmentId,
    subject: historySubject(subject),
  });
  const history = detailsHistory(response);
  const latest = history.entries.toSorted((a, b) => b.at - a.at).at(0);
  let title = TITLES[subject.kind] ?? "Settings";
  const hosts = response.hostStates.map((host) =>
    hostStatus(host, historySubject(subject)?.kind ?? null),
  );
  if (diagnostics)
    hosts.forEach((host, index) => {
      hosts[index] = {
        ...host,
        reason: response.hostStates[index]?.reason ?? null,
      };
    });
  if (subject.kind === "chip") {
    const viewer = useAuthStore.getState().contextMetadata?.userId ?? null;
    const sandboxes = context.queryClient
      .getQueriesData<SandboxListResponse | null>({
        queryKey: sandboxQueryKeys.listAll(),
      })
      .filter(([key]) => key.at(-1) === viewer)
      .flatMap(([, answer]) => answer?.sandboxes ?? []);
    const serverUnused = hosts
      .filter((host) => host.state === "not_used")
      .map((host) => ({
        ...host,
        name:
          sandboxes.find((row) => row.hostId === host.hostId)?.displayName ??
          host.name,
      }));
    const rows = await Promise.all(
      hosts
        .filter((host) => host.state !== "not_used")
        .map((host) =>
          deliveryHostRows({
            host,
            sandbox:
              sandboxes.find((row) => row.hostId === host.hostId) ?? null,
            unusedListed: serverUnused.some(
              (item) => item.hostId === host.hostId,
            ),
            context,
            diagnostics,
          }),
        ),
    );
    hosts.splice(0, hosts.length, ...rows.flat(), ...serverUnused);
  }
  let status: DetailsStatus = {
    summary: detailsNowSummary(hosts),
    currentVersion: null,
    changedBy: latest?.actor?.label ?? null,
    changedAt: latest?.at ?? null,
    reason: null,
    hosts,
  };
  if (subject.kind === "secret") {
    const secret = await loadSecretDetails(subject, context, status);
    title = secret.title;
    status = secret.status;
  }

  return {
    subject,
    title,
    status: () => status,
    history: () => history,
    exportDiagnostics: async () => {
      // Retrieval rechecks the reader's authorization, even while the drawer stays open.
      const fresh = await loadEnvironmentDetails(subject, context, true);
      return {
        subject,
        title: fresh.title,
        exportedAt: Date.now(),
        status: fresh.status(),
        history: fresh.history(),
      };
    },
  };
}

for (const kind of [
  ...ENVIRONMENT_ITEM_KINDS,
  "plan",
  "host_settings",
  "move",
  "chip",
]) {
  registerDetailsProvider(kind, environmentDetailsProvider);
}
// A sandbox's evidence is the control plane's row and cost ledger.
registerDetailsProvider("sandbox", sandboxDetailsProvider);
