import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { SandboxCreateAccepted } from "@traycer/protocol/host/sandbox-control";
import type { HostDirectoryService } from "@/lib/host";
import {
  buildHostScopeOptions,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
import type { ActivationOutcome } from "@/components/settings/host-scope/use-host-scope";
import { toastWakeFailed, WAKE_TIMEOUT_MS } from "@/lib/sandboxes/sandbox-wake";
import type { AttributableDurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { dialableHostEndpoint } from "@/lib/host/transport-key";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

interface PoolSandboxStart {
  readonly accepted: SandboxCreateAccepted;
  readonly directory: HostDirectoryService;
  readonly current: () => boolean;
  readonly personal: boolean;
  readonly activate: (
    option: HostScopeOption,
    report: (show: () => void) => void,
  ) => Promise<ActivationOutcome>;
  readonly openTransport: (
    hostId: string,
  ) => AttributableDurableStreamTransport;
  readonly place: (hostId: string) => void;
}

function ready(hostId: string, personal: boolean): boolean {
  const { leases, servingPeer } = useSelectionAuthorityStore.getState();
  return (
    (!personal ||
      (servingPeer?.kind === "computer" && servingPeer.hostId === hostId)) &&
    leases.some((lease) => lease.hostId === hostId && lease.status === "ready")
  );
}

function watch<T>(
  read: () => T | null,
  subscribe: (check: () => void) => () => void,
): { readonly answer: Promise<T>; readonly stop: () => void } {
  let stop = (): void => undefined;
  const answer = new Promise<T>((resolve) => {
    const check = (): void => {
      const found = read();
      if (found !== null) resolve(found);
    };
    stop = subscribe(check);
    check();
  });
  return { answer, stop };
}

export async function finishPoolSandboxStart(
  input: PoolSandboxStart,
): Promise<void> {
  const { accepted, directory, current, personal } = input;
  const { hostId, sandbox } = accepted;
  let timer: number | undefined;
  const budgetMs = Math.max(WAKE_TIMEOUT_MS, sandbox.wakeBudgetMs ?? 0);
  const expiresAt = Date.now() + budgetMs;
  const elapsed = new Promise<"expired">((resolve) => {
    timer = window.setTimeout(() => resolve("expired"), budgetMs);
  });
  const fail = (): void => {
    if (current()) toastWakeFailed();
  };
  let transport: AttributableDurableStreamTransport | null = null;
  try {
    const listed = watch<HostDirectoryEntry>(
      () => {
        const entry = directory.findById(hostId);
        if (personal || dialableHostEndpoint(entry) !== null) return entry;
        return null;
      },
      (check) => {
        const subscription = directory.onChange(check);
        return () => subscription.dispose();
      },
    );
    const entry = await Promise.race([listed.answer, elapsed]).finally(
      listed.stop,
    );
    if (!current()) return;
    if (entry === "expired") {
      fail();
      return;
    }

    let reportWakeFailure: (show: () => void) => void = () => undefined;
    const wake = new Promise<() => void>((resolve) => {
      reportWakeFailure = (show) => {
        if (Date.now() < expiresAt) resolve(show);
      };
    });
    if (personal) {
      const [option] = buildHostScopeOptions({
        directory: [entry],
        registry: [],
        sandboxes: [sandbox],
        localHostId: null,
        activeHostId: null,
        hasLiveSession: () => ready(hostId, false),
        leases: useSelectionAuthorityStore.getState().leases,
        authorityAttached: useSelectionAuthorityStore.getState().attached,
        localService: undefined,
        localPlatform: null,
        localHostSettingUp: false,
        localHostTerminalRunNote: null,
        nowMs: Date.now(),
      });
      const outcome = await input.activate(option, reportWakeFailure);
      if (!current() || outcome === "reported") return;
      if (outcome === "declined") {
        fail();
        return;
      }
    } else if (!ready(hostId, false)) {
      // Team hosts are ineligible for the app-wide dial. Keep a session until
      // the surface can claim its pin and open its own connection.
      transport = input.openTransport(hostId);
    }

    // Activate can answer after the deadline. Its refusal owns the notice,
    // and a sandbox already serving at the successful reply counts as ready.
    const connected = watch(
      () => (ready(hostId, personal) ? "ready" : null),
      useSelectionAuthorityStore.subscribe,
    );
    const outcome = await Promise.race([
      connected.answer,
      elapsed,
      wake,
    ]).finally(connected.stop);
    if (!current()) return;
    if (outcome === "expired") fail();
    else if (outcome === "ready") {
      if (!personal) input.place(hostId);
    } else {
      outcome();
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    transport?.close();
  }
}
