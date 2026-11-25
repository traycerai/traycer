// Runs in desktop main or the phone's shell: traycer-server's CORS list does not
// take the app renderer. Sent once, following no redirect; nothing here throws,
// logs or answers with any part of the request or the server's body.
import { z } from "zod";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import type { EnvironmentTransport } from "../environment/environment-cloud";

/** The route runs on the server's `standard` forward tier (60 s); the margin lets its own answer arrive first. */
const ATTACHMENT_TIMEOUT_MS = 70_000;

const attachmentAnswerSchema = z.object({ attached: z.literal(true) });

export const TEAM_PLAN_REQUIRED_MESSAGE =
  "Sharing with this team requires a paid team plan";

const teamPlanRefusalSchema = z.object({
  error: z.literal(TEAM_PLAN_REQUIRED_MESSAGE),
});

export interface TaskEnvironmentAttachmentRequest {
  readonly taskId: string;
  readonly environmentId: string;
}

export type TaskEnvironmentAttachmentResult =
  | { readonly kind: "ok" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "team_plan_required" }
  | { readonly kind: "refused" }
  | { readonly kind: "no_response" };

/**
 * `proxyToken`: the IAP id-token a staging desktop's main mints, sent as
 * `Proxy-Authorization`; every other caller passes `null`.
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
  if (answer.status === 403) {
    if (answer.text !== null) {
      try {
        if (teamPlanRefusalSchema.safeParse(JSON.parse(answer.text)).success) {
          return { kind: "team_plan_required" };
        }
      } catch {
        return { kind: "forbidden" };
      }
    }
    return { kind: "forbidden" };
  }
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
