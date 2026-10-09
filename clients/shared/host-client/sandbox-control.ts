import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import {
  SANDBOX_REFUSAL_CODE_FROZEN,
  SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
  SANDBOX_REFUSAL_CODE_VERB_NOT_AVAILABLE,
  sandboxCatalogueSchema,
  sandboxCreateAcceptedSchema,
  sandboxListResponseSchema,
  sandboxRefusalBodySchema,
  userSandboxCostSchema,
  type SandboxCatalogue,
  type SandboxCreateAccepted,
  type SandboxCreateRequest,
  type SandboxLifecycleVerb,
  type SandboxListResponse,
  type UserSandboxCost,
} from "@traycer/protocol/host/sandbox-control";
import { composeRequestAbort } from "../auth/request-abort";

/**
 * The raw calls to traycer-server's sandbox control plane (`/api/sandboxes`)
 * with the user bearer. Transport-only, a sibling of
 * `fetchRegisteredHostsViaHttp`, and it runs where that runs: desktop calls it
 * from Electron main (traycer-server's CORS allow-list is the web dashboard
 * origin, not the app renderer), mobile calls it through the native HTTP
 * layer, browser/dev shells call it directly.
 *
 * Every function here never throws: transport failures, non-2xx answers and
 * malformed bodies collapse into a discriminated, structured-clone-safe result
 * so it crosses the Electron IPC boundary unchanged.
 */

/** Per-request budget of the reads. */
const SANDBOX_CONTROL_FETCH_TIMEOUT_MS = 10_000;

/**
 * A create waits for the provider's capacity, its boot and the boot-token
 * delivery: the server runs it on its 360 s `transfer` forward tier. Ten
 * seconds over it, so the server's own answer (or its forward timeout) is
 * what the client reads, never a client abort first.
 */
const SANDBOX_CREATE_FETCH_TIMEOUT_MS = 370_000;

/** A destroy runs on the server's 180 s `part-verify` tier; same margin. */
const SANDBOX_DESTROY_FETCH_TIMEOUT_MS = 190_000;

/**
 * The lifecycle verbs run on the server's 360 s `transfer` tier and answer
 * `202` at their own 300 s deadline; same margin as a create, so the server's
 * answer is what the client reads. The ceiling of every verb request: the
 * card's verbs wait this long, and a wake passes what is left of its own
 * budget instead (see {@link runSandboxVerbViaHttp}).
 */
export const SANDBOX_VERB_FETCH_TIMEOUT_MS = 370_000;

/**
 * A non-`ok` answer:
 *  - `unauthorized`  — the bearer was rejected (401/403).
 *  - `refused`       — the control plane answered with its typed refusal body
 *                      (`{ code, ... }`); `code` is the server's word (see
 *                      `SandboxRefusalBody` for the known ones).
 *  - `network-error` — transport/timeout, a 5xx without a typed body, a
 *                      body this build cannot parse, or a sandbox id that is
 *                      not one path segment (refused before any request).
 *                      `detail` is a stable classification, never a raw
 *                      server body.
 */
export type SandboxControlFailure =
  | { readonly kind: "unauthorized" }
  | {
      readonly kind: "refused";
      readonly status: number;
      readonly code: string;
      /** The code's own detail (`shape_not_offered`'s bound, the gate's verdict). */
      readonly reason: string | null;
      readonly shortfallMc: number | null;
      readonly newRateMcPerHour: number | null;
      readonly currentAwakeBurnMcPerHour: number | null;
    }
  | { readonly kind: "network-error"; readonly detail: string }
  /**
   * Never sent: this build cannot reach the control plane at all
   * (`IRunnerHost.sandboxControlUnavailableReason`). `reason` is the
   * user-facing line.
   */
  | { readonly kind: "unavailable"; readonly reason: string };

export type SandboxListFetchResult =
  | { readonly kind: "ok"; readonly response: SandboxListResponse }
  | SandboxControlFailure;

export type SandboxCatalogueFetchResult =
  | { readonly kind: "ok"; readonly catalogue: SandboxCatalogue }
  | SandboxControlFailure;

export type SandboxCostsFetchResult =
  | { readonly kind: "ok"; readonly costs: UserSandboxCost }
  | SandboxControlFailure;

export type SandboxCreateFetchResult =
  | { readonly kind: "ok"; readonly accepted: SandboxCreateAccepted }
  | SandboxControlFailure;

/**
 * `destroy` and the lifecycle verbs answer with a body the client does not
 * read: the sandbox list is what every surface renders the row from.
 * `settled` is the status the server chose: `true` for `200` (the row is at
 * rest), `false` for `202` (still moving at the server's deadline).
 */
export type SandboxVerbFetchResult =
  | { readonly kind: "ok"; readonly settled: boolean }
  | SandboxControlFailure;

/** The two lifecycle verbs a client calls to wake a sandbox before dialing. */
export type SandboxWakeVerb = Extract<SandboxLifecycleVerb, "resume" | "start">;

/**
 * A sandbox id as the URL may carry it: one plain path segment. The server
 * mints lowercase ULIDs; anything else (empty, `.`, `..`, a separator or an
 * escape) is refused before a URL is built, because `encodeURIComponent`
 * leaves `.` and `..` alone and `new URL` resolves them as dot segments, so
 * `..` with `/resume` would `POST /api/resume` under the user's bearer and an
 * empty id on destroy would `DELETE` the collection.
 */
const SANDBOX_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const INVALID_SANDBOX_ID: SandboxControlFailure = {
  kind: "network-error",
  detail: "the sandbox id is not one the control plane mints",
};

function sandboxesUrl(serverBaseUrl: string, path: string): string {
  const base = serverBaseUrl.endsWith("/")
    ? serverBaseUrl
    : `${serverBaseUrl}/`;
  return new URL(`api/sandboxes${path}`, base).toString();
}

type RawCall =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly body: unknown;
    }
  | { readonly kind: "network-error"; readonly detail: string };

interface CallInit {
  readonly method: string;
  readonly body: string | null;
  readonly timeoutMs: number;
}

async function call(
  url: string,
  init: CallInit,
  bearerToken: string,
): Promise<RawCall> {
  // Not `AbortSignal.timeout`, which the iOS WebView floor does not have; see
  // `request-abort.ts`. Cleared once the body is read, which the timeout also
  // bounds.
  const abort = composeRequestAbort(null, init.timeoutMs);
  try {
    return await callWithSignal(url, init, bearerToken, abort.signal);
  } finally {
    abort.clear();
  }
}

async function callWithSignal(
  url: string,
  init: CallInit,
  bearerToken: string,
  signal: AbortSignal,
): Promise<RawCall> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers:
        init.body === null
          ? {
              Authorization: `Bearer ${bearerToken}`,
              Accept: "application/json",
            }
          : {
              Authorization: `Bearer ${bearerToken}`,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
      body: init.body,
      signal,
    });
  } catch (error: unknown) {
    return {
      kind: "network-error",
      detail:
        error instanceof Error
          ? `the request never completed (${error.name})`
          : "the request never completed",
    };
  }
  let body: unknown = null;
  try {
    // An empty or non-JSON body (a proxy's HTML page, a 204) reads as `null`
    // rather than throwing before the status is classified.
    const text = await response.text();
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { kind: "response", status: response.status, body };
}

/** Classifies a non-2xx answer. */
function failureOf(status: number, body: unknown): SandboxControlFailure {
  if (status === 401 || status === 403) {
    return { kind: "unauthorized" };
  }
  const refusal = sandboxRefusalBodySchema.safeParse(body);
  if (refusal.success) {
    return {
      kind: "refused",
      status,
      code: refusal.data.code,
      reason: refusal.data.reason ?? null,
      shortfallMc: refusal.data.shortfallMc ?? null,
      newRateMcPerHour: refusal.data.newRateMcPerHour ?? null,
      currentAwakeBurnMcPerHour: refusal.data.currentAwakeBurnMcPerHour ?? null,
    };
  }
  return {
    kind: "network-error",
    detail: `the control plane answered HTTP ${status} without a typed refusal`,
  };
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** `GET /api/sandboxes`: the signed-in user's sandboxes. */
export async function listSandboxesViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
): Promise<SandboxListFetchResult> {
  const raw = await call(
    sandboxesUrl(serverBaseUrl, ""),
    { method: "GET", body: null, timeoutMs: SANDBOX_CONTROL_FETCH_TIMEOUT_MS },
    bearerToken,
  );
  if (raw.kind === "network-error") return raw;
  if (!isSuccess(raw.status)) return failureOf(raw.status, raw.body);
  const parsed = sandboxListResponseSchema.safeParse(raw.body);
  if (!parsed.success) {
    return {
      kind: "network-error",
      detail: "the sandbox list did not match the contract",
    };
  }
  return { kind: "ok", response: parsed.data };
}

/** `GET /api/sandboxes/catalogue`: providers, shape bounds, regions, prices. */
export async function fetchSandboxCatalogueViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
): Promise<SandboxCatalogueFetchResult> {
  const raw = await call(
    sandboxesUrl(serverBaseUrl, "/catalogue"),
    { method: "GET", body: null, timeoutMs: SANDBOX_CONTROL_FETCH_TIMEOUT_MS },
    bearerToken,
  );
  if (raw.kind === "network-error") return raw;
  if (!isSuccess(raw.status)) return failureOf(raw.status, raw.body);
  const parsed = sandboxCatalogueSchema.safeParse(raw.body);
  if (!parsed.success) {
    return {
      kind: "network-error",
      detail: "the sandbox catalogue did not match the contract",
    };
  }
  return { kind: "ok", catalogue: parsed.data };
}

/**
 * `GET /api/sandboxes/cost`: every listed sandbox's cost from the control
 * plane's ledger, and the user's awake burn.
 */
export async function fetchSandboxCostsViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
): Promise<SandboxCostsFetchResult> {
  const raw = await call(
    sandboxesUrl(serverBaseUrl, "/cost"),
    { method: "GET", body: null, timeoutMs: SANDBOX_CONTROL_FETCH_TIMEOUT_MS },
    bearerToken,
  );
  if (raw.kind === "network-error") return raw;
  if (!isSuccess(raw.status)) return failureOf(raw.status, raw.body);
  const parsed = userSandboxCostSchema.safeParse(raw.body);
  if (!parsed.success) {
    return {
      kind: "network-error",
      detail: "the sandbox cost did not match the contract",
    };
  }
  return { kind: "ok", costs: parsed.data };
}

/** `POST /api/sandboxes`: `202` with the sandbox and host ids. */
export async function createSandboxViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  request: SandboxCreateRequest,
): Promise<SandboxCreateFetchResult> {
  const raw = await call(
    sandboxesUrl(serverBaseUrl, ""),
    {
      method: "POST",
      body: JSON.stringify(request),
      timeoutMs: SANDBOX_CREATE_FETCH_TIMEOUT_MS,
    },
    bearerToken,
  );
  if (raw.kind === "network-error") return raw;
  if (!isSuccess(raw.status)) return failureOf(raw.status, raw.body);
  const parsed = sandboxCreateAcceptedSchema.safeParse(raw.body);
  if (!parsed.success) {
    return {
      kind: "network-error",
      detail: "the create answer did not match the contract",
    };
  }
  return { kind: "ok", accepted: parsed.data };
}

/**
 * `DELETE /api/sandboxes/:id`: `200` destroyed, `202` still destroying (both
 * `ok`; the list shows the rest), `404 sandbox_not_found` when it is already
 * gone, which the caller decides how to read.
 */
export async function destroySandboxViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  sandboxId: string,
): Promise<SandboxVerbFetchResult> {
  if (!SANDBOX_ID_PATTERN.test(sandboxId)) return INVALID_SANDBOX_ID;
  const raw = await call(
    sandboxesUrl(serverBaseUrl, `/${sandboxId}`),
    {
      method: "DELETE",
      body: null,
      timeoutMs: SANDBOX_DESTROY_FETCH_TIMEOUT_MS,
    },
    bearerToken,
  );
  if (raw.kind === "network-error") return raw;
  if (!isSuccess(raw.status)) return failureOf(raw.status, raw.body);
  return { kind: "ok", settled: raw.status !== 202 };
}

/**
 * `POST /api/sandboxes/:id/{suspend,resume,stop,start}`. `200` once the row
 * is at rest, `202` when it is still moving at the server's deadline (both
 * `ok`: the sandbox list shows the rest); a wake's caller then waits for the
 * host list to say `awake` (see {@link ensureSandboxAwake}).
 *
 * `timeoutMs` is when the request is aborted, capped at
 * {@link SANDBOX_VERB_FETCH_TIMEOUT_MS}: a wake passes what is left of its
 * budget, so a request that outlives the wake is aborted with it rather than
 * left to land a verb in a transition a retry has started.
 */
export async function runSandboxVerbViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  sandboxId: string,
  verb: SandboxLifecycleVerb,
  timeoutMs: number,
): Promise<SandboxVerbFetchResult> {
  if (!SANDBOX_ID_PATTERN.test(sandboxId)) return INVALID_SANDBOX_ID;
  const raw = await call(
    sandboxesUrl(serverBaseUrl, `/${sandboxId}/${verb}`),
    {
      method: "POST",
      body: null,
      timeoutMs: Math.min(
        Math.max(timeoutMs, 0),
        SANDBOX_VERB_FETCH_TIMEOUT_MS,
      ),
    },
    bearerToken,
  );
  if (raw.kind === "network-error") return raw;
  if (!isSuccess(raw.status)) return failureOf(raw.status, raw.body);
  return { kind: "ok", settled: raw.status !== 202 };
}

// -----------------------------------------------------------------------------
// Wake before dial
// -----------------------------------------------------------------------------

/** States a sandbox does not come back from: its disk is gone or going. */
const SANDBOX_TERMINAL_STATES: ReadonlySet<HostSandboxState> = new Set([
  "destroying",
  "destroyed",
  "failed",
  "released",
]);

/**
 * Whether a row's stored out-of-credits flag is in effect. The registry and
 * the sandbox list keep a row's last `frozen` value after it is destroyed, so
 * a terminal state wins: a destroyed sandbox is destroyed, not "frozen, add
 * credits". Every reader that turns the flag into words, actions or a wake
 * reads it through this.
 */
export function isSandboxFrozenInEffect(
  state: HostSandboxState | null,
  frozen: boolean,
): boolean {
  return frozen && (state === null || !SANDBOX_TERMINAL_STATES.has(state));
}

/** What the host list says about one sandbox right now. */
export interface SandboxDialFacts {
  readonly sandboxId: string;
  readonly state: HostSandboxState | null;
  readonly frozen: boolean;
}

/**
 * The outcome of {@link ensureSandboxAwake}:
 *  - `awake`              — dial it.
 *  - `refused`            — the typed `SANDBOX_FROZEN` refusal, from the row's
 *                           own `frozen` flag: frozen for lack of credits, so
 *                           a dial would only wait out relay timeouts against
 *                           a host that is down on purpose.
 *  - `credit-gate`        — the wake gate refused for lack of credits.
 *  - `wake-not-available` — this control plane does not serve the lifecycle
 *                           verbs yet (`501 verb_not_available`).
 *  - `not-wakeable`       — the sandbox is destroyed, failed or released.
 *  - `failed`             — anything else, with a stable `detail`.
 */
export type SandboxWakeOutcome =
  | { readonly kind: "awake" }
  | {
      readonly kind: "refused";
      readonly code: "SANDBOX_FROZEN";
      readonly message: string;
    }
  | {
      readonly kind: "credit-gate";
      readonly shortfallMc: number | null;
      readonly burnMcPerHour: number | null;
    }
  | { readonly kind: "wake-not-available" }
  | { readonly kind: "not-wakeable"; readonly state: HostSandboxState | null }
  | { readonly kind: "failed"; readonly detail: string };

export interface EnsureSandboxAwakeDeps {
  /** The facts the caller dialed from (its host list row joined to the sandbox id). */
  readonly initial: SandboxDialFacts;
  /**
   * Calls the wake verb; the runner host's `runSandboxVerb`. `timeoutMs` is
   * what is left of the wake's budget, and the request is aborted once it is
   * spent.
   */
  readonly wake: (
    sandboxId: string,
    verb: SandboxWakeVerb,
    timeoutMs: number,
  ) => Promise<SandboxVerbFetchResult>;
  /** Re-reads the facts (a fresh host list read); `null` when the row is gone. */
  readonly readFacts: () => Promise<SandboxDialFacts | null>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** How often the facts are re-read while waiting for `awake`. */
  readonly pollIntervalMs: number;
  /**
   * How long a wake may take before the caller is told it failed: the WHOLE
   * wake, the lifecycle verb included.
   */
  readonly timeoutMs: number;
  /** Starts the wake's budget clock; see {@link SandboxWakeBudget}. */
  readonly startBudget: (ms: number) => SandboxWakeBudget;
}

/**
 * The wake's one budget, started before the lifecycle verb is sent.
 * `elapsed` settles once the budget is spent and every await of the wake
 * races it; `cancel` stops the clock once the wake has its answer.
 */
export interface SandboxWakeBudget {
  readonly elapsed: Promise<void>;
  cancel(): void;
}

const BUDGET_SPENT: unique symbol = Symbol("sandbox-wake-budget-spent");

/** `work`'s answer, or {@link BUDGET_SPENT} if the budget runs out first. */
function withinBudget<T>(
  work: Promise<T>,
  budget: SandboxWakeBudget,
): Promise<T | typeof BUDGET_SPENT> {
  return new Promise<T | typeof BUDGET_SPENT>((resolve, reject) => {
    void work.then(resolve, reject);
    void budget.elapsed.then(() => resolve(BUDGET_SPENT));
  });
}

const WAKE_TIMED_OUT: SandboxWakeOutcome = {
  kind: "failed",
  detail: "the sandbox did not report awake in time",
};

/**
 * Why a STAGING build offers no sandbox surfaces
 * (`IRunnerHost.sandboxControlUnavailableReason`). Staging's traycer-server,
 * which serves the sandbox control plane, is fronted by Google IAP, and IAP
 * admits only the host's own service account: an app's call carries the
 * user's bearer alone and is refused before it reaches the server. No client
 * holds an IAP credential, and none is given one.
 */
export const SANDBOXES_UNAVAILABLE_IN_STAGING =
  "Sandboxes aren't available in staging builds: the staging server only accepts calls from hosts.";

export const SANDBOX_FROZEN_MESSAGE =
  "This sandbox is paused because your credits ran out. Add credits to wake it.";

/**
 * Wakes a sandbox before a tab dials it: resume a suspended (or suspending)
 * one, start a stopped (or stopping) one, then wait until the host list says
 * `awake`. Called at tab open only, never from a session's reconnect loop -
 * a reconnect that woke sandboxes would keep a forgotten tab's metered
 * machine awake for as long as the tab exists.
 */
export async function ensureSandboxAwake(
  deps: EnsureSandboxAwakeDeps,
): Promise<SandboxWakeOutcome> {
  const settled = settledOutcome(deps.initial);
  if (settled !== null) return settled;

  // One budget for the whole wake, taken BEFORE the verb: the lifecycle verb
  // alone can hold its request for minutes, and a budget that started after
  // it let one wake pend for over six minutes with every retry joining it.
  const deadline = deps.now() + deps.timeoutMs;
  const budget = deps.startBudget(deps.timeoutMs);
  try {
    const verb = wakeVerbFor(deps.initial.state);
    if (verb !== null) {
      const result = await withinBudget(
        deps.wake(deps.initial.sandboxId, verb, deadline - deps.now()),
        budget,
      );
      if (result === BUDGET_SPENT) return WAKE_TIMED_OUT;
      if (result.kind !== "ok") return outcomeOfWakeFailure(result);
    }

    while (deps.now() < deadline) {
      await deps.sleep(deps.pollIntervalMs);
      const facts = await withinBudget(deps.readFacts(), budget);
      if (facts === BUDGET_SPENT) return WAKE_TIMED_OUT;
      if (facts === null) {
        return { kind: "not-wakeable", state: null };
      }
      const outcome = settledOutcome(facts);
      if (outcome !== null) return outcome;
    }
    return WAKE_TIMED_OUT;
  } finally {
    budget.cancel();
  }
}

/** A final answer from facts alone, or `null` while the sandbox is on its way. */
function settledOutcome(facts: SandboxDialFacts): SandboxWakeOutcome | null {
  if (isSandboxFrozenInEffect(facts.state, facts.frozen)) {
    return {
      kind: "refused",
      code: "SANDBOX_FROZEN",
      message: SANDBOX_FROZEN_MESSAGE,
    };
  }
  switch (facts.state) {
    case "awake":
      return { kind: "awake" };
    case "destroying":
    case "destroyed":
    case "failed":
    case "released":
      return { kind: "not-wakeable", state: facts.state };
    case "creating":
    case "suspending":
    case "suspended":
    case "resuming":
    case "stopping":
    case "stopped":
    case "starting":
    case null:
      return null;
  }
}

/**
 * Whether a sandbox in this state is asleep: suspended or stopped, or on its
 * way there. A wake (a tab open, a pick in a host picker) brings it back.
 */
export function isSandboxAsleep(state: HostSandboxState | null): boolean {
  return wakeVerbFor(state) !== null;
}

/**
 * The verb that wakes a sandbox from this state, or `null` when the control
 * plane is already bringing it up (a wake arriving mid-suspend is resumed by
 * the server once the suspend lands, so `suspending` takes `resume` too).
 */
function wakeVerbFor(state: HostSandboxState | null): SandboxWakeVerb | null {
  switch (state) {
    case "suspending":
    case "suspended":
      return "resume";
    case "stopping":
    case "stopped":
      return "start";
    case "creating":
    case "resuming":
    case "starting":
    case "awake":
    case "destroying":
    case "destroyed":
    case "failed":
    case "released":
    case null:
      return null;
  }
}

function outcomeOfWakeFailure(
  failure: SandboxControlFailure,
): SandboxWakeOutcome {
  if (failure.kind === "unauthorized") {
    return { kind: "failed", detail: "the control plane refused the bearer" };
  }
  if (failure.kind === "network-error") {
    return { kind: "failed", detail: failure.detail };
  }
  if (failure.kind === "unavailable") {
    return { kind: "failed", detail: failure.reason };
  }
  if (failure.code === SANDBOX_REFUSAL_CODE_VERB_NOT_AVAILABLE) {
    return { kind: "wake-not-available" };
  }
  // The row froze between the list read and the verb.
  if (failure.code === SANDBOX_REFUSAL_CODE_FROZEN) {
    return {
      kind: "refused",
      code: "SANDBOX_FROZEN",
      message: SANDBOX_FROZEN_MESSAGE,
    };
  }
  if (failure.code === SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT) {
    return {
      kind: "credit-gate",
      shortfallMc: failure.shortfallMc,
      burnMcPerHour: failure.currentAwakeBurnMcPerHour,
    };
  }
  return {
    kind: "failed",
    detail: `the control plane refused the wake (${failure.code})`,
  };
}
