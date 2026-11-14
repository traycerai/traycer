import type { HostRpcRegistry } from "@traycer/protocol/host/registry";
import { z } from "zod";
import type {
  ProvidersSetApiKeyResponse,
  ProvidersBeginApiKeyChangeResponse,
  ProviderId,
  ProvidersSettleApiKeyChangeResponse,
  ProvidersSettleApiKeyChangeRequest,
} from "@traycer/protocol/host/provider-schemas";
import type { HostRequester } from "./host-client";
import { HostRpcError } from "../host-transport/host-messenger";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import { PATH_ID_PATTERN } from "./path-id";
type ProviderApiKeyChangeHost = Pick<
  HostRequester<HostRpcRegistry>,
  "request" | "getRequestContext"
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

/** The key travels to the computer only on the released legacy path. */
export async function changeProviderApiKey(
  host: ProviderApiKeyChangeHost,
  records: ProviderKeyRecordClient,
  providerId: ProviderId,
  change: ProviderApiKeyChange,
): Promise<ProviderApiKeyChangeOutcome> {
  const legacy = async (): Promise<ProviderApiKeyChangeOutcome> => ({
    response:
      change.action === "set"
        ? await host.request("providers.setApiKey", {
            providerId,
            apiKey: change.apiKey,
          })
        : await host.request("providers.clearApiKey", { providerId }),
    result: null,
  });
  if (!isProviderKeyProviderId(providerId)) return legacy();
  const context = host.getRequestContext();
  let begin: ProvidersBeginApiKeyChangeResponse;
  try {
    begin = await host.request("providers.beginApiKeyChange", { providerId });
  } catch (error) {
    if (error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED")
      return legacy();
    throw error;
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
    change,
    context.abortSignal,
  );
  if (
    host.getRequestContext() !== context ||
    context.abortSignal.aborted ||
    !context.cloudAuthorized
  ) {
    throw changeRefusal(method, "UNAUTHORIZED");
  }
  if (accepted.kind === "legacy") return legacy();
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

function isProviderKeyProviderId(
  providerId: string,
): providerId is ProviderKeyProviderId {
  return providerKeyProviderIdSchema.safeParse(providerId).success;
}

/** A single direct request on the person's session. Nothing is queued or retried. */
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
    (change.action === "set" && !keySchema.safeParse(change.apiKey).success)
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
          "Content-Type": "application/json",
        },
        body:
          change.action === "set"
            ? JSON.stringify({ key: change.apiKey, onlyIfAbsent: false })
            : null,
        redirect: "error",
        signal: abort.signal,
      }),
      abort.signal,
    );
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
