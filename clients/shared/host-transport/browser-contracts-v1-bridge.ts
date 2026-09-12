import type {
  BrowserScreencastOpenRequest,
  BrowserSessionInfo,
  BrowserSessionsClientFrame,
  BrowserSessionsServerFrame,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserScreencastOpenRequestV10,
  BrowserSessionInfoV10,
  BrowserSessionsClientFrameV10,
  BrowserSessionsServerFrameV10,
  BrowserTabInfoV10,
} from "@traycer/protocol/host/browser/contracts-v1";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { IHostStreamClient } from "./host-stream-client";
import type { IStreamSession } from "./i-stream-session";
import type { ParamsOf } from "./ws-stream-client";

/**
 * The client's half of the `browser.sessions` / `browser.screencast` `@1.0`
 * line - everything that translates between the frozen shapes a v1.3.0 host
 * serves (`protocol/host/browser/contracts-v1.ts`) and the live `@2.0` shapes
 * the GUI, the desktop and the PiP bridge are written against.
 *
 * The direction is the mirror of the host's own bridge: it PROJECTS its live
 * frames down to `@1`, and this LIFTS them back up, so a consumer above the two
 * stream wrappers never learns which major it is talking to. What a lift
 * invents is always the value the live line defines as "nothing was said": a
 * tab bound to no window, a tab with no named opener, an open that owed no
 * placement handoff. `@1` cannot express any of those, so `null` is not a
 * guess - it is the only thing the older host could have meant.
 *
 * Two things this module deliberately does NOT do:
 *
 *  - It never touches `browser.screencast` FRAMES. The two lines' server and
 *    client frame unions are byte-identical (the majors diverge on the open
 *    request alone), so a lift there would be a second copy of a contract with
 *    nothing to translate.
 *  - It never invents an `attachTab` / `moveTab` substitute. Those frames have
 *    no `@1` spelling at all, and a window-bound placement silently reinterpreted
 *    as some other request is worse than a refusal - so the projection reports
 *    them as unsupported and leaves the answer to the wrapper.
 */

/**
 * A live client frame, ready for the `@1` wire - or the request id of one this
 * line cannot carry, which the wrapper must answer locally.
 *
 * A result type rather than `null`, because the caller owes the sender an
 * answer either way: every unsupported frame here is a REQUEST whose
 * `actionAck` a coordinator is already awaiting, and a dropped frame would sit
 * there until its timeout with nothing said.
 */
export type BrowserSessionsClientFrameV10Projection =
  | { readonly kind: "frame"; readonly frame: BrowserSessionsClientFrameV10 }
  | { readonly kind: "unsupported"; readonly requestId: string }
  | { readonly kind: "ignored" };

/** The kinds the client-frame projection hands over untouched. */
type PassedThroughClientFrameKind = Exclude<
  BrowserSessionsClientFrame["kind"],
  | "attachTab"
  | "moveTab"
  | "electronTabLifecycleReady"
  | "setViewport"
  | "reportViewport"
  | "electronViewportResult"
>;

/**
 * Every key the LIVE line carries on a passed-through kind that the frozen line
 * does not - `never` for as long as the two agree about those kinds.
 */
type LiveOnlyKeyOnPassedThroughClientFrame = {
  [Kind in PassedThroughClientFrameKind]: Exclude<
    keyof Extract<BrowserSessionsClientFrame, { readonly kind: Kind }>,
    keyof Extract<BrowserSessionsClientFrameV10, { readonly kind: Kind }>
  >;
}[PassedThroughClientFrameKind];

/**
 * The compile-time guard the projection's pass-through arms rest on, and the
 * only one there can be: TypeScript will not object to an extra key on a
 * variable assigned to a narrower type, so `return frame` for a kind the live
 * line has since grown a field on would type-check and then be dropped, whole
 * and silently, by a v1.3.0 host's `.strict()` parse.
 *
 * Add a field to any of those kinds on the live line and this stops compiling,
 * with the offending key named in the error. The fix is never to widen this: it
 * is to rebuild that arm field by field, the way `electronTabLifecycleReady`
 * already is, and decide what the `@1` host is told instead.
 *
 * Exported because it is a declaration whose whole job is to be checked rather
 * than read, and `noUnusedLocals` would otherwise delete the guard for us.
 */
export const PASSED_THROUGH_CLIENT_FRAMES_MATCH_THE_FROZEN_LINE: [
  LiveOnlyKeyOnPassedThroughClientFrame,
] extends [never]
  ? true
  : { readonly liveOnlyKeys: LiveOnlyKeyOnPassedThroughClientFrame } = true;

/**
 * What a `@1` host is told when a window-bound placement request reaches it.
 *
 * Deliberately about the HOST rather than about the tab: the tile asks on every
 * activation, so this is the reason a user sees whenever they open a browser
 * tile against an older host, and "this tab is busy" would send them looking
 * for a tab problem that does not exist.
 */
export const BROWSER_SESSIONS_V1_NO_WINDOW_BINDING_REASON =
  "This host predates window-bound browser tabs. Update it to place a tab in this window.";

/**
 * Whether a rejected `attachTab` / `moveTab` is THIS refusal rather than one
 * of the host's own.
 *
 * The distinction is the whole point, and it is not a nicety: a host's refusal
 * ("bound in another window", "the session is closing") is transient and the
 * reader's next activation is its retry, while this one is a standing fact
 * about the LINE - it will refuse the same request for as long as the reader
 * is on this host, and no amount of retrying changes that. A caller that
 * treats the two alike either retries forever or gives up on a tab that was
 * about to come back.
 *
 * Matched on the reason because that is the only channel an `actionAck` has,
 * and it lives HERE, beside the string it compares against, so the refusal and
 * its recogniser can never drift into two different sentences in two packages.
 */
export function isBrowserSessionsV1NoWindowBindingRefusal(
  error: unknown,
): error is Error {
  return (
    error instanceof Error &&
    error.message === BROWSER_SESSIONS_V1_NO_WINDOW_BINDING_REASON
  );
}

/**
 * Negotiate the current scope-addressed minor, including after reconnect.
 * A @1 host rejects the strict scope-shaped params rather than opening an
 * unrelated epic. Pinning 2.0 here would prevent independent tabs using 2.1.
 */
export function subscribeAtScopeAddressedBrowserVersion<
  Method extends "browser.sessions" | "browser.screencast",
>(
  client: IHostStreamClient<HostStreamRpcRegistry>,
  method: Method,
  params: ParamsOf<HostStreamRpcRegistry, Method>,
): IStreamSession {
  return client.subscribeWithParamsProvider(method, () => params);
}

/** `@1` addresses a session's owner by epic id; the live line by scope. */
function liftSessionInfoFromV10(
  session: BrowserSessionInfoV10,
): BrowserSessionInfo {
  const { epicId, tabs, ...rest } = session;
  return {
    ...rest,
    scope: { kind: "epic", epicId },
    tabs: tabs.map(liftTabInfoFromV10),
  };
}

/**
 * `@1` has no window-bound tabs: its host elects one native route per scope, so
 * every tab it reports is on whichever route that is. `null` is what the live
 * line calls that - "no window holds this binding" - and is exactly what keeps
 * a tile from rendering "open in your other window" against a host that has no
 * other window to speak of.
 */
function liftTabInfoFromV10(tab: BrowserTabInfoV10): BrowserTabInfo {
  return { ...tab, boundWindowId: null };
}

/**
 * One `@1` server frame in the live shape. Total over the frozen union, with a
 * `never` default: `@1` can never grow a frame kind, so a new arm here can only
 * come from the LIVE line, and that is precisely the case that must not compile
 * until someone has decided what the older host's silence means for it.
 */
export function liftBrowserSessionsServerFrameFromV10(
  frame: BrowserSessionsServerFrameV10,
): BrowserSessionsServerFrame {
  switch (frame.kind) {
    case "snapshot":
      return { ...frame, sessions: frame.sessions.map(liftSessionInfoFromV10) };
    case "sessionCreated":
      return { ...frame, session: liftSessionInfoFromV10(frame.session) };
    case "sessionUpdated":
      return { ...frame, session: liftSessionInfoFromV10(frame.session) };
    case "tabOpened":
      // A `@1` host names no opener even for a page-opened tab, so a surface
      // deciding whether to follow one falls back to its own placement.
      return { ...frame, openerTabId: null };
    case "openTabResult": {
      // No handoff token on this line: placement there is tab-keyed host-side,
      // so a screencast presenting nothing is the whole protocol.
      const result = frame.result;
      return {
        kind: "openTabResult",
        hasBinaryPayload: false,
        requestId: frame.requestId,
        result: result.ok ? { ...result, handoffToken: null } : result,
      };
    }
    // Identical on both lines - the majors diverge on the open request, on
    // session/tab identity, and on the three frames above it. Listed
    // exhaustively rather than caught by a `default`, so a live-line addition
    // lands on the `never` below instead of being passed through unexamined.
    case "sessionClosed":
    case "actionAck":
    case "tabPreviewResult":
    case "primaryProfileCaptureAck":
    case "cdpRequest":
    case "createElectronTab":
    case "electronTabAccepted":
    case "releaseElectronTab":
    case "capturePrimaryProfile":
    case "storeKeyWrapRequest":
    case "storeKeyUnwrapRequest":
    case "desktopIdentityChallenge":
    case "primaryProfileObserved":
    case "primaryProfileForgetLedgerAck":
    case "burstStarted":
    case "burstEnded":
    case "caption":
      return frame;
    default: {
      const unhandled: never = frame;
      return unhandled;
    }
  }
}

/**
 * One live client frame in the `@1` shape, or a refusal for the two frames that
 * line never had.
 *
 * The frozen schemas are `.strict()`, so a field the live line added is not a
 * harmless extra: a v1.3.0 host drops the whole frame, silently, and the sender
 * waits out a timeout for an answer that was never going to come. An arm that
 * has diverged is therefore rebuilt field by field rather than spread.
 *
 * The pass-through arms need a guard the LIFT direction gets for free. Lifting
 * UP has to supply every live field, so a live addition simply stops compiling
 * there; projecting DOWN is the opposite - `frame` is a variable rather than a
 * fresh literal, so structural typing lets an extra key ride along in silence.
 * {@link PASSED_THROUGH_CLIENT_FRAMES_MATCH_THE_FROZEN_LINE} is what objects
 * instead.
 */
export function projectBrowserSessionsClientFrameToV10(
  frame: BrowserSessionsClientFrame,
): BrowserSessionsClientFrameV10Projection {
  switch (frame.kind) {
    case "reportViewport":
    case "electronViewportResult":
      return { kind: "ignored" };
    case "setViewport":
    case "attachTab":
    case "moveTab":
      return { kind: "unsupported", requestId: frame.requestId };
    case "electronTabLifecycleReady":
      // `desktopWindowId` is the one field stripped here: this line's host
      // elects a single native route per scope, so the window a subscriber
      // speaks for is a fact it has no reader for - and a strict parse would
      // drop the readiness frame that gates the whole Electron route.
      return {
        kind: "frame",
        frame: {
          kind: "electronTabLifecycleReady",
          hasBinaryPayload: false,
          coLocatedHostId: frame.coLocatedHostId,
        },
      };
    // Identical on both lines.
    case "openTab":
    case "closeTab":
    case "captureTabPreview":
    case "cdpResult":
    case "electronTabProvisioned":
    case "electronTabCreateFailed":
    case "electronTabState":
    case "primaryProfileCaptured":
    case "primaryProfileDelta":
    case "desktopIdentityAttest":
    case "storeKeyWrapped":
    case "storeKeyUnwrapped":
    case "clearSite":
    case "forgetLogins":
    case "primaryProfileForgetLedger":
      return { kind: "frame", frame };
    default: {
      const unhandled: never = frame;
      return unhandled;
    }
  }
}

/**
 * The `@1` screencast open for an epic-scoped subscription.
 *
 * Field by field rather than a rest spread, for the reason the client-frame
 * projection gives: the frozen open request is `.strict()`, so a field added to
 * the live request must be dropped here, and a spread would carry it instead -
 * failing the open rather than one feature.
 *
 * `handoffToken` is what that drops today. It is the token a successful
 * `openTab` answers a client with, and `@1` mints none: placement on that line
 * is tab-keyed host-side, so there is nothing for a viewer to present and
 * nothing lost by withholding it.
 */
export function projectBrowserScreencastOpenRequestToV10(
  request: BrowserScreencastOpenRequest,
  epicId: string,
): BrowserScreencastOpenRequestV10 {
  return {
    epicId,
    sessionId: request.sessionId,
    tabId: request.tabId,
    maxWidth: request.maxWidth,
    maxHeight: request.maxHeight,
    quality: request.quality,
    format: request.format,
    role: request.role,
  };
}
