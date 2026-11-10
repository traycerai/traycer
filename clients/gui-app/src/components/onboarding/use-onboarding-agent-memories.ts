import { useRef, useState } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import {
  emptyMemoryDraft,
  memoryRowNeedsWrite,
  memoryViewFor,
  withProviderChoice,
  withTraycerChoice,
  type OnboardingMemoryDraft,
  type OnboardingMemoryRow,
  type OnboardingMemoryView,
  type ProviderMemoryControls,
  type TraycerMemoryOutcome,
} from "@/components/onboarding/onboarding-agent-memories-model";
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
const STATUS_IDENTITY = ["onboarding-agent-memories"];

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
   * Traycer first, and the providers only once it is saved: a failure can
   * leave a provider's memories on beside Traycer's, never both off.
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
  // fresh draft, and coming back to the first one does not restore it.
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
   * after the picker moved on updates nothing on screen.
   */
  const record = (
    forHost: string | null,
    change: (current: OnboardingMemoryDraft) => OnboardingMemoryDraft,
  ): void =>
    setStoredDraft((current) =>
      current.hostId === forHost ? change(current) : current,
    );

  const memoryRead = useHostQuery<HostRpcRegistry, "config.agentMemories.get">({
    cacheKeyIdentity: undefined,
    client,
    method: AGENT_MEMORIES_GET,
    params: {},
    options: { enabled: input.active && ready },
  });
  const statusRead = useHostQuery<HostRpcRegistry, "environment.status">({
    cacheKeyIdentity: STATUS_IDENTITY,
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

  const providerControls = providerMemoryControls({
    nativeSetSupported,
    nativeReadable,
    loaded: providersQuery.data !== undefined,
    failed: providersQuery.isError,
  });
  const alreadyOn = memoryRead.data?.enabled === true;
  const view = memoryViewFor({
    draft,
    alreadyOn,
    providers: providersQuery.data?.providers,
    providerControls,
  });

  async function ensureTraycer(forHost: string | null): Promise<boolean> {
    const outcome = draft.traycerOutcome;
    if (outcome?.kind === "saved") return true;
    // Read before writing: a configuration that has it on already needs no
    // write, and a held edit shows here only once it has been saved and
    // received - until then the host still reads the old value.
    const reread = await memoryRead.refetch();
    if (reread.status === "success" && reread.data.enabled) {
      record(forHost, (current) => ({
        ...current,
        traycerOutcome: { kind: "saved" },
      }));
      return true;
    }
    if (outcome?.kind === "queued") {
      const held = await heldEditOutcome(outcome);
      record(forHost, (current) => ({ ...current, traycerOutcome: held }));
      return held.kind === "saved";
    }
    try {
      const answer = await setTraycerMemories.mutateAsync({ enabled: true });
      const next: TraycerMemoryOutcome =
        answer.state === "queued"
          ? {
              kind: "queued",
              uploadId: answer.uploadId,
              environmentId: answer.environmentId,
            }
          : { kind: "saved" };
      if (next.kind === "saved")
        trackSettingChanged("agent-memories", "useTraycerMemories");
      record(forHost, (current) => ({ ...current, traycerOutcome: next }));
      return next.kind === "saved";
    } catch {
      record(forHost, (current) => ({
        ...current,
        traycerOutcome: { kind: "failed", refused: false },
      }));
      return false;
    }
  }

  /**
   * A held edit is never sent twice. `environment.status` names it once the
   * configuration took it (saved) or turned it away (failed, so the next
   * retry may send a fresh one); no word either way leaves it held.
   */
  async function heldEditOutcome(
    held: Extract<TraycerMemoryOutcome, { kind: "queued" }>,
  ): Promise<TraycerMemoryOutcome> {
    if (held.uploadId === null) return held;
    const status = (await statusRead.refetch()).data;
    if (status === undefined) return held;
    const accepted = status.acceptedUploads.some(
      (entry) =>
        entry.uploadId === held.uploadId &&
        entry.environmentId === held.environmentId &&
        entry.kind === "agent_memory" &&
        entry.key === "memory",
    );
    if (accepted) return { kind: "saved" };
    const refused = status.pendingUploads.some(
      (entry) =>
        entry.uploadId === held.uploadId && entry.receipt === "refused",
    );
    return refused ? { kind: "failed", refused: true } : held;
  }

  async function writeProvider(
    forHost: string | null,
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
    record(forHost, (current) => {
      const providerOutcomes = new Map(current.providerOutcomes);
      providerOutcomes.set(row.providerId, { kind, value: row.value });
      return { ...current, providerOutcomes };
    });
    return kind === "saved";
  }

  async function save(): Promise<boolean> {
    if (view.chosen !== true || !ready) return true;
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    const forHost = hostId;
    try {
      if (!(await ensureTraycer(forHost))) return false;
      const writes = view.rows
        .filter(memoryRowNeedsWrite)
        .map((row) => writeProvider(forHost, row));
      const results = await Promise.all(writes);
      return results.every(Boolean);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
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
