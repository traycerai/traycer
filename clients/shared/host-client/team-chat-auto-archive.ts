import { z } from "zod";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import type { EnvironmentTransport } from "../environment/environment-cloud";

/**
 * A team's chat auto-archive setting on traycer-server, on a person's sign-in:
 * `GET` and `PUT /api/traycer/chat-auto-archive/teams/:teamId`. Any seat that
 * reads the team's environment reads it, a Viewer included; an Admin or an
 * Editor writes it, last write wins. A Viewer's write, and anyone's read or
 * write outside the team, is a plain 403 with no sentence of its own.
 */
function teamChatAutoArchivePath(teamId: string): string {
  return `api/traycer/chat-auto-archive/teams/${encodeURIComponent(teamId)}`;
}

/** The idle threshold the route takes, in seconds, both ends included. */
export const TEAM_CHAT_AUTO_ARCHIVE_IDLE_SECONDS = {
  minSeconds: 1,
  maxSeconds: 31_536_000,
} as const;

const TEAM_CHAT_AUTO_ARCHIVE_FETCH_TIMEOUT_MS = 10_000;

const teamChatAutoArchiveRecordSchema = z.object({
  enabled: z.boolean(),
  includeUserCreated: z.boolean(),
  idleSeconds: z.number().int().positive(),
  /** Epoch milliseconds of the last accepted write. */
  updatedAt: z.number(),
});

export type TeamChatAutoArchiveRecord = z.infer<
  typeof teamChatAutoArchiveRecordSchema
>;

export interface TeamChatAutoArchiveSetRequest {
  readonly enabled: boolean;
  readonly includeUserCreated: boolean;
  readonly idleSeconds: number;
}

const teamChatAutoArchiveSetRequestSchema = z.strictObject({
  enabled: z.boolean(),
  includeUserCreated: z.boolean(),
  idleSeconds: z
    .number()
    .int()
    .min(TEAM_CHAT_AUTO_ARCHIVE_IDLE_SECONDS.minSeconds)
    .max(TEAM_CHAT_AUTO_ARCHIVE_IDLE_SECONDS.maxSeconds),
});

/** A write the route takes, or null: a threshold outside it is never sent. */
export function parseTeamChatAutoArchiveSetRequest(
  value: unknown,
): TeamChatAutoArchiveSetRequest | null {
  const parsed = teamChatAutoArchiveSetRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

type TeamChatAutoArchiveFailure =
  | { readonly kind: "unauthorized" }
  /** A Viewer's write, or a person outside the team. */
  | { readonly kind: "forbidden" }
  | { readonly kind: "failed" };

export type TeamChatAutoArchiveReadResult =
  /** `record` is null when the team never saved one: off, as today. */
  | { readonly kind: "ok"; readonly record: TeamChatAutoArchiveRecord | null }
  | TeamChatAutoArchiveFailure;

export type TeamChatAutoArchiveWriteResult =
  | { readonly kind: "ok"; readonly record: TeamChatAutoArchiveRecord }
  | TeamChatAutoArchiveFailure;

type Answer =
  | {
      readonly kind: "answered";
      readonly status: number;
      readonly text: string | null;
    }
  | { readonly kind: "failed" };

/** Sent once through the shell's transport, which never follows a redirect. */
async function send(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  transport: EnvironmentTransport,
  teamId: string,
  write: TeamChatAutoArchiveSetRequest | null,
): Promise<Answer> {
  const base = serverBaseUrl.endsWith("/")
    ? serverBaseUrl
    : `${serverBaseUrl}/`;
  const headers: Record<string, string> =
    proxyToken === null
      ? {}
      : { "Proxy-Authorization": `Bearer ${proxyToken}` };
  headers.Authorization = `Bearer ${bearerToken}`;
  headers.Accept = "application/json";
  if (write !== null) headers["Content-Type"] = "application/json";
  const abort = composeRequestAbort(
    null,
    TEAM_CHAT_AUTO_ARCHIVE_FETCH_TIMEOUT_MS,
  );
  try {
    const answer = await untilAborted(
      transport({
        url: new URL(teamChatAutoArchivePath(teamId), base).toString(),
        method: write === null ? "GET" : "PUT",
        headers,
        body: write,
        signal: abort.signal,
      }),
      abort.signal,
    );
    return { kind: "answered", status: answer.status, text: answer.text };
  } catch {
    return { kind: "failed" };
  } finally {
    abort.clear();
  }
}

/** A 200's body, parsed; `undefined` when it is not JSON. */
function bodyOf(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function failureOf(answer: Answer): TeamChatAutoArchiveFailure {
  if (answer.kind === "failed") return { kind: "failed" };
  if (answer.status === 401) return { kind: "unauthorized" };
  if (answer.status === 403) return { kind: "forbidden" };
  return { kind: "failed" };
}

export async function fetchTeamChatAutoArchiveViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  transport: EnvironmentTransport,
  teamId: string,
): Promise<TeamChatAutoArchiveReadResult> {
  const answer = await send(
    serverBaseUrl,
    bearerToken,
    proxyToken,
    transport,
    teamId,
    null,
  );
  if (answer.kind !== "answered" || answer.status !== 200)
    return failureOf(answer);
  const parsed = teamChatAutoArchiveRecordSchema
    .nullable()
    .safeParse(bodyOf(answer.text));
  return parsed.success
    ? { kind: "ok", record: parsed.data }
    : { kind: "failed" };
}

export async function putTeamChatAutoArchiveViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  transport: EnvironmentTransport,
  teamId: string,
  request: TeamChatAutoArchiveSetRequest,
): Promise<TeamChatAutoArchiveWriteResult> {
  const answer = await send(
    serverBaseUrl,
    bearerToken,
    proxyToken,
    transport,
    teamId,
    request,
  );
  if (answer.kind !== "answered" || answer.status !== 200)
    return failureOf(answer);
  const parsed = teamChatAutoArchiveRecordSchema.safeParse(bodyOf(answer.text));
  return parsed.success
    ? { kind: "ok", record: parsed.data }
    : { kind: "failed" };
}
