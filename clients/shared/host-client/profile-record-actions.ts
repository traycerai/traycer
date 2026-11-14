import { z } from "zod";
import {
  TUI_HARNESS_ID_TO_PROVIDER_ID,
  providerProfileAccentColorSchema,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import { PATH_ID_PATTERN } from "./path-id";

export type ProfileRecordFailureKind =
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "ambiguous"
  | "invalid"
  | "failed";

export interface ProfileRecordFailure {
  readonly kind: ProfileRecordFailureKind;
}

export type ProfileRecordAction = "sign-out" | "remove" | "name";

/** Coded role refusals keep their existing copy; all other refusals use the action's fallback. */
export const PROFILE_RECORD_FAILURE_COPY = {
  unauthorized: "Please sign in again.",
  forbidden: "You don't have permission to do that.",
  action: {
    "sign-out": "Couldn't sign out.",
    remove: "Couldn't remove profile.",
    name: "Couldn't rename profile.",
  },
} as const;

export interface ProfileRecordActionFailure extends ProfileRecordFailure {
  readonly message:
    | typeof PROFILE_RECORD_FAILURE_COPY.unauthorized
    | typeof PROFILE_RECORD_FAILURE_COPY.forbidden
    | (typeof PROFILE_RECORD_FAILURE_COPY.action)[ProfileRecordAction];
}

export function profileRecordActionFailure(
  action: ProfileRecordAction,
  kind: ProfileRecordFailureKind,
): ProfileRecordActionFailure {
  return {
    kind,
    message:
      kind === "unauthorized" || kind === "forbidden"
        ? PROFILE_RECORD_FAILURE_COPY[kind]
        : PROFILE_RECORD_FAILURE_COPY.action[action],
  };
}

export interface EnvironmentProfileRecords {
  readonly profileSyncEnabled: boolean;
  readonly providers: readonly {
    readonly providerId: string;
    readonly profiles: readonly ProviderProfile[];
  }[];
}

export type ProfileRecordListResult =
  | { readonly kind: "ok"; readonly list: EnvironmentProfileRecords }
  | ProfileRecordFailure;
export type ProfileRecordActionResult =
  | { readonly kind: "ok" }
  | ProfileRecordActionFailure;
export type ProfileRecordNameResult =
  | { readonly kind: "ok"; readonly name: string }
  | ProfileRecordActionFailure;

/** Implemented by AuthService; a caller never supplies or receives a bearer. */
export interface ProfileRecordClient {
  readProfileRecords(
    environmentId: string,
    callerSignal: AbortSignal | null,
  ): Promise<ProfileRecordListResult>;
  signOutProfileRecord(
    environmentId: string,
    providerId: string,
    profileId: string,
    callerSignal: AbortSignal | null,
  ): Promise<ProfileRecordActionResult>;
  removeProfileRecord(
    environmentId: string,
    providerId: string,
    profileId: string,
    callerSignal: AbortSignal | null,
  ): Promise<ProfileRecordActionResult>;
  nameProfileRecord(
    environmentId: string,
    providerId: string,
    profileId: string,
    name: string,
    callerSignal: AbortSignal | null,
  ): Promise<ProfileRecordNameResult>;
}

const profileIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const revisionSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const recordSchema = z.object({
  profileId: profileIdSchema,
  harnessId: z.string().min(1),
  name: z.string().min(1).max(64),
  color: z.string().nullable(),
  enabled: z.boolean(),
  kind: z.string().nullable(),
  readerLabel: z.enum(["live", "waiting", "needs-sign-in"]),
  otherNames: z.array(z.string()),
});
const listSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), records: z.array(recordSchema) }),
]);
const actionSchema = z.object({
  profileId: profileIdSchema,
  harnessId: z.string().min(1),
  recordRevision: revisionSchema,
});
const namedSchema = actionSchema.extend({ name: z.string().min(1).max(64) });
const codedBodySchema = z.object({ code: z.string() });

interface RecordAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** One direct app-session call. Neither a transport exception nor server text escapes. */
async function callRecord(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
  suffix: string,
  body:
    | { readonly harnessId: string }
    | { readonly harnessId: string; readonly name: string }
    | null,
  callerSignal: AbortSignal | null,
): Promise<RecordAnswer | null> {
  if (!PATH_ID_PATTERN.test(environmentId)) return null;
  const abort = composeRequestAbort(callerSignal, 15_000);
  try {
    const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
    const url = new URL(
      `api/v3/environments/${encodeURIComponent(environmentId)}/profile-records${suffix}`,
      base,
    );
    const response = await untilAborted(
      fetch(url, {
        method: body === null ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: body === null ? null : JSON.stringify(body),
        redirect: "error",
        signal: abort.signal,
      }),
      abort.signal,
    );
    if (response.status === 401 || response.status === 403)
      return { status: response.status, body: null };
    const text = await untilAborted(response.text(), abort.signal);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Status-only refusals remain meaningful without a JSON body.
    }
    return { status: response.status, body: parsed };
  } catch {
    return null;
  } finally {
    abort.clear();
  }
}

function failureKind(answer: RecordAnswer | null): ProfileRecordFailureKind {
  if (answer === null) return "failed";
  if (answer.status === 401) return "unauthorized";
  if (answer.status === 403) return "forbidden";
  const coded = codedBodySchema.safeParse(answer.body);
  if (!coded.success) return "failed";
  if (
    answer.status === 404 &&
    (coded.data.code === "profile_record_not_found" ||
      coded.data.code === "environment_not_found")
  )
    return "not-found";
  if (
    answer.status === 409 &&
    coded.data.code === "profile_record_alias_ambiguous"
  )
    return "ambiguous";
  if (
    answer.status === 400 &&
    coded.data.code === "profile_record_action_invalid"
  )
    return "invalid";
  return "failed";
}

function harnessOf(providerId: string): string {
  return (
    Object.entries(TUI_HARNESS_ID_TO_PROVIDER_ID).find(
      ([, provider]) => provider === providerId,
    )?.[0] ?? providerId
  );
}

/** Standing is computed by the broker, never against the app's clock. */
export async function readProfileRecordsViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
  callerSignal: AbortSignal | null,
): Promise<ProfileRecordListResult> {
  const answer = await callRecord(
    authnBaseUrl,
    bearerToken,
    environmentId,
    "",
    null,
    callerSignal,
  );
  if (answer?.status !== 200) return { kind: failureKind(answer) };
  const parsed = listSchema.safeParse(answer.body);
  if (!parsed.success) return { kind: "failed" };
  if (!parsed.data.enabled)
    return { kind: "ok", list: { profileSyncEnabled: false, providers: [] } };
  const groups = new Map<string, ProviderProfile[]>();
  for (const record of parsed.data.records) {
    const providerId =
      Object.entries(TUI_HARNESS_ID_TO_PROVIDER_ID).find(
        ([harness]) => harness === record.harnessId,
      )?.[1] ?? record.harnessId;
    const profiles = groups.get(providerId) ?? [];
    const color = providerProfileAccentColorSchema.safeParse(record.color);
    profiles.push({
      profileId: record.profileId,
      kind: "managed",
      label: record.name,
      accentColor: color.success ? color.data : null,
      enabled: record.enabled,
      authType: "oauth",
      auth: {
        status:
          record.readerLabel === "needs-sign-in"
            ? "unauthenticated"
            : "authenticated",
        badgeText: null,
        label: null,
        detail: null,
      },
      identity: null,
      usageUpdatedAt: null,
      rateLimitStatus: "unknown",
      rateLimitLimitedScopes: null,
      duplicateOfProfileId: null,
      ambientDriftNotice: null,
      personNotice: record.readerLabel === "live" ? null : record.readerLabel,
      otherNames: record.otherNames,
      ...(record.kind === "api_key"
        ? { apiKey: { supported: false, configured: true } }
        : {}),
    });
    groups.set(providerId, profiles);
  }
  return {
    kind: "ok",
    list: {
      profileSyncEnabled: true,
      providers: [...groups].map(([providerId, profiles]) => ({
        providerId,
        profiles,
      })),
    },
  };
}

export async function signOutProfileRecordViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
  providerId: string,
  profileId: string,
  callerSignal: AbortSignal | null,
): Promise<ProfileRecordActionResult> {
  const answer = await writeRecord(
    authnBaseUrl,
    bearerToken,
    environmentId,
    providerId,
    profileId,
    "sign-out",
    null,
    callerSignal,
  );
  return actionResult("sign-out", answer, providerId, profileId);
}

export async function removeProfileRecordViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
  providerId: string,
  profileId: string,
  callerSignal: AbortSignal | null,
): Promise<ProfileRecordActionResult> {
  const answer = await writeRecord(
    authnBaseUrl,
    bearerToken,
    environmentId,
    providerId,
    profileId,
    "remove",
    null,
    callerSignal,
  );
  return actionResult("remove", answer, providerId, profileId);
}

export async function nameProfileRecordViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
  providerId: string,
  profileId: string,
  name: string,
  callerSignal: AbortSignal | null,
): Promise<ProfileRecordNameResult> {
  const answer = await writeRecord(
    authnBaseUrl,
    bearerToken,
    environmentId,
    providerId,
    profileId,
    "name",
    name,
    callerSignal,
  );
  if (answer?.status !== 200)
    return profileRecordActionFailure("name", failureKind(answer));
  const parsed = namedSchema.safeParse(answer.body);
  if (
    !parsed.success ||
    parsed.data.profileId !== profileId ||
    parsed.data.harnessId !== harnessOf(providerId)
  )
    return profileRecordActionFailure("name", "failed");
  return { kind: "ok", name: parsed.data.name };
}

function actionResult(
  action: "sign-out" | "remove",
  answer: RecordAnswer | null,
  providerId: string,
  profileId: string,
): ProfileRecordActionResult {
  if (answer?.status !== 200)
    return profileRecordActionFailure(action, failureKind(answer));
  const parsed = actionSchema.safeParse(answer.body);
  if (
    !parsed.success ||
    parsed.data.profileId !== profileId ||
    parsed.data.harnessId !== harnessOf(providerId)
  )
    return profileRecordActionFailure(action, "failed");
  return { kind: "ok" };
}

async function writeRecord(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
  providerId: string,
  profileId: string,
  action: ProfileRecordAction,
  name: string | null,
  callerSignal: AbortSignal | null,
): Promise<RecordAnswer | null> {
  if (!profileIdSchema.safeParse(profileId).success) return null;
  const harnessId = harnessOf(providerId);
  return callRecord(
    authnBaseUrl,
    bearerToken,
    environmentId,
    `/${encodeURIComponent(profileId)}/${action}`,
    name === null ? { harnessId } : { harnessId, name },
    callerSignal,
  );
}
