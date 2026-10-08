/**
 * The page policies the sandbox loader writes as a `<meta>` CSP on top of its
 * base policy (`default-src * …; form-action 'none'; base-uri 'none'`). A meta
 * policy can only narrow: the browser enforces the intersection, and a page
 * that adds or removes a meta of its own cannot loosen either one.
 */

export type SandboxNetworkPolicy = "open" | "https-only";

/**
 * No policy in this file names the app's or the sandbox's own origin: on mobile
 * that origin also serves Capacitor's native routes (`/_capacitor_*`, the
 * native HTTP proxy among them), and on desktop it is the sandbox scheme. The
 * one thing a page took from it, the Figtree face, arrives inside the loader as
 * a `data:` font.
 *
 * An `open` page reaches the web, localhost and the LAN. It names its schemes
 * rather than relying on the base policy's `*`, which also admits the
 * document's own scheme (`capacitor:`, `traycer-sandbox:`). A page shown to
 * someone who did not author it reaches https only, so it cannot touch the
 * viewer's localhost or LAN.
 */
export function pageContentPolicy(networkPolicy: SandboxNetworkPolicy): string {
  if (networkPolicy === "open") {
    return "default-src http: https: ws: wss: data: blob: 'unsafe-inline' 'unsafe-eval'";
  }
  return [
    "default-src https: data: blob:",
    "connect-src https: wss: data: blob:",
    "script-src https: 'unsafe-inline' 'unsafe-eval' data: blob:",
    "style-src https: 'unsafe-inline' data: blob:",
    "img-src https: data: blob:",
    "font-src https: data: blob:",
    "media-src https: data: blob:",
    "frame-src 'none'",
  ].join("; ");
}

/**
 * An MCP App's declared CSP, already normalized from the resource's
 * `_meta.ui.csp`. `baseUriDomains` is accepted and ignored: the loader's base
 * policy pins `base-uri 'none'`, and a meta cannot widen it.
 */
export interface McpAppCsp {
  readonly connectDomains: readonly string[];
  readonly resourceDomains: readonly string[];
  readonly frameDomains: readonly string[];
  readonly baseUriDomains: readonly string[];
}

export type McpAppContentPolicyResult =
  | { readonly kind: "ok"; readonly policy: string }
  | { readonly kind: "invalid"; readonly reason: string };

const MAX_DOMAINS_PER_LIST = 32;

/**
 * Only an https or wss origin, optionally with one leading `*.` label and a
 * port. Nothing else can reach the policy text, so no `;`, quote, space or
 * keyword can be smuggled into a directive.
 */
const DOMAIN_PATTERN = /^(https|wss):\/\/(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/;

function invalidReason(field: string, list: readonly string[]): string | null {
  if (list.length > MAX_DOMAINS_PER_LIST)
    return `${field}: more than 32 entries`;
  if (list.some((domain) => !DOMAIN_PATTERN.test(domain))) {
    return `${field}: not an https/wss origin`;
  }
  return null;
}

function sources(base: readonly string[], extra: readonly string[]): string {
  return [...base, ...extra].join(" ");
}

/**
 * Deny by default, always. With no declared CSP an app gets inline script and
 * style, local images, fonts and media, and no network at all. A declared CSP
 * adds its validated origins to exactly the directives they name, or the whole
 * policy is refused.
 */
export function mcpAppContentPolicy(
  csp: McpAppCsp | null,
): McpAppContentPolicyResult {
  const connect = csp?.connectDomains ?? [];
  const resource = csp?.resourceDomains ?? [];
  const frame = csp?.frameDomains ?? [];
  const reason =
    invalidReason("connectDomains", connect) ??
    invalidReason("resourceDomains", resource) ??
    invalidReason("frameDomains", frame);
  if (reason !== null) return { kind: "invalid", reason };
  return {
    kind: "ok",
    policy: [
      "default-src 'none'",
      `script-src ${sources(["'unsafe-inline'"], resource)}`,
      `style-src ${sources(["'unsafe-inline'"], resource)}`,
      `img-src ${sources(["data:", "blob:"], resource)}`,
      `font-src ${sources(["data:"], resource)}`,
      `media-src ${sources(["data:", "blob:"], resource)}`,
      `connect-src ${connect.length === 0 ? "'none'" : connect.join(" ")}`,
      `frame-src ${frame.length === 0 ? "'none'" : frame.join(" ")}`,
    ].join("; "),
  };
}
