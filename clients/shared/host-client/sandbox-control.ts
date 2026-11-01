import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import {
  SANDBOX_REFUSAL_CODE_FROZEN,
  SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
  SANDBOX_REFUSAL_CODE_VERB_NOT_AVAILABLE,
  sandboxAutomationOpenResponseSchema,
  sandboxAutomationResponseSchema,
  sandboxCatalogueSchema,
  sandboxCreateAcceptedSchema,
  sandboxLifecycleVerbResponseSchema,
  sandboxListResponseSchema,
  sandboxRefusalBodySchema,
  userSandboxCostSchema,
  type SandboxAutomationOpenTarget,
  type SandboxAutomationResponse,
  type SandboxCatalogue,
  type SandboxCreditSource,
  type SandboxCreateAccepted,
  type SandboxCreateRequest,
  type SandboxLifecycleVerb,
  type SandboxListResponse,
  type SandboxPatchRequest,
  type SandboxSummary,
  type SandboxVerbGesture,
  type UserSandboxCost,
} from "@traycer/protocol/host/sandbox-control";
import {
  agentReasoningEffortOptionSchema,
  type GuiAgentModelOption,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import { z } from "zod";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";

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
      readonly creditSource?: SandboxCreditSource | null;
      readonly newRateMcPerHour: number | null;
      readonly currentAwakeBurnMcPerHour: number | null;
      /** A server-composed sentence for the person, shown verbatim. */
      readonly message: string | null;
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

export type TraycerModelsFetchResult =
  | {
      readonly kind: "ok";
      readonly models: ReadonlyArray<GuiAgentModelOption>;
    }
  | SandboxControlFailure;

export type SandboxCostsFetchResult =
  | { readonly kind: "ok"; readonly costs: UserSandboxCost }
  | SandboxControlFailure;

export type SandboxCreateFetchResult =
  | { readonly kind: "ok"; readonly accepted: SandboxCreateAccepted }
  | SandboxControlFailure;

export type SandboxAutomationFetchResult =
  | { readonly kind: "ok"; readonly automation: SandboxAutomationResponse }
  | SandboxControlFailure;

/**
 * The open's answer: the row, and `settled` as {@link SandboxVerbFetchResult}
 * carries it (`true` for `200` awake, `false` for `202` still moving).
 */
export type SandboxAutomationOpenFetchResult =
  | {
      readonly kind: "ok";
      readonly sandbox: SandboxSummary;
      readonly settled: boolean;
    }
  | SandboxControlFailure;

/**
 * `destroy`, `patch` and `keep` answer with a body the client does not read:
 * the sandbox list is what every surface renders the row from. `settled` is the status the server
 * chose: `true` for `200` (the row is at rest), `false` for `202` (still
 * moving at the server's deadline).
 */
export type SandboxVerbFetchResult =
  | { readonly kind: "ok"; readonly settled: boolean }
  | SandboxControlFailure;

/**
 * A lifecycle verb's answer: {@link SandboxVerbFetchResult}, plus the state
 * the server's row reached, which need not be the verb's own (a suspend whose
 * purge found the guest unreachable lands `stopped`). `state` is `null` when
 * the body did not parse: the verb still succeeded.
 */
export type SandboxLifecycleVerbFetchResult =
  | {
      readonly kind: "ok";
      readonly settled: boolean;
      readonly state: HostSandboxState | null;
    }
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

/**
 * `proxyToken` is the Google IAP id-token a staging desktop's main process
 * mints (its `iap-proxy-token.ts`), sent as `Proxy-Authorization` ahead of the
 * user's `Authorization`. Every other caller passes `null` and sends exactly
 * the user's bearer: a browser cannot set `Proxy-Authorization` at all.
 */
async function call(
  url: string,
  init: CallInit,
  bearerToken: string,
  proxyToken: string | null,
): Promise<RawCall> {
  // Not `AbortSignal.timeout`, which the iOS WebView floor does not have; see
  // `request-abort.ts`. Cleared once the body is read, which the timeout also
  // bounds.
  const abort = composeRequestAbort(null, init.timeoutMs);
  try {
    return await callWithSignal(
      url,
      init,
      requestHeaders(init, bearerToken, proxyToken),
      abort.signal,
    );
  } finally {
    abort.clear();
  }
}

/** The proxy credential first and the caller's own last, as the host sends them. */
function requestHeaders(
  init: CallInit,
  bearerToken: string,
  proxyToken: string | null,
): Record<string, string> {
  const headers: Record<string, string> =
    proxyToken === null
      ? {}
      : { "Proxy-Authorization": `Bearer ${proxyToken}` };
  headers.Authorization = `Bearer ${bearerToken}`;
  headers.Accept = "application/json";
  if (init.body !== null) headers["Content-Type"] = "application/json";
  return headers;
}

async function callWithSignal(
  url: string,
  init: CallInit,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<RawCall> {
  let response: Response;
  try {
    response = await untilAborted(
      fetch(url, { method: init.method, headers, body: init.body, signal }),
      signal,
    );
  } catch (error: unknown) {
    return neverCompleted(error);
  }
  let body: unknown = null;
  try {
    // An empty or non-JSON body (a proxy's HTML page, a 204) reads as `null`
    // rather than throwing before the status is classified.
    const text = await untilAborted(response.text(), signal);
    body = text.length === 0 ? null : JSON.parse(text);
  } catch (error: unknown) {
    // A body that never arrived before the deadline is not an empty answer:
    // the request did not complete, whatever its status said.
    if (signal.aborted) return neverCompleted(error);
    body = null;
  }
  return { kind: "response", status: response.status, body };
}

function neverCompleted(error: unknown): RawCall {
  return {
    kind: "network-error",
    detail:
      error instanceof Error
        ? `the request never completed (${error.name})`
        : "the request never completed",
  };
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
      creditSource: refusal.data.creditSource ?? null,
      newRateMcPerHour: refusal.data.newRateMcPerHour ?? null,
      currentAwakeBurnMcPerHour: refusal.data.currentAwakeBurnMcPerHour ?? null,
      message: refusal.data.message ?? null,
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
  proxyToken: string | null,
): Promise<SandboxListFetchResult> {
  const raw = await call(
    sandboxesUrl(serverBaseUrl, ""),
    { method: "GET", body: null, timeoutMs: SANDBOX_CONTROL_FETCH_TIMEOUT_MS },
    bearerToken,
    proxyToken,
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

/** `GET /api/sandboxes/catalogue`: providers, shapes, regions, prices. */
export async function fetchSandboxCatalogueViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
): Promise<SandboxCatalogueFetchResult> {
  const raw = await call(
    sandboxesUrl(serverBaseUrl, "/catalogue"),
    { method: "GET", body: null, timeoutMs: SANDBOX_CONTROL_FETCH_TIMEOUT_MS },
    bearerToken,
    proxyToken,
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

/** The keys of a Traycer catalog row the picker shows; the rest are the server's. */
const traycerCatalogModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).nullish(),
  description: z.string().nullish(),
  provider: z.string().min(1).nullish(),
  contextWindow: z.number().nullish(),
  maxOutputTokens: z.number().nullish(),
  supportsImages: z.boolean().nullish(),
  defaultReasoningEffort: z.string().nullish(),
  supportedReasoningEfforts: z
    .array(agentReasoningEffortOptionSchema)
    .nullish(),
  deprecationNotice: z.string().nullish(),
});
type TraycerCatalogModel = z.infer<typeof traycerCatalogModelSchema>;

/**
 * The catalog names its upstream by id alone. A group header never prefixes
 * its models' names (the picker strips it from them), so gemini's is its
 * vendor; an unknown id is title-cased.
 */
const TRAYCER_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  xai: "xAI",
  meta: "Meta",
  openrouter: "OpenRouter",
  gemini: "Google",
};

function traycerProviderLabel(provider: string): string {
  return (
    TRAYCER_PROVIDER_LABELS[provider] ??
    provider
      .split(/[-_]/)
      .filter((part) => part.length > 0)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(" ")
  );
}

/** A catalog row as the Traycer harness lists it, under the same slug. */
function traycerModelOption(model: TraycerCatalogModel): GuiAgentModelOption {
  const provider = model.provider ?? null;
  return {
    harnessId: "traycer",
    slug: `traycer:${model.id}`,
    label: model.name ?? model.id,
    description: model.description ?? null,
    contextWindow: model.contextWindow ?? null,
    maxOutputTokens: model.maxOutputTokens ?? null,
    defaultReasoningEffort: model.defaultReasoningEffort ?? null,
    supportedReasoningEfforts: model.supportedReasoningEfforts ?? [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    deprecationNotice: model.deprecationNotice ?? null,
    metadata: {
      ...(provider === null
        ? {}
        : {
            openCodeProviderId: provider,
            openCodeProviderLabel: traycerProviderLabel(provider),
          }),
      ...(model.supportsImages === true
        ? { supportsImages: true, inputModalities: ["text", "image"] }
        : {}),
    },
  };
}

/**
 * `GET /api/traycer/models`: the cloud's Traycer Inference catalog, for a
 * sandbox's model picker - the person's own host may have Traycer off, and a
 * sandbox's host answers nothing while it rests. No `nativeProviders` is
 * sent, so the server lists only the models every host runs, and every row
 * runs on a sandbox. A row this build cannot read is left out; a body that is
 * not a list is a contract failure.
 */
export async function fetchTraycerModelsViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
): Promise<TraycerModelsFetchResult> {
  const base = serverBaseUrl.endsWith("/")
    ? serverBaseUrl
    : `${serverBaseUrl}/`;
  const raw = await call(
    new URL("api/traycer/models", base).toString(),
    { method: "GET", body: null, timeoutMs: SANDBOX_CONTROL_FETCH_TIMEOUT_MS },
    bearerToken,
    proxyToken,
  );
  if (raw.kind === "network-error") return raw;
  if (!isSuccess(raw.status)) return failureOf(raw.status, raw.body);
  if (!Array.isArray(raw.body)) {
    return {
      kind: "network-error",
      detail: "the Traycer model catalog did not match the contract",
    };
  }
  const models: GuiAgentModelOption[] = [];
  for (const entry of raw.body) {
    const parsed = traycerCatalogModelSchema.safeParse(entry);
    if (parsed.success) models.push(traycerModelOption(parsed.data));
  }
  return { kind: "ok", models };
}

/**
 * `GET /api/sandboxes/cost`: every listed sandbox's cost from the control
 * plane's ledger, and the user's awake burn.
 */
export async function fetchSandboxCostsViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
): Promise<SandboxCostsFetchResult> {
  const raw = await call(
    sandboxesUrl(serverBaseUrl, "/cost"),
    { method: "GET", body: null, timeoutMs: SANDBOX_CONTROL_FETCH_TIMEOUT_MS },
    bearerToken,
    proxyToken,
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

/** An Automations read from a server that serves no Automations route. */
const AUTOMATION_NOT_SERVED: SandboxAutomationResponse = {
  available: false,
  sandbox: null,
  pods: [],
};

/**
 * `GET /api/sandboxes/automation`: the user's Automations host. Any `404` is
 * "not offered here", never a failure: a server from before the route
 * answers one (its `GET /:id` reads `automation` as a sandbox id and answers
 * `sandbox_not_found`, or no route matches at all).
 */
export async function getSandboxAutomationViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  /** A team's environment, for its pods; `null` reads the caller's own. */
  environmentId: string | null,
): Promise<SandboxAutomationFetchResult> {
  const url = new URL(sandboxesUrl(serverBaseUrl, "/automation"));
  if (environmentId !== null) {
    url.searchParams.set("environmentId", environmentId);
  }
  const raw = await call(
    url.toString(),
    { method: "GET", body: null, timeoutMs: SANDBOX_CONTROL_FETCH_TIMEOUT_MS },
    bearerToken,
    proxyToken,
  );
  if (raw.kind === "network-error") return raw;
  if (raw.status === 404) {
    return { kind: "ok", automation: AUTOMATION_NOT_SERVED };
  }
  if (!isSuccess(raw.status)) return failureOf(raw.status, raw.body);
  const parsed = sandboxAutomationResponseSchema.safeParse(raw.body);
  if (!parsed.success) {
    return {
      kind: "network-error",
      detail: "the Automations read did not match the contract",
    };
  }
  return { kind: "ok", automation: parsed.data };
}

/**
 * `POST /api/sandboxes/automation`: creates the row on first use, wakes a
 * released one. Runs on the server's 360 s `transfer` tier, so it waits as
 * long as a create.
 */
export async function openSandboxAutomationViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  /**
   * A team's pod to open; `null` opens the caller's own Automations host with
   * no body, as before.
   */
  target: SandboxAutomationOpenTarget | null,
): Promise<SandboxAutomationOpenFetchResult> {
  const raw = await call(
    sandboxesUrl(serverBaseUrl, "/automation"),
    {
      method: "POST",
      body:
        target === null
          ? null
          : JSON.stringify({
              environmentId: target.environmentId,
              ordinal: target.ordinal,
            }),
      timeoutMs: SANDBOX_CREATE_FETCH_TIMEOUT_MS,
    },
    bearerToken,
    proxyToken,
  );
  if (raw.kind === "network-error") return raw;
  if (!isSuccess(raw.status)) return failureOf(raw.status, raw.body);
  const parsed = sandboxAutomationOpenResponseSchema.safeParse(raw.body);
  if (!parsed.success) {
    return {
      kind: "network-error",
      detail: "the Automations open answer did not match the contract",
    };
  }
  return {
    kind: "ok",
    sandbox: parsed.data.sandbox,
    settled: raw.status !== 202,
  };
}

/** `POST /api/sandboxes`: `202` with the sandbox and host ids. */
export async function createSandboxViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
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
    proxyToken,
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
 * gone, which the caller decides how to read. `onlyIfIdle` asks the server
 * to refuse unless its state CAS still starts from suspended or stopped.
 */
export async function destroySandboxViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  sandboxId: string,
  onlyIfIdle: boolean,
): Promise<SandboxVerbFetchResult> {
  if (!SANDBOX_ID_PATTERN.test(sandboxId)) return INVALID_SANDBOX_ID;
  const raw = await call(
    sandboxesUrl(
      serverBaseUrl,
      `/${sandboxId}${onlyIfIdle ? "?onlyIfIdle=true" : ""}`,
    ),
    {
      method: "DELETE",
      body: null,
      timeoutMs: SANDBOX_DESTROY_FETCH_TIMEOUT_MS,
    },
    bearerToken,
    proxyToken,
  );
  if (raw.kind === "network-error") return raw;
  if (!isSuccess(raw.status)) return failureOf(raw.status, raw.body);
  return { kind: "ok", settled: raw.status !== 202 };
}

/**
 * `PATCH /api/sandboxes/:id`: rename the row and change its idle and resting
 * periods (each `null` in `request` leaves that setting as it is). The answer's
 * row is not read: the sandbox list is what every surface renders from.
 */
export async function patchSandboxViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  sandboxId: string,
  request: SandboxPatchRequest,
): Promise<SandboxVerbFetchResult> {
  if (!SANDBOX_ID_PATTERN.test(sandboxId)) return INVALID_SANDBOX_ID;
  const raw = await call(
    sandboxesUrl(serverBaseUrl, `/${sandboxId}`),
    {
      method: "PATCH",
      body: JSON.stringify(request),
      timeoutMs: SANDBOX_CONTROL_FETCH_TIMEOUT_MS,
    },
    bearerToken,
    proxyToken,
  );
  if (raw.kind === "network-error") return raw;
  if (!isSuccess(raw.status)) return failureOf(raw.status, raw.body);
  return { kind: "ok", settled: raw.status !== 202 };
}

/**
 * `POST /api/sandboxes/:id/keep`: turn a sandbox an agent created into one
 * that waits for its owner. `404 sandbox_not_found` when the row is already
 * destroyed, including one its idle timer destroyed while the keep was on its
 * way.
 */
export async function keepSandboxViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  sandboxId: string,
): Promise<SandboxVerbFetchResult> {
  if (!SANDBOX_ID_PATTERN.test(sandboxId)) return INVALID_SANDBOX_ID;
  const raw = await call(
    sandboxesUrl(serverBaseUrl, `/${sandboxId}/keep`),
    {
      method: "POST",
      body: null,
      timeoutMs: SANDBOX_CONTROL_FETCH_TIMEOUT_MS,
    },
    bearerToken,
    proxyToken,
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
 *
 * `gesture` is what the verb came from when it was not its own menu item
 * (Open terminal, Send, Open files), recorded on the operation it starts;
 * `null` sends no body.
 */
export async function runSandboxVerbViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  sandboxId: string,
  verb: SandboxLifecycleVerb,
  gesture: SandboxVerbGesture | null,
  timeoutMs: number,
): Promise<SandboxLifecycleVerbFetchResult> {
  if (!SANDBOX_ID_PATTERN.test(sandboxId)) return INVALID_SANDBOX_ID;
  const raw = await call(
    sandboxesUrl(serverBaseUrl, `/${sandboxId}/${verb}`),
    {
      method: "POST",
      body: gesture === null ? null : JSON.stringify({ gesture }),
      timeoutMs: Math.min(
        Math.max(timeoutMs, 0),
        SANDBOX_VERB_FETCH_TIMEOUT_MS,
      ),
    },
    bearerToken,
    proxyToken,
  );
  if (raw.kind === "network-error") return raw;
  if (!isSuccess(raw.status)) return failureOf(raw.status, raw.body);
  const parsed = sandboxLifecycleVerbResponseSchema.safeParse(raw.body);
  return {
    kind: "ok",
    settled: raw.status !== 202,
    state: parsed.success ? parsed.data.sandbox.state : null,
  };
}

// -----------------------------------------------------------------------------
// Wake before dial
// -----------------------------------------------------------------------------

/**
 * States a sandbox does not come back from: its disk is gone or going.
 * `released` is not one: the Automations row's idle state keeps its disk, and
 * a `start` brings it back.
 */
const SANDBOX_TERMINAL_STATES: ReadonlySet<HostSandboxState> = new Set([
  "destroying",
  "destroyed",
  "failed",
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
 *  - `not-wakeable`       — the sandbox is destroyed or failed.
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
      readonly creditSource?: SandboxCreditSource | null;
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
 * Why a STAGING mobile build offers no sandbox surfaces
 * (`IRunnerHost.sandboxControlUnavailableReason`). Staging's traycer-server,
 * which serves the sandbox control plane, is fronted by Google IAP, and a
 * call that carries the user's bearer alone is refused before it reaches the
 * server. Only the desktop's main process holds an IAP credential (see
 * {@link call}); a WebView cannot send one.
 */
export const SANDBOXES_UNAVAILABLE_IN_STAGING =
  "Sandboxes aren't available in staging builds.";

export const SANDBOX_FROZEN_MESSAGE =
  "This sandbox is paused because your credits ran out. Add credits to wake it.";

/**
 * Wakes a sandbox before a tab dials it: resume a suspended (or suspending)
 * one, start a stopped (or stopping) or released one, then wait until the
 * host list says `awake`. Called at tab open only, never from a session's
 * reconnect loop -
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
      return { kind: "not-wakeable", state: facts.state };
    case "released":
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
 * Whether a sandbox in this state is asleep: suspended, stopped or released,
 * or on its way there. A wake (a tab open, a pick in a host picker) brings it
 * back.
 */
export function isSandboxAsleep(state: HostSandboxState | null): boolean {
  return wakeVerbFor(state) !== null;
}

/**
 * The verb that wakes a sandbox from this state, or `null` when the control
 * plane is already bringing it up (a wake arriving mid-suspend is resumed by
 * the server once the suspend lands, so `suspending` takes `resume` too).
 */
export function wakeVerbFor(
  state: HostSandboxState | null,
): SandboxWakeVerb | null {
  switch (state) {
    case "suspending":
    case "suspended":
      return "resume";
    case "stopping":
    case "stopped":
    // The Automations row: its `start` is the open (scale to one, wait for
    // the pod to enrol).
    case "released":
      return "start";
    case "creating":
    case "resuming":
    case "starting":
    case "awake":
    case "destroying":
    case "destroyed":
    case "failed":
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
      creditSource: failure.creditSource ?? null,
      burnMcPerHour: failure.currentAwakeBurnMcPerHour,
    };
  }
  return {
    kind: "failed",
    detail: `the control plane refused the wake (${failure.code})`,
  };
}
