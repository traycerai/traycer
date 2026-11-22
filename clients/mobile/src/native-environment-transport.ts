import { CapacitorHttp } from "@capacitor/core";
import {
  MAX_FAILURE_BODY_BYTES,
  type EnvironmentTransport,
} from "@traycer-clients/shared/environment/environment-cloud";

/**
 * Every method, GET included, goes to the native request with redirects disabled:
 * Capacitor's patched `fetch` follows them. A failure rejects with nothing of the
 * request or its answer in its text. The native layer has no stream or size limit,
 * so a failure's body cap applies after the body arrives; a success is kept whole.
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
