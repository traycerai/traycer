import { useEffect, useRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentOs } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentConfigurationItemWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { useBoundedRead } from "@/hooks/environment/team/use-bounded-read";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import type { ConfigurationItem } from "@/hooks/environment/team/use-configuration-items-query";
import {
  configurationShellValueSchema,
  configurationTextValueSchema,
} from "@/hooks/environment/team/configuration-item-values";
import { useConfigurationSource } from "./configuration-source";

export interface ConfigurationItemWrite {
  readonly kind: "variable" | "env_override" | "shell";
  readonly key: string;
  readonly os: ConfigurationItem["os"];
  readonly action: "put" | "remove";
  readonly draftField: "value" | "path" | "args" | null;
  readonly value: ConfigurationItem["value"];
  readonly original: ConfigurationItem | null;
}

export interface ConfigurationItemWriteFailure {
  readonly write: ConfigurationItemWrite;
  readonly message: string;
}

interface AcceptedWrite {
  readonly revision: number | null;
  readonly checking: boolean;
  readonly readSucceeded: boolean;
}

export interface PendingItemWrite {
  readonly write: ConfigurationItemWrite;
  readonly accepted: AcceptedWrite | null;
}

interface ItemWriteState {
  readonly scope: string | null;
  readonly pending: PendingItemWrite | null;
  readonly changedAgain: ConfigurationItemWrite | null;
  readonly failure: ConfigurationItemWriteFailure | null;
  readonly drafts: readonly ConfigurationItemWrite[];
}

export interface ConfigurationItemWrites {
  readonly pending: PendingItemWrite | null;
  readonly changedAgain: ConfigurationItemWrite | null;
  readonly failure: ConfigurationItemWriteFailure | null;
  readonly drafts: readonly ConfigurationItemWrite[];
  readonly checking: boolean;
  readonly write: (write: ConfigurationItemWrite) => Promise<void>;
  readonly retry: () => void;
  readonly updateDraft: (draft: ConfigurationItemWrite) => void;
  readonly discardDraft: (
    address: Pick<ConfigurationItem, "kind" | "key" | "os">,
  ) => void;
}

type ItemsRead = Pick<
  UseQueryResult<readonly ConfigurationItem[], HostRpcError>,
  "data" | "isError" | "refetch"
>;

export function sameConfigurationItemAddress(
  left: Pick<ConfigurationItem, "kind" | "key" | "os">,
  right: Pick<ConfigurationItem, "kind" | "key" | "os">,
): boolean {
  return (
    left.kind === right.kind && left.key === right.key && left.os === right.os
  );
}

/** The addresses one editor shows. Write state outside it is another editor's. */
export type ConfigurationWriteScope = (
  address: Pick<ConfigurationItem, "kind" | "key" | "os">,
) => boolean;

/** Text items of one kind: every OS under `any`, else one; one provider's keys when `providerId` is set. */
export function textWriteScope(
  kind: "variable" | "env_override",
  os: EnvironmentOs,
  providerId: string | null,
): ConfigurationWriteScope {
  return (address) =>
    address.kind === kind &&
    (os === "any" || address.os === os) &&
    (providerId === null || address.key.startsWith(`${providerId}:`));
}

/** The one shell item of one OS. */
export function shellWriteScope(os: EnvironmentOs): ConfigurationWriteScope {
  return (address) =>
    sameConfigurationItemAddress(address, {
      kind: "shell",
      key: "shell",
      os,
    });
}

export function pendingWriteInScope(
  writes: ConfigurationItemWrites,
  scope: ConfigurationWriteScope,
): PendingItemWrite | null {
  return writes.pending !== null && scope(writes.pending.write)
    ? writes.pending
    : null;
}

export function failureInScope(
  writes: ConfigurationItemWrites,
  scope: ConfigurationWriteScope,
): ConfigurationItemWriteFailure | null {
  return writes.failure !== null && scope(writes.failure.write)
    ? writes.failure
    : null;
}

export function configurationItemDraft(
  writes: ConfigurationItemWrites,
  address: Pick<ConfigurationItem, "kind" | "key" | "os">,
): ConfigurationItemWrite | null {
  return (
    writes.drafts.find((draft) =>
      sameConfigurationItemAddress(draft, address),
    ) ?? null
  );
}

function retainDraft(
  drafts: readonly ConfigurationItemWrite[],
  write: ConfigurationItemWrite,
): readonly ConfigurationItemWrite[] {
  if (write.action === "remove") return drafts;
  return [
    ...drafts.filter((draft) => !sameConfigurationItemAddress(draft, write)),
    write,
  ];
}

function acceptedValueMatches(
  write: ConfigurationItemWrite,
  row: ConfigurationItem,
): boolean {
  if (write.kind === "shell") {
    const accepted = configurationShellValueSchema.parse(write.value);
    const read = configurationShellValueSchema.parse(row.value);
    return (
      accepted.path === read.path &&
      JSON.stringify(accepted.args) === JSON.stringify(read.args)
    );
  }
  return (
    configurationTextValueSchema.parse(write.value).value ===
    configurationTextValueSchema.parse(row.value).value
  );
}

function reconciliation(
  pending: PendingItemWrite,
  items: readonly ConfigurationItem[],
): "waiting" | "confirmed" | "changed" {
  const receipt = pending.accepted;
  if (receipt === null) return "waiting";
  const row = items.find((item) =>
    sameConfigurationItemAddress(item, pending.write),
  );
  if (row === undefined)
    return pending.write.action === "remove" && receipt.readSucceeded
      ? "confirmed"
      : "waiting";
  if (receipt.revision === null) {
    if (
      pending.write.action === "remove" ||
      !receipt.readSucceeded ||
      row.revision <= (pending.write.original?.revision ?? -1)
    )
      return "waiting";
    return acceptedValueMatches(pending.write, row) ? "confirmed" : "changed";
  }
  if (row.revision < receipt.revision) return "waiting";
  if (pending.write.action === "remove")
    return row.revision > receipt.revision ? "changed" : "waiting";
  return acceptedValueMatches(pending.write, row) ? "confirmed" : "changed";
}

/** Submitted drafts survive reads; accepted receipts release only after authoritative readback. */
export function useConfigurationItemWrites(
  query: ItemsRead,
  onOutcome: (result: EnvironmentConfigurationItemWriteResponse) => void,
): ConfigurationItemWrites {
  const source = useConfigurationSource();
  const scope = source.kind === "pool" ? source.environmentId : null;
  const { put, remove } = useConfigurationItemMutations();
  const [state, setState] = useState<ItemWriteState>({
    scope,
    pending: null,
    changedAgain: null,
    failure: null,
    drafts: [],
  });
  const active = useRef<ConfigurationItemWrite | null>(null);
  const attempt = useRef(0);
  if (state.scope !== scope) {
    setState({
      scope,
      pending: null,
      changedAgain: null,
      failure: null,
      drafts: [],
    });
  }
  const pending = state.scope === scope ? state.pending : null;
  if (
    pending?.accepted !== null &&
    pending !== null &&
    !query.isError &&
    query.data !== undefined
  ) {
    const result = reconciliation(pending, query.data);
    if (result !== "waiting") {
      setState({
        ...state,
        pending: null,
        changedAgain: result === "changed" ? pending.write : null,
      });
    }
  }
  useEffect(() => {
    if (pending === null) active.current = null;
  }, [pending]);
  useEffect(
    () => () => {
      active.current = null;
      attempt.current += 1;
    },
    [scope],
  );
  const readLatest = async (
    write: ConfigurationItemWrite,
    cancelRefetch: boolean,
  ): Promise<void> => {
    const currentAttempt = ++attempt.current;
    const updateRead = (checking: boolean, readSucceeded: boolean): void => {
      if (currentAttempt !== attempt.current) return;
      setState((current) => {
        const pending = current.pending;
        if (
          current.scope !== scope ||
          pending?.write !== write ||
          pending.accepted === null
        )
          return current;
        return {
          ...current,
          pending: {
            write,
            accepted: { ...pending.accepted, checking, readSucceeded },
          },
        };
      });
    };
    updateRead(true, false);
    try {
      const result = await query.refetch({ cancelRefetch });
      updateRead(false, !result.isError);
    } catch {
      updateRead(false, false);
    }
  };

  const retry = (): void => {
    if (pending?.accepted !== null && pending !== null)
      void readLatest(pending.write, true);
  };
  const bounded = useBoundedRead({
    isPending: pending?.accepted?.checking === true,
    isError: false,
    refetch: () => {
      retry();
      return Promise.resolve();
    },
  });
  const updateDraft = (draft: ConfigurationItemWrite): void => {
    setState((current) =>
      current.scope !== scope
        ? current
        : { ...current, drafts: retainDraft(current.drafts, draft) },
    );
  };
  const discardDraft = (
    address: Pick<ConfigurationItem, "kind" | "key" | "os">,
  ): void => {
    setState((current) =>
      current.scope !== scope || current.pending !== null
        ? current
        : {
            ...current,
            drafts: current.drafts.filter(
              (draft) => !sameConfigurationItemAddress(draft, address),
            ),
            failure:
              current.failure !== null &&
              sameConfigurationItemAddress(current.failure.write, address)
                ? null
                : current.failure,
          },
    );
  };
  const write = async (write: ConfigurationItemWrite): Promise<void> => {
    if (source.kind !== "pool" || active.current !== null) return;
    active.current = write;
    // Submitted drafts survive a refused write and any read that remounts its editor.
    setState((current) => ({
      scope,
      pending: { write, accepted: null },
      changedAgain: null,
      failure: null,
      drafts: retainDraft(current.drafts, write),
    }));
    const request = {
      environmentId: source.environmentId,
      kind: write.kind,
      key: write.key,
      os: write.os,
      revision: write.original?.revision ?? null,
    };
    let result: EnvironmentConfigurationItemWriteResponse;
    try {
      result = await (write.action === "put"
        ? put.mutateAsync({ ...request, value: write.value })
        : remove.mutateAsync(request));
    } catch (error) {
      setState((current) =>
        current.scope !== scope || current.pending?.write !== write
          ? current
          : {
              ...current,
              pending: null,
              failure: {
                write,
                message: error instanceof Error ? error.message : String(error),
              },
            },
      );
      if (active.current === write) active.current = null;
      return;
    }
    if (active.current !== write) return;
    onOutcome(result);
    if (result.outcome !== "saved") {
      active.current = null;
      setState((current) =>
        current.scope !== scope ? current : { ...current, pending: null },
      );
      return;
    }
    setState((current) => ({
      ...current,
      scope,
      pending: {
        write,
        accepted: {
          revision: result.revision,
          checking: true,
          readSucceeded: false,
        },
      },
      changedAgain: null,
      failure: null,
      drafts: current.drafts.filter(
        (draft) => !sameConfigurationItemAddress(draft, write),
      ),
    }));
    void readLatest(write, false);
  };
  return {
    pending,
    changedAgain: state.changedAgain,
    failure: state.failure,
    drafts: state.drafts,
    updateDraft,
    discardDraft,
    checking: bounded.pending,
    write,
    retry: bounded.retry,
  };
}
