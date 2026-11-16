import { CapacitorHttp } from "@capacitor/core";
import {
  MAX_FAILURE_BODY_BYTES,
  type EnvironmentTransport,
} from "@traycer-clients/shared/environment/environment-cloud";

/**
 * The phone's transport for the app's own calls to authn's environment routes.
 *
 * Capacitor's patched `fetch` ignores `redirect`: a POST, PUT or DELETE goes
 * to the native request with redirects followed (on iOS `URLSession.shared`,
 * which re-sends the method and body on a 307 or 308), and a GET goes through
 * the native proxy URL. Every method here, GET included, goes to the native
 * request itself with redirects disabled, so it is sent once and a 3xx comes
 * back as the answer, which every caller reads as a non-success, as on
 * desktop.
 *
 * The body goes as its JSON value, which the native layer serializes for the
 * `application/json` the request names. A failure rejects with nothing of the
 * request or its answer: no URL, header, body or token in its text.
 *
 * A failure's body cap is applied after the body arrives: the native request
 * reads the whole answer before it hands any of it back, and offers neither a
 * stream nor a size limit. A failure's body over the cap is then dropped, as
 * on desktop; a success is kept whole.
 */
export const nativeEnvironmentTransport: EnvironmentTransport = async (
  request,
) => {
  let answer: NativeAnswer;
  try {
    answer = await nativeRequest({
      url: request.url,
      method: request.method,
      headers: request.headers,
      data: request.body,
    });
  } catch {
    throw new Error("The request was not answered.");
  }
  const text = answer.text;
  const success = answer.status >= 200 && answer.status < 300;
  const overCap =
    !success &&
    new TextEncoder().encode(text).byteLength > MAX_FAILURE_BODY_BYTES;
  return { status: answer.status, text: overCap ? null : text };
};

/**
 * One request as the native layer sends it: `data` is the body (a string, or
 * a JSON value it serializes for `application/json`), or null for none.
 */
export interface NativeRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly data: unknown;
}

/** The answer as received, its body as text. */
export interface NativeAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
}

export type NativeRequester = (request: NativeRequest) => Promise<NativeAnswer>;

/**
 * The phone's one native request: sent once, with redirects disabled, so a
 * 3xx is the answer. It rejects when nothing answered.
 */
export const nativeRequest: NativeRequester = async (request) => {
  const answer = await CapacitorHttp.request({
    url: request.url,
    method: request.method,
    headers: { ...request.headers },
    ...(request.data === null ? {} : { data: request.data }),
    disableRedirects: true,
    responseType: "text",
  });
  return {
    status: answer.status,
    headers: answer.headers,
    text: textOf(answer.data),
  };
};

/** The native layer parses a JSON answer whatever `responseType` asks; this undoes it. */
function textOf(data: unknown): string {
  if (typeof data === "string") return data;
  if (data === null || data === undefined) return "";
  return JSON.stringify(data);
}
