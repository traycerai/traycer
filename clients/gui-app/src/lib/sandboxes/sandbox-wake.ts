import {
  MutationObserver as QueryMutationObserver,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ensureSandboxAwake,
  type EnsureSandboxAwakeDeps,
  type SandboxDialFacts,
  type SandboxWakeBudget,
  type SandboxWakeOutcome,
} from "@traycer-clients/shared/host-client/sandbox-control";
import type { AuthService } from "@/lib/auth/auth-service";
import { isSleepingSandboxPick } from "@/components/settings/host-scope/host-option-model";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { HostDirectoryService } from "@/lib/host";
import { getHostBindingSnapshot } from "@/lib/host/runtime";
import { queryClient } from "@/lib/query-client";
import { authQueryKeys, sandboxMutationKeys } from "@/lib/query-keys";
import { formatCreditsRequired } from "@/lib/sandboxes/sandbox-pricing";

/** How often the sandbox list is re-read while a wake is under way. */
const WAKE_POLL_INTERVAL_MS = 2_000;
/**
 * A resume is single-digit seconds and a cold start tens; past this it failed.
 * The budget covers the whole wake, the lifecycle verb's own request included.
 */
const WAKE_TIMEOUT_MS = 120_000;

/**
 * One wake per host at a time, across every caller: two tabs opened together
 * on one suspended sandbox, or a pick followed by the tab it opens, must not
 * resume it twice. A host leaves the map when its wake's lifecycle request has
 * settled, not when the wake answered: a wake that timed out has its request
 * aborted, and until that abort lands a retry joins the timed-out wake rather
 * than sending a second verb into the first one's transition.
 */
const wakesInFlight = new Map<string, Promise<SandboxWakeOutcome>>();

/**
 * A started wake: its `outcome`, and `settled`, which resolves once the
 * outcome is known AND the lifecycle request it sent (if any) has settled.
 */
interface SandboxWakeAttempt {
  readonly outcome: Promise<SandboxWakeOutcome>;
  readonly settled: Promise<void>;
}

/**
 * A wake's outcome, and whether this call joined a wake another caller
 * started. Only the starter reports it, so a shared wake toasts once.
 */
interface SandboxWakeRun {
  readonly outcome: SandboxWakeOutcome;
  readonly joined: boolean;
}

/**
 * One read of the sandbox list: `unread` when the read failed, which says
 * nothing about the sandbox, else the host's row (`null` when the list
 * answered without it, which means it is gone).
 */
type SandboxFactsRead =
  | { readonly kind: "unread" }
  | { readonly kind: "listed"; readonly facts: SandboxDialFacts | null };

async function readSandboxFacts(
  auth: AuthService,
  hostId: string,
): Promise<SandboxFactsRead> {
  const result = await auth.listSandboxes();
  if (result.kind !== "ok") return { kind: "unread" };
  const row = result.response.sandboxes.find((s) => s.hostId === hostId);
  return {
    kind: "listed",
    facts:
      row === undefined
        ? null
        : { sandboxId: row.id, state: row.state, frozen: row.frozen },
  };
}

function startWakeAttempt(
  auth: AuthService,
  hostId: string,
): SandboxWakeAttempt {
  let verbRequest: Promise<unknown> = Promise.resolve();
  const outcome = wakeSandboxHost(
    auth,
    hostId,
    (sandboxId, verb, timeoutMs) => {
      const request = auth.runSandboxVerb(sandboxId, verb, timeoutMs);
      verbRequest = request;
      return request;
    },
  );
  const settled = outcome
    .then(() => verbRequest)
    .then(
      () => undefined,
      () => undefined,
    );
  return { outcome, settled };
}

async function wakeSandboxHost(
  auth: AuthService,
  hostId: string,
  wake: EnsureSandboxAwakeDeps["wake"],
): Promise<SandboxWakeOutcome> {
  const first = await readSandboxFacts(auth, hostId);
  // The directory already said this host is a sandbox, so a failed first
  // read is a failure to retry, never "it no longer exists".
  if (first.kind === "unread") {
    return { kind: "failed", detail: "the sandbox list could not be read" };
  }
  if (first.facts === null) {
    return { kind: "not-wakeable", state: null };
  }
  let last: SandboxDialFacts = first.facts;
  return ensureSandboxAwake({
    initial: first.facts,
    wake,
    readFacts: async () => {
      const read = await readSandboxFacts(auth, hostId);
      // A failed poll says nothing about the sandbox: keep waiting on what
      // was last known rather than calling it gone.
      if (read.kind === "unread") return last;
      if (read.facts !== null) last = read.facts;
      return read.facts;
    },
    sleep,
    now: () => Date.now(),
    pollIntervalMs: WAKE_POLL_INTERVAL_MS,
    timeoutMs: WAKE_TIMEOUT_MS,
    startBudget,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startBudget(ms: number): SandboxWakeBudget {
  let stop = (): void => undefined;
  const elapsed = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    stop = () => clearTimeout(timer);
  });
  return { elapsed, cancel: () => stop() };
}

async function runSharedWake(
  auth: AuthService,
  hostId: string,
): Promise<SandboxWakeRun> {
  const running = wakesInFlight.get(hostId);
  if (running !== undefined) {
    return { outcome: await running, joined: true };
  }
  const attempt = startWakeAttempt(auth, hostId);
  wakesInFlight.set(hostId, attempt.outcome);
  void attempt.settled.then(() => {
    if (wakesInFlight.get(hostId) === attempt.outcome) {
      wakesInFlight.delete(hostId);
    }
  });
  return { outcome: await attempt.outcome, joined: false };
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
            ? "Add credits, then try again."
            : `Add ${formatCreditsRequired(outcome.shortfallMc)} credits, then try again.`,
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
      toastWakeFailed();
      return;
  }
}

function toastWakeFailed(): void {
  toast.error("Couldn't wake this sandbox", {
    description: "Try again in a moment.",
  });
}

/** What a wake reads from the host runtime binding. */
interface SandboxWakeBinding {
  readonly auth: AuthService;
  readonly directory: HostDirectoryService;
}

/**
 * Starts waking a sandbox host: the one wake behind a tab open and a pick in
 * a host picker. Runs as a mutation under `sandboxMutationKeys.wake(hostId)`,
 * so a tile on that host shows "Resuming" while it runs, joins a wake already
 * in flight for the host rather than resuming it twice, and reports the
 * outcome once, from the call that started it. On any answer the directory
 * and the host list are refreshed, so a woken host dials the moment it is
 * listed `awake`.
 *
 * Imperative (a `MutationObserver` per call) because a picker learns the host
 * at pick time, while a hook's mutation key is fixed when it mounts.
 */
export function startSandboxWake(
  client: QueryClient,
  binding: SandboxWakeBinding | null,
  hostId: string,
): void {
  // Signed out there is no sandbox row to wake, and nothing a retry fixes.
  if (binding === null) return;
  const { auth, directory } = binding;
  // A build that cannot reach the control plane (staging) sends no wake: it
  // says why once, instead of a failed request's "try again".
  const unavailable = auth.sandboxControlUnavailableReason();
  if (unavailable !== null) {
    toast.warning("Couldn't wake this sandbox", { description: unavailable });
    return;
  }
  const observer = new QueryMutationObserver<SandboxWakeRun>(client, {
    mutationKey: sandboxMutationKeys.wake(hostId),
    mutationFn: () => runSharedWake(auth, hostId),
    onSuccess: (run) => {
      if (run.joined) return;
      void directory.refresh();
      void client.invalidateQueries({
        queryKey: authQueryKeys.registeredHostsAll(),
      });
      toastWakeOutcome(run.outcome);
    },
    onError: () => toastWakeFailed(),
  });
  // Subscribed for the mutation's life, so the cache can collect it once it
  // settles; a rejection is already reported by `onError`.
  const unsubscribe = observer.subscribe(() => undefined);
  observer
    .mutate()
    .catch(() => undefined)
    .finally(unsubscribe);
}

/**
 * What a `pin` or `bind` picker calls with the row it was given: a sleeping,
 * non-frozen sandbox is woken (the pick is the user's next action, core
 * flows); every other row is left alone. The caller still stores its pick at
 * once; its surface follows the fallback until the sandbox answers.
 *
 * Not a hook: a pick is an event, and the pickers render in places that have
 * no query provider of their own. It reads the app-wide binding and query
 * client, the same objects the providers hand the rest of the app.
 */
export function wakeSandboxOnPick(host: HostScopeOption): void {
  if (!isSleepingSandboxPick(host)) return;
  startSandboxWake(queryClient, getHostBindingSnapshot(), host.hostId);
}
