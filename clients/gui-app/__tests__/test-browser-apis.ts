import { configure } from "@testing-library/react";
import { vi } from "vitest";
import { createFakeBridgePair } from "@traycer-clients/shared/replica-runtime/worker/test-support/fake-bridge-pair";
import { createFakeWorkerTarget } from "@traycer-clients/shared/replica-runtime/worker/test-support/fake-worker-target";
import { startEpicRuntimeWorkerHost } from "@/stores/epics/open-epic/runtime/worker/epic-runtime-worker-host";
import { __setEpicRuntimeWorkerFactoryForTests } from "@/lib/registries/epic-runtime-worker-factory-slot";

// jsdom has no `Worker`. One in-process factory for every suite: lazy, per-call, coreless. Opt out with `__setEpicRuntimeWorkerFactoryForTests(null)`.
__setEpicRuntimeWorkerFactoryForTests(() => {
  const pair = createFakeBridgePair("sync");
  const host = startEpicRuntimeWorkerHost(pair.worker);
  return {
    ...createFakeWorkerTarget(pair),
    terminate: () => {
      host.shutdown();
    },
    // Unreachable here: this host runs in this thread, so there is no module fetch to fail.
    onWorkerFault: () => {},
  };
});

// Default fake durable transport for every jsdom suite. A file-level `vi.mock` takes precedence.
vi.mock("@/lib/host/use-durable-stream-transport", async () => {
  const { fakeDurableStreamTransports } =
    await import("@/lib/host/test-support/fake-durable-stream-transport");
  return {
    useDurableStreamTransportFactory: () =>
      fakeDurableStreamTransports().opener,
  };
});

// Catch post-teardown `unhandledRejection` / `uncaughtException` so they do not take down the vitest worker. Register idempotently.
interface NodeProcessLike {
  on(event: string, listener: (value: unknown) => void): void;
  listeners(event: string): ReadonlyArray<{ readonly name: string }>;
}
function traycerTestUnhandledRejection(reason: unknown): void {
  console.error("[test] ignored unhandledRejection after teardown:", reason);
}
function traycerTestUncaughtException(error: unknown): void {
  console.error("[test] ignored uncaughtException after teardown:", error);
}
const nodeProcess = (globalThis as { process?: NodeProcessLike }).process;
if (nodeProcess !== undefined) {
  const isRegistered = (event: string, name: string): boolean =>
    nodeProcess.listeners(event).some((listener) => listener.name === name);
  if (!isRegistered("unhandledRejection", traycerTestUnhandledRejection.name)) {
    nodeProcess.on("unhandledRejection", traycerTestUnhandledRejection);
  }
  if (!isRegistered("uncaughtException", traycerTestUncaughtException.name)) {
    nodeProcess.on("uncaughtException", traycerTestUncaughtException);
  }
}

// jsdom has no Worker; mock the @pierre/diffs worker so <DiffWorkerPoolProvider> can mount.
vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({
  default: class MockDiffsWorker {
    postMessage(): void {}
    terminate(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  },
}));

// ECharts cannot run under jsdom. Mock globally so usage surfaces get a recording fake.
export interface EChartsMockInstance {
  readonly dom: HTMLElement;
  readonly options: unknown[];
  /** Every `setOption` call's second argument, index-aligned with `options`. */
  readonly setOptionOpts: unknown[];
  disposed: boolean;
}
interface EChartsMockGlobal {
  __traycerEChartsMockInstances?: EChartsMockInstance[];
}
/** Live charts only. The append-only record would let `.at(-1)` read an unmounted instance. getAllEChartsMockInstances keeps the unfiltered list. */
export function getEChartsMockInstances(): readonly EChartsMockInstance[] {
  return getAllEChartsMockInstances().filter((record) => !record.disposed);
}
export function getAllEChartsMockInstances(): readonly EChartsMockInstance[] {
  return (globalThis as EChartsMockGlobal).__traycerEChartsMockInstances ?? [];
}
export function clearEChartsMockInstances(): void {
  (globalThis as EChartsMockGlobal).__traycerEChartsMockInstances = [];
}
vi.mock("echarts/core", () => ({
  use: (): void => undefined,
  init: (dom: HTMLElement) => {
    const record: EChartsMockInstance = {
      dom,
      options: [],
      setOptionOpts: [],
      disposed: false,
    };
    const target = globalThis as EChartsMockGlobal;
    target.__traycerEChartsMockInstances = [
      ...(target.__traycerEChartsMockInstances ?? []),
      record,
    ];
    return {
      setOption: (option: unknown, opts: unknown): void => {
        record.options.push(option);
        record.setOptionOpts.push(opts);
      },
      resize: (): void => undefined,
      dispose: (): void => {
        record.disposed = true;
      },
    };
  },
}));
vi.mock("echarts/charts", () => ({ LineChart: {} }));
vi.mock("echarts/components", () => ({
  GridComponent: {},
  TooltipComponent: {},
}));
vi.mock("echarts/renderers", () => ({ SVGRenderer: {} }));

// Brand-icon SVG `<title>` satisfies `getByText`. Ignore it so text queries match real content only.
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

// Reset this global every setup-file rerun so a suite cannot leak a controllable observer.
Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: MockResizeObserver,
});

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

// jsdom has no image decoder. Default `createImageBitmap` to a successful decode.
if (typeof globalThis.createImageBitmap === "undefined") {
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: (): Promise<{ close: () => void }> =>
      Promise.resolve({ close: () => undefined }),
  });
}

// jsdom does not implement Pointer Events. Stub pointer-capture and `scrollIntoView`.
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

// jsdom `getContext` throws. Stub null so canvas-bearing components can mount.
if (typeof HTMLCanvasElement !== "undefined") {
  const canvasProto = HTMLCanvasElement.prototype as HTMLCanvasElement & {
    getContext: () => null;
  };
  canvasProto.getContext = (): null => null;
}

// jsdom has no hit-testing. Stub `elementFromPoint` so mounting an editor does not throw.
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

// jsdom has no layout. Stub zero-rects so Tiptap auto-scroll-into-view is a no-op.
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
 * Fetch stub for AuthService `/api/v3/user` validation. Body must nest identity under `user`; a 2xx without a usable profile is treated as expired.
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
