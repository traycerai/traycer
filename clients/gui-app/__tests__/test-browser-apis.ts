import { configure } from "@testing-library/react";
import { vi } from "vitest";

// Vite's `?worker` import returns a Worker constructor at build time. jsdom has
// no Worker; mock the @pierre/diffs worker module to a no-op constructor so
// any test that mounts <DiffWorkerPoolProvider> doesn't crash.
vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({
  default: class MockDiffsWorker {
    postMessage(): void {}
    terminate(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  },
}));

// Brand icons (@lobehub/icons) render a decorative SVG `<title>BrandName</title>`
// for accessibility. Those titles aren't visible content, but they DO satisfy
// `getByText`, which makes any text query near a provider icon ambiguous (the
// provider's name label vs. its icon's title). Treat `<title>` like the
// `<script>`/`<style>` elements Testing Library already ignores so text queries
// match real content only.
configure({ defaultIgnore: "script, style, title" });

class MockResizeObserver implements ResizeObserver {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

function createMockStorage(): Storage {
  const storage = new Map<string, string>();

  return {
    get length() {
      return storage.size;
    },
    clear() {
      storage.clear();
    },
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(storage.keys())[index] ?? null;
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
  };
}

export function installMockLocalStorage(): Storage {
  const storage = createMockStorage();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });
  return storage;
}

if (typeof globalThis.ResizeObserver === "undefined") {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: MockResizeObserver,
  });
}

if (typeof globalThis.IntersectionObserver === "undefined") {
  class MockIntersectionObserver implements IntersectionObserver {
    readonly root: Element | Document | null = null;
    readonly rootMargin: string = "";
    readonly scrollMargin: string = "";
    readonly thresholds: ReadonlyArray<number> = [];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: MockIntersectionObserver,
  });
}

// Radix-ui's DropdownMenu / Popover triggers route through Pointer Events
// that jsdom does not implement. Stub the pointer-capture methods and
// `scrollIntoView` so opening a menu in tests does not throw.
if (typeof Element !== "undefined") {
  const elementProto = Element.prototype as Element & {
    hasPointerCapture?: (pointerId: number) => boolean;
    setPointerCapture?: (pointerId: number) => void;
    releasePointerCapture?: (pointerId: number) => void;
    scrollIntoView?: () => void;
    scrollBy?: () => void;
  };
  if (typeof elementProto.hasPointerCapture !== "function") {
    elementProto.hasPointerCapture = (): boolean => false;
  }
  if (typeof elementProto.setPointerCapture !== "function") {
    elementProto.setPointerCapture = (): void => undefined;
  }
  if (typeof elementProto.releasePointerCapture !== "function") {
    elementProto.releasePointerCapture = (): void => undefined;
  }
  if (typeof elementProto.scrollIntoView !== "function") {
    elementProto.scrollIntoView = (): void => undefined;
  }
  if (typeof elementProto.scrollBy !== "function") {
    elementProto.scrollBy = (): void => undefined;
  }
}

// jsdom throws "Not implemented" from HTMLCanvasElement.getContext (logged to
// the virtual console before throwing). The SubagentAvatar canvas treats a null
// context as "skip drawing", so stub getContext to return null - silences the
// noise and lets avatar-bearing components mount without the canvas npm package.
if (typeof HTMLCanvasElement !== "undefined") {
  const canvasProto = HTMLCanvasElement.prototype as HTMLCanvasElement & {
    getContext: () => null;
  };
  canvasProto.getContext = (): null => null;
}

// jsdom does not implement hit-testing. Tiptap 3.26's placeholder extension
// tracks the viewport via ProseMirror's `posAtCoords`, which calls
// `document.elementFromPoint`. Stub it (and `elementsFromPoint`) so mounting an
// editor in tests does not throw; null / [] is the spec-valid "no element at
// these coordinates" answer, which `posAtCoords` already handles.
if (typeof Document !== "undefined") {
  const documentProto = Document.prototype as Document & {
    elementFromPoint?: (x: number, y: number) => Element | null;
    elementsFromPoint?: (x: number, y: number) => Element[];
  };
  if (typeof documentProto.elementFromPoint !== "function") {
    documentProto.elementFromPoint = (): Element | null => null;
  }
  if (typeof documentProto.elementsFromPoint !== "function") {
    documentProto.elementsFromPoint = (): Element[] => [];
  }
}

// jsdom does not implement layout, so ProseMirror's `coordsAtPos` path that
// calls `getClientRects()` / `getBoundingClientRect()` on text nodes / ranges
// throws. Stub zero-rect responses so Tiptap's auto-scroll-into-view after
// dispatch is a no-op in tests.
const ZERO_RECT_LIST: DOMRectList = Object.assign([], {
  item: (_index: number): DOMRect | null => null,
});
const ZERO_RECT: DOMRect = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  toJSON: () => ({}),
};
if (typeof Range !== "undefined") {
  const rangeProto = Range.prototype as Range & {
    getClientRects?: () => DOMRectList;
    getBoundingClientRect?: () => DOMRect;
  };
  if (typeof rangeProto.getClientRects !== "function") {
    rangeProto.getClientRects = (): DOMRectList => ZERO_RECT_LIST;
  }
  if (typeof rangeProto.getBoundingClientRect !== "function") {
    rangeProto.getBoundingClientRect = (): DOMRect => ZERO_RECT;
  }
}
if (typeof Node !== "undefined") {
  const nodeProto = Node.prototype as Node & {
    getClientRects?: () => DOMRectList;
    getBoundingClientRect?: () => DOMRect;
  };
  if (typeof nodeProto.getClientRects !== "function") {
    nodeProto.getClientRects = (): DOMRectList => ZERO_RECT_LIST;
  }
  if (typeof nodeProto.getBoundingClientRect !== "function") {
    nodeProto.getBoundingClientRect = (): DOMRect => ZERO_RECT;
  }
}

if (typeof window !== "undefined") {
  Object.defineProperty(globalThis, "Event", {
    configurable: true,
    writable: true,
    value: window.Event,
  });
  Object.defineProperty(globalThis, "CustomEvent", {
    configurable: true,
    writable: true,
    value: window.CustomEvent,
  });
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
  Object.defineProperty(window, "scrollBy", {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  const storage = window.localStorage as Partial<Storage> | undefined;
  if (
    !storage ||
    typeof storage.getItem !== "function" ||
    typeof storage.setItem !== "function" ||
    typeof storage.removeItem !== "function" ||
    typeof storage.clear !== "function"
  ) {
    installMockLocalStorage();
  }
}

/**
 * Installs a fetch stub that satisfies AuthService's
 * `${authnBaseUrl}/api/v3/user` validation with a 200 response carrying a
 * structured `AuthenticatedUser` body (identity nested under `user`), and
 * rejects every other URL. Used by tree-level integration tests so the
 * post-T6 token validation path does not need a real network. The body
 * mirrors the real AuthnV3 v3 contract because AuthService now treats a
 * 2xx response without a usable profile (parsed from the nested `user`
 * object) as a session-expired-equivalent rejection. Returns a teardown
 * function that restores the previous fetch.
 */
export function installAuthValidationFetch(): () => void {
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  const stub = (input: unknown): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    if (url.endsWith("/api/v3/user")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            user: {
              id: "user-1",
              name: "Test User",
              providerId: "gh-1",
              providerHandle: "test-user",
              providerType: "GITHUB",
              email: "test@example.com",
              avatarUrl: null,
              activatedAt: null,
              createdAt: "2024-01-01T00:00:00.000Z",
              updatedAt: "2024-01-01T00:00:00.000Z",
              lastSeenAt: null,
              privacyMode: false,
              isLearningEnabled: true,
            },
            userSubscription: {
              id: "sub-1",
              userID: "user-1",
              orgID: null,
              teamID: null,
              customerId: "cus-1",
              createdAt: "2024-01-01T00:00:00.000Z",
              updatedAt: "2024-01-01T00:00:00.000Z",
              subscriptionExpiry: null,
              trialEndsAt: null,
              subscriptionStatus: "FREE",
              hasPaymentMethod: false,
              isInTrial: false,
              rechargeRateSeconds: 0,
            },
            teamSubscriptions: [],
            payAsYouGoUsage: { allowPayAsYouGo: false },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }
    return Promise.reject(new Error(`fetch disabled in tests for ${url}`));
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: stub,
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  };
}
