import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  ensureSandboxAwake,
  type SandboxDialFacts,
  type SandboxWakeOutcome,
} from "@traycer-clients/shared/host-client/sandbox-control";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostBinding, type HostDirectoryService } from "@/lib/host";
import { authQueryKeys, sandboxMutationKeys } from "@/lib/query-keys";
import { formatCredits } from "@/lib/sandboxes/sandbox-pricing";

/** How often the sandbox list is re-read while a wake is under way. */
const WAKE_POLL_INTERVAL_MS = 2_000;
/** A resume is single-digit seconds and a cold start tens; past this it failed. */
const WAKE_TIMEOUT_MS = 120_000;

/** States a tab open wakes a sandbox from. */
const WAKEABLE_STATES: ReadonlySet<HostSandboxState> = new Set([
  "suspending",
  "suspended",
  "stopping",
  "stopped",
]);

/**
 * One wake per host at a time, across every tile: two tabs on one suspended
 * sandbox opened together must not resume it twice.
 */
const wakesInFlight = new Map<string, Promise<SandboxWakeOutcome>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readSandboxFacts(
  auth: AuthService,
  hostId: string,
  previous: SandboxDialFacts | null,
): Promise<SandboxDialFacts | null> {
  const result = await auth.listSandboxes();
  // A failed read says nothing about the sandbox: keep waiting on what was
  // last known rather than calling it gone.
  if (result.kind !== "ok") return previous;
  const row = result.response.sandboxes.find((s) => s.hostId === hostId);
  return row === undefined
    ? null
    : { sandboxId: row.id, state: row.state, frozen: row.frozen };
}

async function wakeSandboxHost(
  auth: AuthService,
  hostId: string,
): Promise<SandboxWakeOutcome> {
  const initial = await readSandboxFacts(auth, hostId, null);
  if (initial === null) {
    return { kind: "not-wakeable", state: null };
  }
  let last: SandboxDialFacts = initial;
  return ensureSandboxAwake({
    initial,
    wake: (sandboxId, verb) => auth.wakeSandbox(sandboxId, verb),
    readFacts: async () => {
      const facts = await readSandboxFacts(auth, hostId, last);
      if (facts !== null) last = facts;
      return facts;
    },
    sleep,
    now: () => Date.now(),
    pollIntervalMs: WAKE_POLL_INTERVAL_MS,
    timeoutMs: WAKE_TIMEOUT_MS,
  });
}

function toastWakeOutcome(outcome: SandboxWakeOutcome): void {
  switch (outcome.kind) {
    case "awake":
      return;
    case "refused":
      toast.warning("This sandbox is frozen", {
        description: outcome.message,
      });
      return;
    case "credit-gate":
      toast.warning("Not enough credits to wake this sandbox", {
        description:
          outcome.shortfallMc === null
            ? "Add credits, then open the tab again."
            : `Add ${formatCredits(outcome.shortfallMc)} credits, then open the tab again.`,
      });
      return;
    case "wake-not-available":
      toast.warning("This sandbox can't be woken from here yet", {
        description:
          "Waking a suspended or stopped sandbox isn't available yet.",
      });
      return;
    case "not-wakeable":
      toast.warning("This sandbox can't be woken", {
        description:
          outcome.state === null
            ? "It no longer exists."
            : `It is ${outcome.state}.`,
      });
      return;
    case "failed":
      toast.error("Couldn't wake this sandbox", {
        description: "Try opening the tab again in a moment.",
      });
      return;
  }
}

interface SandboxWakeContext {
  readonly directory: HostDirectoryService | null;
}

/**
 * Wakes a tile's sandbox host. Mounted only for a tile that was OPENED in this
 * session (`SandboxWakeOnTileOpen` gates on the open provenance), never for
 * one a layout restored: opening a tab is the inbound action the core flows
 * name, while a restore (or a session's reconnect loop) waking every sandbox a
 * canvas ever showed would keep forgotten machines awake on the meter.
 *
 * Fires once per mount, when the host's directory entry says the sandbox is
 * suspended, stopped or frozen. A frozen
 * sandbox is refused at once with the typed `SANDBOX_FROZEN` refusal, instead
 * of a dial that would wait out relay timeouts. On `awake` the directory is
 * refreshed so the tab dials the moment the host answers.
 */
export function useSandboxWakeForOpenedTile(hostId: string): void {
  const entry = useHostDirectoryEntry(hostId);
  const facts =
    entry !== null && isRemoteHostDirectoryEntry(entry) ? entry.sandbox : null;
  const needsWake =
    facts !== null &&
    (facts.frozen ||
      (facts.state !== null && WAKEABLE_STATES.has(facts.state)));

  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const wake = useMutation({
    mutationKey: sandboxMutationKeys.wake(hostId),
    onMutate: (): SandboxWakeContext => ({
      directory: binding === null ? null : binding.directory,
    }),
    mutationFn: async (): Promise<SandboxWakeOutcome> => {
      if (binding === null) {
        return { kind: "failed", detail: "signed out" };
      }
      const running = wakesInFlight.get(hostId);
      if (running !== undefined) return running;
      const started = wakeSandboxHost(binding.auth, hostId);
      wakesInFlight.set(hostId, started);
      try {
        return await started;
      } finally {
        wakesInFlight.delete(hostId);
      }
    },
    onSuccess: (outcome, _variables, context) => {
      void context.directory?.refresh();
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHostsAll(),
      });
      toastWakeOutcome(outcome);
    },
  });

  const firedRef = useRef(false);
  const { mutate } = wake;
  useEffect(() => {
    if (!needsWake || firedRef.current) return;
    firedRef.current = true;
    mutate();
  }, [needsWake, mutate]);
}
