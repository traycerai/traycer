import { z } from "zod";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import { PATH_ID_PATTERN } from "./path-id";

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

export function isProviderKeyProviderId(
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
