import { CapacitorHttp } from "@capacitor/core";
import type { EnvironmentTransport } from "@traycer-clients/shared/environment/environment-cloud";

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
 */
export const nativeEnvironmentTransport: EnvironmentTransport = async (
  request,
) => {
  let answer: { readonly status: number; readonly data: unknown };
  try {
    answer = await CapacitorHttp.request({
      url: request.url,
      method: request.method,
      headers: { ...request.headers },
      ...(request.body === null ? {} : { data: request.body }),
      disableRedirects: true,
      responseType: "text",
    });
  } catch {
    throw new Error("The request was not answered.");
  }
  return { status: answer.status, text: textOf(answer.data) };
};

/** The native layer parses a JSON answer whatever `responseType` asks; this undoes it. */
function textOf(data: unknown): string {
  if (typeof data === "string") return data;
  if (data === null || data === undefined) return "";
  return JSON.stringify(data);
}
