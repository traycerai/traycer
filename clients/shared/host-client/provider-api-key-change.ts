import { settingsSaveRequestId } from "@traycer/protocol/framework/settings-save-request-id";
import type { HostRpcRegistry } from "@traycer/protocol/host/registry";
import { z } from "zod";
import type {
  ProvidersSetApiKeyResponse,
  ProvidersBeginApiKeyChangeResponse,
  ProviderId,
  ProvidersSettleApiKeyChangeResponse,
  ProvidersSettleApiKeyChangeRequest,
} from "@traycer/protocol/host/provider-schemas";
import type { HostRequester, HostRequestDispatchOptions } from "./host-client";
import { HostRpcError } from "../host-transport/host-messenger";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import { isRedirectAnswer } from "../auth/redirect-answer";
import { PATH_ID_PATTERN } from "./path-id";
type ProviderApiKeyChangeHost = Pick<
  HostRequester<HostRpcRegistry>,
  "request" | "requestWithOptions" | "getRequestContext"
>;
export interface ProviderApiKeyChangeOutcome {
  readonly response: ProvidersSetApiKeyResponse;
  readonly result: ProvidersSettleApiKeyChangeResponse["result"] | null;
}

/** Client-only completion data; the released host mutation responses stay unchanged. */
export interface ProviderApiKeyChangeResponse extends ProvidersSetApiKeyResponse {
  readonly keyChangeResult:
    | ProvidersSettleApiKeyChangeResponse["result"]
    | null;
}

/** A team page cannot send a key after its computer changes environments. */
export class ProviderApiKeyEnvironmentChangedError extends HostRpcError {
  constructor(action: "set" | "clear") {
    super({
      code: "RPC_ERROR",
      requestId: "provider-key-change",
      method:
        action === "set" ? "providers.setApiKey" : "providers.clearApiKey",
      message: "Provider key change failed",
      fatalDetails: null,
    });
  }
}

/** The key travels to the computer only on the released legacy path. */
export async function changeProviderApiKey(
  host: ProviderApiKeyChangeHost,
  records: ProviderKeyRecordClient,
  providerId: ProviderId,
  change: ProviderApiKeyHostChange,
  expectedEnvironmentId: string | null,
  origin: "account-save" | undefined,
): Promise<ProviderApiKeyChangeOutcome> {
  if ("usePersonal" in change) {
    return {
      response: await host.request("providers.clearKeptApiKey", { providerId }),
      result: null,
    };
  }
  if ("intent" in change) {
    if (change.intent === "keep") {
      return {
        response: await host.request("providers.setKeptApiKey", {
          providerId,
          apiKey: change.apiKey,
        }),
        result: null,
      };
    }
    if (change.environmentId === null) {
      throw new ProviderApiKeyEnvironmentChangedError(change.action);
    }
  }
  const shareEnvironmentId = "intent" in change ? change.environmentId : null;
  const requiredEnvironmentId = shareEnvironmentId ?? expectedEnvironmentId;
  const supportsRecords = isProviderKeyProviderId(providerId);
  const context = supportsRecords ? host.getRequestContext() : null;
  const options: HostRequestDispatchOptions | null =
    origin === "account-save" &&
    change.action === "set" &&
    requiredEnvironmentId === null &&
    context?.cloudAuthorized === true &&
    !context.abortSignal.aborted
      ? {
          requestId: settingsSaveRequestId(crypto.randomUUID()),
          idempotencyKey: null,
          responseTimeoutMs: null,
          requiredHostMethodVersion: null,
          signal: context.abortSignal,
        }
      : null;
  const legacy = async (): Promise<ProviderApiKeyChangeOutcome> => {
    if (change.action === "clear")
      return {
        response: await host.request("providers.clearApiKey", { providerId }),
        result: null,
      };
    const params = { providerId, apiKey: change.apiKey };
    return {
      response:
        options === null
          ? await host.request("providers.setApiKey", params)
          : await host.requestWithOptions(
              "providers.setApiKey",
              params,
              options,
            ),
      result: null,
    };
  };
  if (!supportsRecords) {
    if (requiredEnvironmentId !== null)
      throw new ProviderApiKeyEnvironmentChangedError(change.action);
    return legacy();
  }
  let begin: ProvidersBeginApiKeyChangeResponse;
  try {
    const params = { providerId };
    begin =
      options === null
        ? await host.request("providers.beginApiKeyChange", params)
        : await host.requestWithOptions(
            "providers.beginApiKeyChange",
            params,
            options,
          );
  } catch (error) {
    if (error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED") {
      if (requiredEnvironmentId !== null)
        throw new ProviderApiKeyEnvironmentChangedError(change.action);
      return legacy();
    }
    throw error;
  }
  if (
    requiredEnvironmentId !== null &&
    (begin.mode === "legacy" || begin.environmentId !== requiredEnvironmentId)
  ) {
    throw new ProviderApiKeyEnvironmentChangedError(change.action);
  }
  if (begin.mode === "legacy") return legacy();
  const method =
    change.action === "set" ? "providers.setApiKey" : "providers.clearApiKey";
  if (
    context === null ||
    context.abortSignal.aborted ||
    !context.cloudAuthorized ||
    host.getRequestContext() !== context
  ) {
    throw changeRefusal(method, "UNAUTHORIZED");
  }
  const accepted = await records.changeProviderKeyRecord(
    begin.environmentId,
    providerId,
    change.action === "set" ? { action: "set", apiKey: change.apiKey } : change,
    context.abortSignal,
  );
  if (
    host.getRequestContext() !== context ||
    context.abortSignal.aborted ||
    !context.cloudAuthorized
  ) {
    throw changeRefusal(method, "UNAUTHORIZED");
  }
  if (accepted.kind === "legacy") {
    if (shareEnvironmentId !== null) throw changeRefusal(method, "RPC_ERROR");
    return legacy();
  }
  if (accepted.kind === "refused") throw changeRefusal(method, accepted.code);
  const common = { providerId, changeToken: begin.changeToken };
  let request: ProvidersSettleApiKeyChangeRequest;
  if (accepted.kind === "record") {
    request = {
      ...common,
      action: change.action,
      recordId: accepted.record.profileId,
      signInNumber: accepted.record.signInNumber,
      recordRevision: accepted.record.recordRevision,
    };
  } else if (change.action === "clear") {
    request = {
      ...common,
      action: "clear",
      recordId: null,
      signInNumber: null,
      recordRevision: null,
    };
  } else {
    throw changeRefusal(method, "RPC_ERROR");
  }
  const settled = await host.request("providers.settleApiKeyChange", request);
  return { response: { state: settled.state }, result: settled.result };
}

function changeRefusal(
  method: string,
  code: "UNAUTHORIZED" | "FORBIDDEN" | "RPC_ERROR",
): HostRpcError {
  return new HostRpcError({
    code,
    requestId: "provider-key-change",
    method,
    message: "Provider key change failed",
    fatalDetails: null,
  });
}

const providerKeyProviderIdSchema = z.enum([
  "cursor",
  "openrouter",
  "huggingface",
  "amp",
  "kiro",
  "droid",
]);
export type ProviderKeyProviderId = z.infer<typeof providerKeyProviderIdSchema>;

export type ProviderApiKeyChange =
  | { readonly action: "set"; readonly apiKey: string }
  | { readonly action: "clear" };

export type ProviderApiKeyHostChange =
  | ProviderApiKeyChange
  | { readonly action: "clear"; readonly usePersonal: true }
  | { readonly action: "set"; readonly apiKey: string; readonly intent: "keep" }
  | {
      readonly action: "set";
      readonly apiKey: string;
      readonly intent: "share";
      readonly environmentId: string | null;
    };

const revisionSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const recordSchema = z.strictObject({
  profileId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  providerId: providerKeyProviderIdSchema,
  state: z.enum(["live", "removed"]),
  signInNumber: revisionSchema,
  recordRevision: revisionSchema,
  personIntentNumber: revisionSchema,
});
type ProviderKeyRecord = z.infer<typeof recordSchema>;

export type ProviderKeyRecordChangeResult =
  | { readonly kind: "record"; readonly record: ProviderKeyRecord }
  | { readonly kind: "absent" }
  | { readonly kind: "legacy" }
  | {
      readonly kind: "refused";
      readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "RPC_ERROR";
    };

export interface ProviderKeyRecordClient {
  changeProviderKeyRecord(
    environmentId: string,
    providerId: ProviderKeyProviderId,
    change: ProviderApiKeyChange,
    callerSignal: AbortSignal | null,
  ): Promise<ProviderKeyRecordChangeResult>;
}

/** The broker's error body is used only to distinguish absence from an older server. */
const codedBodySchema = z.object({ code: z.string() });
const keySchema = z.string().regex(/^[\x21-\x7e]{1,4096}$/);

export function isProviderKeyRecordDraft(value: string): boolean {
  return keySchema.safeParse(value).success;
}

export function isProviderKeyProviderId(
  providerId: string,
): providerId is ProviderKeyProviderId {
  return providerKeyProviderIdSchema.safeParse(providerId).success;
}

/** Nothing is queued or retried. */
export async function changeProviderKeyRecordViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
  providerId: ProviderKeyProviderId,
  change: ProviderApiKeyChange,
  callerSignal: AbortSignal | null,
): Promise<ProviderKeyRecordChangeResult> {
  if (
    !PATH_ID_PATTERN.test(environmentId) ||
    (change.action === "set" && !isProviderKeyRecordDraft(change.apiKey))
  ) {
    return { kind: "refused", code: "RPC_ERROR" };
  }
  const abort = composeRequestAbort(callerSignal, 15_000);
  try {
    const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
    const url = new URL(
      `api/v3/environments/${encodeURIComponent(environmentId)}/provider-keys/${providerId}`,
      base,
    );
    const response = await untilAborted(
      fetch(url, {
        method: change.action === "set" ? "PUT" : "DELETE",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Accept: "application/json",
          // authn refuses a DELETE that declares a JSON body and has none (FST_ERR_CTP_EMPTY_JSON_BODY).
          ...(change.action === "set"
            ? { "Content-Type": "application/json" }
            : {}),
        },
        body:
          change.action === "set"
            ? JSON.stringify({ key: change.apiKey, onlyIfAbsent: false })
            : null,
        redirect: "manual",
        signal: abort.signal,
      }),
      abort.signal,
    );
    if (isRedirectAnswer(response.status)) {
      return { kind: "refused", code: "RPC_ERROR" };
    }
    if (response.status === 401)
      return { kind: "refused", code: "UNAUTHORIZED" };
    if (response.status === 403) return { kind: "refused", code: "FORBIDDEN" };
    const text = await untilAborted(response.text(), abort.signal);
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* An older server may answer with an empty or non-JSON body. */
    }
    if (response.status === 404) {
      const coded = codedBodySchema.safeParse(body);
      if (!coded.success) return { kind: "legacy" };
      if (
        change.action === "clear" &&
        coded.data.code === "profile_record_not_found"
      ) {
        return { kind: "absent" };
      }
      return { kind: "refused", code: "RPC_ERROR" };
    }
    if (response.status !== 200) return { kind: "refused", code: "RPC_ERROR" };
    const record = recordSchema.safeParse(body);
    if (
      !record.success ||
      record.data.providerId !== providerId ||
      record.data.state !== (change.action === "set" ? "live" : "removed")
    ) {
      return { kind: "refused", code: "RPC_ERROR" };
    }
    return { kind: "record", record: record.data };
  } catch {
    return { kind: "refused", code: "RPC_ERROR" };
  } finally {
    abort.clear();
  }
}
