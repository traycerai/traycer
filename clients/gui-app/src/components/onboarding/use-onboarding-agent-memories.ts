import { useLayoutEffect, useRef, useState } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import {
  emptyMemoryDraft,
  memoryViewFor,
  withProviderChoice,
  withTraycerChoice,
  type OnboardingMemoryDraft,
  type OnboardingMemoryRow,
  type OnboardingMemoryView,
  type ProviderMemoryControls,
} from "@/components/onboarding/onboarding-agent-memories-model";
import {
  NO_SAVE_EVIDENCE,
  runMemorySave,
  traycerStanding,
  type MemorySaveIo,
  type SaveEvidence,
} from "@/components/onboarding/onboarding-memory-save";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import {
  useHostMethodSchemaVersion,
  useHostMethodSupport,
} from "@/hooks/host/use-host-supports-method";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { trackSettingChanged } from "@/lib/analytics";
import { useOptionalHostClient, type HostRpcRegistry } from "@/lib/host";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { providersListReportsNativeMemory } from "@/lib/providers/provider-native-memory";
import { configMutationKeys, providersMutationKeys } from "@/lib/query-keys";

const AGENT_MEMORIES_GET = "config.agentMemories.get";
const AGENT_MEMORIES_SET = "config.agentMemories.set";
/** The act's own cache entries, apart from every other reader of the same methods. */
const ACT_IDENTITY = ["onboarding-agent-memories"];

/** One save: the host its answers are filed against, and when it started. */
interface SaveTarget {
  readonly hostId: string | null;
  /** The act's host selection when the save started; see `selectionRef`. */
  readonly selection: number;
}

/** Whether the act can offer the choice at all on its host. */
export type OnboardingMemoryAvailability =
  | "host-unavailable"
  | "checking"
  | "unsupported"
  | "ready";

export interface OnboardingAgentMemories extends OnboardingMemoryView {
  readonly availability: OnboardingMemoryAvailability;
  readonly draft: OnboardingMemoryDraft;
  /** This host reads Traycer memories as on for its configuration already. */
  readonly alreadyOn: boolean;
  readonly providerControls: ProviderMemoryControls;
  readonly saving: boolean;
  /** Continue has something to save: Traycer memories were chosen. */
  readonly choosing: boolean;
  /** "Use Traycer memories" on the cards. */
  readonly choose: () => void;
  readonly setTraycer: (on: boolean) => void;
  readonly setProvider: (providerId: ProviderId, value: boolean) => void;
  /**
   * Writes what is still unsaved and answers whether everything has landed.
   * Traycer first, and each provider only after a read finds Traycer
   * memories on in the configuration the host serves: a failure can leave a
   * provider's memories on beside Traycer's. Both end up off only when the
   * host moves or the setting changes after the read a write or "done"
   * rested on.
   */
  readonly save: () => Promise<boolean>;
  readonly reloadProviders: () => void;
}

/**
 * The memory act's state and its one write path, held by the TOUR so the
 * choices outlive the act's unmount on Back and Next.
 *
 * Reads the tour's host through the binding the tour re-provides, and the
 * client is optional because the tour renders before any host is bound.
 */
export function useOnboardingAgentMemories(input: {
  /** The act is on screen: read and keep the provider list subscribed. */
  readonly active: boolean;
  /** The tour's host is one its acts may use (`onboardingHostIsUsable`). */
  readonly hostUsable: boolean;
  /**
   * The host the tour's picker names. While a picked host cannot be reached
   * the binding falls back to the app's own host, so the client alone cannot
   * tell that the person has moved on from the host a save started on.
   * A change here stops a running save, as a change of the client's host does.
   */
  readonly pickedHostId: string | null;
}): OnboardingAgentMemories {
  const client = useOptionalHostClient();
  // The host the tour's binding addresses, read off the same client every
  // read and write below goes through.
  const readiness = useReactiveHostReadiness(client);
  const hostId = readiness.hostId;
  const getSupported = useHostMethodSupport(hostId, AGENT_MEMORIES_GET);
  const setSupported = useHostMethodSupport(hostId, AGENT_MEMORIES_SET);
  const nativeSetSupported = useHostMethodSupport(
    hostId,
    "providers.setNativeMemory",
  );
  const nativeReadable = providersListReportsNativeMemory(
    useHostMethodSchemaVersion(hostId, "providers.list"),
  );
  const availability = memoryAvailability({
    hostUsable: input.hostUsable && readiness.canExecute,
    getSupported,
    setSupported,
  });
  const ready = availability === "ready";

  const [storedDraft, setStoredDraft] = useState<OnboardingMemoryDraft>(() =>
    emptyMemoryDraft(hostId),
  );
  // Choices belong to the host they were made on: a different host shows a
  // fresh draft. Coming back to the first host shows its choices again, unless
  // a choice made since on another host replaced them.
  const draft =
    storedDraft.hostId === hostId ? storedDraft : emptyMemoryDraft(hostId);
  /** A choice on screen, made for the host the act shows now. */
  const edit = (
    change: (current: OnboardingMemoryDraft) => OnboardingMemoryDraft,
  ): void =>
    setStoredDraft((current) =>
      change(current.hostId === hostId ? current : emptyMemoryDraft(hostId)),
    );
  /**
   * A write's answer, filed against the host it was SENT to: one that lands
   * after the picker moved on never shows among another host's choices.
   */
  const record = (
    forHost: string | null,
    change: (current: OnboardingMemoryDraft) => OnboardingMemoryDraft,
  ): void =>
    setStoredDraft((current) =>
      current.hostId === forHost ? change(current) : current,
    );

  // The act's own cache entry, never the one Settings → Agent memories reads:
  // a read the act took can be overtaken (a rebind, a later change), and
  // Settings' read on opening would join one still in flight.
  const memoryRead = useHostQuery<HostRpcRegistry, "config.agentMemories.get">({
    cacheKeyIdentity: ACT_IDENTITY,
    client,
    method: AGENT_MEMORIES_GET,
    params: {},
    options: { enabled: input.active && ready },
  });
  const statusRead = useHostQuery<HostRpcRegistry, "environment.status">({
    cacheKeyIdentity: ACT_IDENTITY,
    client,
    method: "environment.status",
    params: {},
    options: { enabled: false, poll: false, gcTime: 0 },
  });
  const providersQuery = useProvidersListForClient(client, {
    enabled: ready,
    subscribed: input.active,
  });
  const setTraycerMemories = useHostScopedMutationForClient(client, {
    method: AGENT_MEMORIES_SET,
    mutationKey: configMutationKeys.agentMemoriesSet(),
    // Reported on the act, beside the change it is about.
    errorMessage: null,
    // Every entry of the method on that host once the write settles: an
    // answer from before it is out of date.
    invalidateMethods: [AGENT_MEMORIES_GET],
  });
  // One observer for every provider. Each provider's write is its own request
  // and a provider is never written twice at once here (`save` does not
  // re-enter), so the per-provider queue Settings needs for rapid flips buys
  // nothing on this act.
  const setNativeMemory = useHostScopedMutationForClient(client, {
    method: "providers.setNativeMemory",
    mutationKey: providersMutationKeys.setNativeMemory(),
    errorMessage: null,
    invalidateMethods: ["providers.list"],
  });

  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const { pickedHostId } = input;
  // Counts every change of the act's host, whether the host its requests
  // reach or the host the picker names. The observers above follow the
  // binding, so a save still running when either moves would send one host's
  // choices to another; every request of a save checks this first. A count,
  // not the ids: picking another host and then the first one again leaves the
  // ids as they were, and the save must stay stopped. A layout effect, so it
  // moves no later than the observers, which take their new options in
  // passive effects.
  const selectionRef = useRef(0);
  useLayoutEffect(() => {
    selectionRef.current += 1;
  }, [hostId, pickedHostId]);
  /** The save may still send: the act's host has not changed since it began. */
  const sendsTo = (target: SaveTarget): boolean =>
    selectionRef.current === target.selection;

  const providerControls = providerMemoryControls({
    nativeSetSupported,
    nativeReadable,
    loaded: providersQuery.data !== undefined,
    failed: providersQuery.isError,
  });
  // What the act knows of its Traycer write, by host and then configuration.
  // Apart from the draft, which a choice on another host replaces: coming
  // back must find a held change still held, never send it again.
  const [evidence, setEvidence] = useState<
    ReadonlyMap<string | null, SaveEvidence>
  >(() => new Map());
  // A save reads and files evidence between its requests, sooner than React
  // renders again.
  const evidenceRef = useRef(evidence);
  const read = memoryRead.data;
  const alreadyOn = read?.enabled === true;
  const view = memoryViewFor({
    draft,
    traycerStanding:
      read === undefined || read.environmentId === null
        ? null
        : traycerStanding(
            read,
            (evidence.get(hostId) ?? NO_SAVE_EVIDENCE).get(read.environmentId),
          ),
    providers: providersQuery.data?.providers,
    providerControls,
  });

  /** The requests of one save, each filing its answer against `target`'s host. */
  function saveIo(target: SaveTarget): MemorySaveIo {
    return {
      current: () => sendsTo(target),
      read: async () => {
        const reread = await memoryRead.refetch();
        return reread.status === "success" ? reread.data : null;
      },
      lookUp: async () => (await statusRead.refetch()).data ?? null,
      set: async () => {
        try {
          const answer = await setTraycerMemories.mutateAsync({
            enabled: true,
          });
          if (answer.state !== "queued")
            trackSettingChanged("agent-memories", "useTraycerMemories");
          return answer;
        } catch {
          return null;
        }
      },
      writeProvider: (row) => writeProvider(target, row),
      evidence: () =>
        evidenceRef.current.get(target.hostId) ?? NO_SAVE_EVIDENCE,
      record: (next) => {
        const all = new Map(evidenceRef.current).set(target.hostId, next);
        evidenceRef.current = all;
        setEvidence(all);
      },
    };
  }

  async function writeProvider(
    target: SaveTarget,
    row: OnboardingMemoryRow,
  ): Promise<boolean> {
    let kind: "saved" | "failed" = "failed";
    try {
      await setNativeMemory.mutateAsync({
        harnessId: providerIdToGuiHarnessId(row.providerId),
        nativeMemory: row.value,
      });
      kind = "saved";
    } catch {
      kind = "failed";
    }
    record(target.hostId, (current) => {
      const providerOutcomes = new Map(current.providerOutcomes);
      providerOutcomes.set(row.providerId, { kind, value: row.value });
      return { ...current, providerOutcomes };
    });
    return kind === "saved";
  }

  function save(): Promise<boolean> {
    if (view.chosen !== true || !ready) return Promise.resolve(true);
    if (savingRef.current) return Promise.resolve(false);
    savingRef.current = true;
    setSaving(true);
    const target: SaveTarget = { hostId, selection: selectionRef.current };
    // The view shows no rows while the host's providers are loading, and no
    // rows is not no providers. A read that failed, or a host that cannot
    // switch them, has been said on the act, and the save goes on without.
    const rows = providerControls === "loading" ? null : view.rows;
    // `.finally` rather than try/finally: React Compiler cannot lower a try
    // without a catch, and would leave this whole hook unmemoized.
    return runMemorySave(saveIo(target), rows)
      .then((result) => {
        if (result !== "moved" && result !== "undiscovered")
          record(target.hostId, (current) => ({
            ...current,
            traycerUnreached: result === "unreached",
          }));
        return result === "done";
      })
      .finally(() => {
        savingRef.current = false;
        setSaving(false);
      });
  }

  return {
    ...view,
    availability,
    draft,
    alreadyOn,
    providerControls,
    saving,
    choosing: ready && view.chosen === true,
    interrupted: ready && view.interrupted,
    choose: () => edit((current) => withTraycerChoice(current, true)),
    setTraycer: (on) => edit((current) => withTraycerChoice(current, on)),
    setProvider: (providerId, value) =>
      edit((current) => withProviderChoice(current, providerId, value)),
    save,
    reloadProviders: () => void providersQuery.refetch(),
  };
}

function memoryAvailability(input: {
  readonly hostUsable: boolean;
  readonly getSupported: boolean | null;
  readonly setSupported: boolean | null;
}): OnboardingMemoryAvailability {
  if (!input.hostUsable) return "host-unavailable";
  // Both, because they negotiate independently: a host that can read the
  // setting but not write it would take a choice and save nothing.
  if (input.getSupported === false || input.setSupported === false)
    return "unsupported";
  if (input.getSupported === null || input.setSupported === null)
    return "checking";
  return "ready";
}

function providerMemoryControls(input: {
  readonly nativeSetSupported: boolean | null;
  readonly nativeReadable: boolean;
  readonly loaded: boolean;
  readonly failed: boolean;
}): ProviderMemoryControls {
  if (input.nativeSetSupported === false) return "unsupported";
  if (!input.loaded) return input.failed ? "failed" : "loading";
  // `providers.list` has answered, so the handshake that names its version
  // is done: a line below 10.8 cannot report the switch at all.
  if (!input.nativeReadable) return "unsupported";
  return input.nativeSetSupported === null ? "loading" : "ready";
}
