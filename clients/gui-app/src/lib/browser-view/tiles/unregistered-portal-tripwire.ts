import { appLogger } from "@/lib/logger";
import { listBrowserOverlayElements } from "./browser-overlay-coordinator";

/**
 * Dev-build tripwire (browser-overlay-coexistence epic, ticket 02). The
 * ESLint import ban (same ticket) catches a raw portal-primitive IMPORT; it
 * cannot see a hand-rolled overlay built with no forbidden import at all, or
 * a third-party portal outside the five banned packages. This is the other
 * half: it watches for the PAINTED result - any direct `document.body` child
 * outside the app root - and flags one that has no matching
 * `registerBrowserOverlay` entry (ticket 01), regardless of how it got
 * there.
 *
 * Report-only: never registers or occludes the offender itself. A tripwire
 * that quietly fixed the miss would hide exactly the bug it exists to
 * surface (spec Discovery section). Fixing what it finds is a follow-up, not
 * this ticket.
 */

/**
 * True when `element` should be reported: painted (positive-area rect) and
 * absent from the live registry.
 */
function isUnregisteredPortalChild(element: Element): boolean {
  const registered = listBrowserOverlayElements();
  // A DESCENDANT match counts as registered, not just identity: Radix puts
  // its own portal `div` between `document.body` and the content node the
  // wrapper registers (`SelectContent` registers `SelectPrimitive.Content`),
  // so an identity check reports that container as an unregistered portal
  // every time it has a positive-area rect.
  if (registered.some((node) => node === element || element.contains(node))) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function describeElement(element: Element): {
  readonly tag: string;
  readonly dataSlot: string;
  readonly classList: string;
} {
  return {
    tag: element.tagName.toLowerCase(),
    dataSlot: element.getAttribute("data-slot") ?? "",
    // `.className` is an `SVGAnimatedString` (not a plain string) on SVG
    // elements; `getAttribute` reads the same content either way.
    classList: element.getAttribute("class") ?? "",
  };
}

/**
 * Installs the observer. `appRoot` is the app's single legitimate direct
 * `document.body` child (`#root` in production - see
 * `clients/desktop/src/renderer-shell/index.html`); passed explicitly rather
 * than hardcoding the id so the unit test can supply its own fixture root.
 *
 * Dedupe is per element (a `WeakSet`) so a re-rendering portal that stays
 * unregistered does not spam - it is reported once, not once per mutation.
 *
 * Returns a disposer.
 */
export function installUnregisteredPortalTripwire(
  appRoot: Element,
): () => void {
  const reported = new WeakSet<Element>();

  const inspect = (element: Element): void => {
    if (element === appRoot) return;
    if (reported.has(element)) return;
    if (!isUnregisteredPortalChild(element)) return;
    reported.add(element);
    const { tag, dataSlot, classList } = describeElement(element);
    appLogger.warn(
      "unregistered portal painted outside the browser-overlay registry",
      { tag, dataSlot, classList },
    );
  };

  // Inspects the CURRENT set of `document.body` children on every batch,
  // rather than just `mutation.addedNodes`: an element that mounted with a
  // zero-area rect (skipped, never added to `reported`) and later grows is
  // otherwise never re-checked, since it is not itself an added node on the
  // childList mutation that reflects its growth.
  const observer = new MutationObserver(() => {
    Array.from(document.body.children).forEach(inspect);
  });
  observer.observe(document.body, { childList: true });

  return () => observer.disconnect();
}
