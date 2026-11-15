/**
 * `POST /api/tasks/environment-attachment` on traycer-server: the app attaches
 * a task to a team's environment on the person's own sign-in, the request
 * the host's `epic.attachEnvironment@1.0` sent for it. A sibling of
 * `environment-directory.ts`, and it runs where that runs: desktop in Electron
 * main (traycer-server's CORS list does not take the app renderer), the phone
 * through its native request.
 *
 * Sent once through the shell's `EnvironmentTransport`, which never follows a
 * redirect: a 3xx, or a browser's opaque redirect, is an answered
 * non-success. Nothing here throws, logs, or answers with any part of the
 * request or of the server's body.
 */
import { z } from "zod";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import type { EnvironmentTransport } from "../environment/environment-cloud";

/** The route runs on the server's `standard` forward tier (60 s); the margin lets its own answer arrive first. */
const ATTACHMENT_TIMEOUT_MS = 70_000;

const attachmentAnswerSchema = z.object({ attached: z.literal(true) });

/** The task and the team environment it is attached to. */
export interface TaskEnvironmentAttachmentRequest {
  readonly taskId: string;
  readonly environmentId: string;
}

/**
 * - `ok`: attached, or already attached;
 * - `unauthorized`: the server refused the person's sign-in (401);
 * - `forbidden`: the server refused the person (403): not the task's owner,
 *   or not a member of the team;
 * - `refused`: any other answer that is not an attachment: another status, a
 *   redirect, or a body this build cannot read;
 * - `no_response`: nothing answered in time.
 */
export type TaskEnvironmentAttachmentResult =
  | { readonly kind: "ok" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "refused" }
  | { readonly kind: "no_response" };

/**
 * `proxyToken` is the Google IAP id-token a staging desktop's main process
 * mints, sent as `Proxy-Authorization` ahead of the person's `Authorization`;
 * every other caller passes `null`.
 */
export async function attachTaskEnvironmentViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  proxyToken: string | null,
  transport: EnvironmentTransport,
  request: TaskEnvironmentAttachmentRequest,
): Promise<TaskEnvironmentAttachmentResult> {
  const base = serverBaseUrl.endsWith("/")
    ? serverBaseUrl
    : `${serverBaseUrl}/`;
  const headers: Record<string, string> =
    proxyToken === null
      ? {}
      : { "Proxy-Authorization": `Bearer ${proxyToken}` };
  headers.Authorization = `Bearer ${bearerToken}`;
  headers.Accept = "application/json";
  headers["Content-Type"] = "application/json";
  const abort = composeRequestAbort(null, ATTACHMENT_TIMEOUT_MS);
  let answer: { readonly status: number; readonly text: string | null };
  try {
    answer = await untilAborted(
      transport({
        url: new URL("api/tasks/environment-attachment", base).toString(),
        method: "POST",
        headers,
        body: { taskId: request.taskId, environmentId: request.environmentId },
        signal: abort.signal,
      }),
      abort.signal,
    );
  } catch {
    return { kind: "no_response" };
  } finally {
    abort.clear();
  }
  if (answer.status === 401) return { kind: "unauthorized" };
  if (answer.status === 403) return { kind: "forbidden" };
  if (answer.status < 200 || answer.status >= 300 || answer.text === null) {
    return { kind: "refused" };
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(answer.text);
  } catch {
    return { kind: "refused" };
  }
  return attachmentAnswerSchema.safeParse(parsedBody).success
    ? { kind: "ok" }
    : { kind: "refused" };
}
