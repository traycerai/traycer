import { isRedirectAnswer } from "@traycer-clients/shared/auth/redirect-answer";
import { untilAborted } from "@traycer-clients/shared/auth/request-abort";
import {
  nativeRequest,
  type NativeAnswer,
  type NativeRequester,
} from "./native-environment-transport";

type Fetch = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
) => Promise<Response>;

/**
 * The window's `fetch` on the phone, made to honour `redirect: "manual"`.
 *
 * Capacitor's patched `fetch` drops `redirect` from a request's init: a POST
 * goes to the native request with redirects followed (on iOS
 * `URLSession.shared`, which re-sends the method and body on a 307 or 308),
 * and a GET goes through the native proxy, which follows them too. A request
 * that carries a credential says `redirect: "manual"` so its credential never
 * reaches wherever a redirect points; here that request goes to `request`
 * instead, which follows none, so a 3xx comes back as the answer and every
 * caller reads it as the non-success it reads on desktop. Every other request
 * goes to `platform` untouched.
 */
export function manualRedirectFetch(
  platform: Fetch,
  request: NativeRequester,
): Fetch {
  return async (input, init) => {
    if (init?.redirect !== "manual") return platform(input, init);
    const signal = init.signal ?? null;
    if (signal?.aborted === true) throw givenUp();
    const sent = send(request, input, init);
    const answer =
      signal === null ? await sent : await untilAborted(sent, signal);
    // A late answer to a request already given up is never read.
    if (signal?.aborted === true) throw givenUp();
    return responseOf(answer);
  };
}

/** Wraps the window's `fetch`; installed once, before the app's first request. */
export function installManualRedirectFetch(win: Window): void {
  const platform = win.fetch.bind(win);
  Reflect.set(win, "fetch", manualRedirectFetch(platform, nativeRequest));
}

function givenUp(): DOMException {
  return new DOMException("The request was given up.", "AbortError");
}

async function send(
  request: NativeRequester,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<NativeAnswer> {
  const source = input instanceof Request ? input : null;
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const data =
    init.body === undefined || init.body === null
      ? await sourceText(source)
      : bodyData(init.body);
  try {
    return await request({
      url,
      method: (init.method ?? source?.method ?? "GET").toUpperCase(),
      headers: Object.fromEntries(
        new Headers(init.headers ?? source?.headers).entries(),
      ),
      data,
    });
  } catch {
    throw new TypeError("The request was not answered.");
  }
}

async function sourceText(source: Request | null): Promise<string | null> {
  if (source === null || source.body === null) return null;
  return source.text();
}

/**
 * The body as the native layer takes it: a string, as Capacitor's own patch
 * sends one. A body of any other kind is not sent; no request that carries a
 * credential sends one.
 */
function bodyData(body: BodyInit): string {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new TypeError("This request body is not sent from the phone.");
}

/**
 * The native answer as a `Response`. A redirect's body is not kept. A status
 * no `Response` can carry, which the native layer does not report, is the
 * network error a `fetch` answers with, whose status is 0.
 */
function responseOf(answer: NativeAnswer): Response {
  const { status } = answer;
  if (status < 200 || status > 599) return Response.error();
  // A 204 and a 205 cannot carry a body.
  const empty = status === 204 || status === 205 || isRedirectAnswer(status);
  return new Response(empty ? null : answer.text, {
    status,
    headers: answer.headers,
  });
}
