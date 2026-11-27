import {
  fetchSandboxCostsViaHttp,
  type SandboxCostsFailure,
  type SandboxCostsFetchResult,
} from "./sandbox-control";

export const SANDBOX_COST_REFRESH_MS = 60_000;

interface SandboxCostPrincipal {
  readonly userId: string;
  readonly bearerToken: string;
  readonly isCurrent: () => boolean | Promise<boolean>;
}

interface PendingRead {
  readonly principal: SandboxCostPrincipal;
  readonly result: Promise<SandboxCostsFetchResult>;
}

interface CostSlot {
  pending: PendingRead | null;
  failure: (SandboxCostsFailure & { readonly retryAtMs: number }) | null;
}

// Private to the shell that owns HTTP. Never include these keys in logs or IPC.
const slots = new Map<string, CostSlot>();

/** Electron main and the installed mobile shell each own one HTTP boundary. */
export function readSandboxCostsForAccount(
  serverBaseUrl: string,
  proxyToken: string | null,
  principal: SandboxCostPrincipal,
): Promise<SandboxCostsFetchResult> {
  return readAccountCosts(serverBaseUrl, proxyToken, principal, false);
}

/** Browser tabs hold a shared lock through the bounded HTTP read. */
export function readBrowserSandboxCostsForAccount(
  serverBaseUrl: string,
  principal: SandboxCostPrincipal,
): Promise<SandboxCostsFetchResult> {
  return readAccountCosts(serverBaseUrl, null, principal, true);
}

async function readAccountCosts(
  serverBaseUrl: string,
  proxyToken: string | null,
  principal: SandboxCostPrincipal,
  browser: boolean,
): Promise<SandboxCostsFetchResult> {
  const base = serverBaseUrl.endsWith("/")
    ? serverBaseUrl
    : `${serverBaseUrl}/`;
  const key = JSON.stringify([
    new URL("api/sandboxes/cost", base).href,
    principal.userId,
  ]);
  for (;;) {
    const current = principal.isCurrent();
    if (!(typeof current === "boolean" ? current : await current)) {
      return { kind: "unauthorized" };
    }
    const now = Date.now();
    for (const [slotKey, slot] of slots) {
      if (slot.pending === null && (slot.failure?.retryAtMs ?? 0) <= now) {
        slots.delete(slotKey);
      }
    }
    const slot = slots.get(key) ?? { pending: null, failure: null };
    const pending = slot.pending;
    if (pending !== null) {
      // Keep the old request as a drain fence, even after its sign-in ends.
      const result = await pending.result;
      if (
        pending.principal.bearerToken === principal.bearerToken &&
        (await pending.principal.isCurrent())
      ) {
        return (await principal.isCurrent())
          ? result
          : { kind: "unauthorized" };
      }
      continue;
    }
    if (slot.failure !== null) return slot.failure;

    const read = () =>
      readCostAnswer(serverBaseUrl, proxyToken, principal.bearerToken);
    const transport = browser ? readBrowserCosts(key, principal, read) : read();
    const result = transport
      .then((answer) => {
        if (answer.kind !== "ok" && answer.retryAtMs !== undefined) {
          slot.failure = { ...answer, retryAtMs: answer.retryAtMs };
        }
        return answer;
      })
      .finally(() => {
        slot.pending = null;
        if (slot.failure === null) slots.delete(key);
      });
    slot.pending = { principal, result };
    slots.set(key, slot);
    const answer = await result;
    return (await principal.isCurrent()) ? answer : { kind: "unauthorized" };
  }
}

function costReadFailed(retryAtMs: number): SandboxCostsFailure {
  return {
    kind: "network-error",
    detail: "the sandbox cost request failed",
    retryAtMs,
  };
}

async function readCostAnswer(
  serverBaseUrl: string,
  proxyToken: string | null,
  bearerToken: string,
): Promise<SandboxCostsFetchResult> {
  try {
    const answer = await fetchSandboxCostsViaHttp(
      serverBaseUrl,
      bearerToken,
      proxyToken,
    );
    return answer.kind === "ok"
      ? answer
      : { ...answer, retryAtMs: Date.now() + SANDBOX_COST_REFRESH_MS };
  } catch {
    return costReadFailed(Date.now() + SANDBOX_COST_REFRESH_MS);
  }
}

async function readBrowserCosts(
  key: string,
  principal: SandboxCostPrincipal,
  read: () => Promise<SandboxCostsFetchResult>,
): Promise<SandboxCostsFetchResult> {
  try {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
    );
    const lock = `traycer:sandbox-cost:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    return await navigator.locks.request(
      lock,
      async (): Promise<SandboxCostsFetchResult> => {
        if (!(await principal.isCurrent())) return { kind: "unauthorized" };
        // Share only the failure deadline across tabs, never a bearer or ledger.
        const retryAtMs = Number(localStorage.getItem(lock));
        if (Number.isFinite(retryAtMs) && retryAtMs > Date.now()) {
          return costReadFailed(retryAtMs);
        }
        localStorage.removeItem(lock);
        const answer = await read();
        if (answer.kind !== "ok" && answer.retryAtMs !== undefined) {
          localStorage.setItem(lock, String(answer.retryAtMs));
        }
        return answer;
      },
    );
  } catch {
    // Without the browser boundary, another tab could already own the read.
    return costReadFailed(Date.now() + SANDBOX_COST_REFRESH_MS);
  }
}
