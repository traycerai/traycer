import { useEffect, useMemo, useRef, useState } from "react";
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
  readonly drafts: readonly HeldDraft[];
}

/**
 * A submitted draft, held from its first write until a write at its address
 * is saved or it is discarded, with what its writes are measured against.
 */
interface HeldDraft {
  /** Its text, kept current as the person types. */
  readonly write: ConfigurationItemWrite;
  /**
   * The revision the person was last told about: the one the draft was first
   * typed over, then each out-of-date refusal's own revision.
   */
  readonly told: number | null;
  /** `told` as it stood when the person last typed. */
  readonly typedAt: number | null;
  /** The value last sent. */
  readonly submitted: ConfigurationItem["value"];
}

/**
 * Who a write is for. The person's own write (a blur, a Save, a Remove) sends
 * at the revision they were last told about. A row's unmount sends only text
 * never submitted, at the revision in force when it was typed.
 */
export type ConfigurationWriteTrigger = "person" | "unmount";

export interface ConfigurationItemWrites {
  readonly pending: PendingItemWrite | null;
  readonly changedAgain: ConfigurationItemWrite | null;
  readonly failure: ConfigurationItemWriteFailure | null;
  readonly drafts: readonly ConfigurationItemWrite[];
  readonly checking: boolean;
  /** The person's own write. */
  readonly write: (write: ConfigurationItemWrite) => Promise<void>;
  /** A row's write as it unmounts, which the person did not make. */
  readonly writeOnUnmount: (write: ConfigurationItemWrite) => Promise<void>;
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

function heldAt(
  drafts: readonly HeldDraft[],
  address: Pick<ConfigurationItem, "kind" | "key" | "os">,
): HeldDraft | undefined {
  return drafts.find((held) =>
    sameConfigurationItemAddress(held.write, address),
  );
}

function withoutHeld(
  drafts: readonly HeldDraft[],
  address: Pick<ConfigurationItem, "kind" | "key" | "os">,
): readonly HeldDraft[] {
  return drafts.filter(
    (held) => !sameConfigurationItemAddress(held.write, address),
  );
}

/** The draft a put submits: held from its first write, its text now `write`'s. */
function submitDraft(
  drafts: readonly HeldDraft[],
  write: ConfigurationItemWrite,
  revision: number | null,
): readonly HeldDraft[] {
  if (write.action === "remove") return drafts;
  const held = heldAt(drafts, write);
  return [
    ...withoutHeld(drafts, write),
    held === undefined
      ? { write, told: revision, typedAt: revision, submitted: write.value }
      : { ...held, write, submitted: write.value },
  ];
}

/**
 * What a write sends, or null for nothing. With no draft held, the row's
 * item is what the person was shown. With one:
 * - the person's write names the revision they were last told about, never
 *   one a newer read put in the row unseen, so a change since is refused;
 * - an unmount sends only text never submitted, at the revision in force
 *   when it was last typed, never one a refusal named after that typing.
 */
function writeBasis(
  asked: ConfigurationItemWrite,
  trigger: ConfigurationWriteTrigger,
  drafts: readonly HeldDraft[],
): {
  readonly write: ConfigurationItemWrite;
  readonly revision: number | null;
} | null {
  const held = heldAt(drafts, asked);
  if (held === undefined)
    return { write: asked, revision: asked.original?.revision ?? null };
  const write = { ...asked, original: held.write.original };
  if (trigger === "person") return { write, revision: held.told };
  if (JSON.stringify(asked.value) === JSON.stringify(held.submitted))
    return null;
  return { write, revision: held.typedAt };
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
  // Typing keeps a held draft's text current, and records the revision the
  // person had been told about when they typed it.
  const updateDraft = (draft: ConfigurationItemWrite): void => {
    setState((current) => {
      const held = heldAt(current.drafts, draft);
      if (current.scope !== scope || held === undefined) return current;
      return {
        ...current,
        drafts: [
          ...withoutHeld(current.drafts, draft),
          { ...held, write: draft, typedAt: held.told },
        ],
      };
    });
  };
  const discardDraft = (
    address: Pick<ConfigurationItem, "kind" | "key" | "os">,
  ): void => {
    setState((current) =>
      current.scope !== scope || current.pending !== null
        ? current
        : {
            ...current,
            drafts: withoutHeld(current.drafts, address),
            failure:
              current.failure !== null &&
              sameConfigurationItemAddress(current.failure.write, address)
                ? null
                : current.failure,
          },
    );
  };
  const send = async (
    asked: ConfigurationItemWrite,
    trigger: ConfigurationWriteTrigger,
  ): Promise<void> => {
    if (source.kind !== "pool" || active.current !== null) return;
    const basis = writeBasis(asked, trigger, state.drafts);
    if (basis === null) return;
    const { write, revision } = basis;
    active.current = write;
    // Submitted drafts survive a failed or refused write and any read that
    // remounts its editor.
    setState((current) => ({
      ...current,
      scope,
      pending: { write, accepted: null },
      changedAgain: null,
      failure: null,
      drafts: submitDraft(current.drafts, write, revision),
    }));
    const request = {
      environmentId: source.environmentId,
      kind: write.kind,
      key: write.key,
      os: write.os,
      revision,
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
      // An out-of-date refusal tells the person the current revision.
      const told =
        result.outcome === "conflict"
          ? (result.current?.revision ?? null)
          : undefined;
      setState((current) => {
        if (current.scope !== scope) return current;
        const held = heldAt(current.drafts, write);
        return {
          ...current,
          pending: null,
          drafts:
            held === undefined || told === undefined
              ? current.drafts
              : [...withoutHeld(current.drafts, write), { ...held, told }],
        };
      });
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
      drafts: withoutHeld(current.drafts, write),
    }));
    void readLatest(write, false);
  };
  const drafts = useMemo(
    () => state.drafts.map((held) => held.write),
    [state.drafts],
  );
  return {
    pending,
    changedAgain: state.changedAgain,
    failure: state.failure,
    drafts,
    updateDraft,
    discardDraft,
    checking: bounded.pending,
    write: (write) => send(write, "person"),
    writeOnUnmount: (write) => send(write, "unmount"),
    retry: bounded.retry,
  };
}
