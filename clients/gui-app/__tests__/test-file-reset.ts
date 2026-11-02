import { cleanup } from "@testing-library/react";
import { afterAll, vi } from "vitest";

/**
 * What one test file must not hand the next when `isolate: false` runs them in
 * one worker. The first setup file on purpose: it imports nothing of the app,
 * so the module graph is cold when it clears it, and the baseline below is the
 * environment as Vitest built it, before any shim.
 *
 * Without isolation Vitest keeps the worker's module graph and its mock
 * registry from file to file, so a `vi.mock` would not reach a module a
 * previous file already evaluated. Clearing both at the start of each file is
 * what an isolated worker does per file, and it is why a store needs no reset
 * of its own here: its module is evaluated again. Modules Node loaded natively
 * (`node_modules`) stay cached, and that is the saving.
 */

interface EvaluatedModuleNode {
  promise: unknown;
  exports: unknown;
  evaluated: boolean;
  mockedExports: unknown;
  readonly importers: Set<string>;
}

interface MockerLike {
  reset(): void;
  readonly evaluatedModules: {
    readonly idToModuleMap: Map<string, EvaluatedModuleNode>;
  };
}

interface TrackedListener {
  readonly target: EventTarget;
  readonly type: string;
  readonly listener: EventListenerOrEventListenerObject;
  readonly options: boolean | EventListenerOptions | undefined;
}

interface OwnProperties {
  readonly owner: object;
  readonly descriptors: Map<PropertyKey, PropertyDescriptor>;
}

interface WorkerBaseline {
  properties: readonly OwnProperties[];
  readonly timers: Set<number>;
  readonly frames: Set<number>;
  readonly listeners: TrackedListener[];
  /** A global's value where Vitest keeps it behind an accessor: `window.innerWidth = 400` changes no descriptor. */
  globalValues: ReadonlyMap<string, unknown>;
  focusedInThisFile: boolean;
}

const BASELINE_KEY = Symbol.for("traycer.test-file-reset.baseline");
const VITEST_GLOBAL = /^__(?:vitest|vi_)/;

type BaselineHolder = { [BASELINE_KEY]?: WorkerBaseline };

function readOwnProperties(owner: object): OwnProperties {
  const descriptors = new Map<PropertyKey, PropertyDescriptor>();
  for (const key of Reflect.ownKeys(owner)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(owner, key);
    if (descriptor !== undefined) descriptors.set(key, descriptor);
  }
  return { owner, descriptors };
}

/** `globalThis`, the long-lived nodes, and the prototype of every constructor (`HTMLElement`, `Range`, ...). */
function readPatchableOwners(): readonly OwnProperties[] {
  const owners: OwnProperties[] = [readOwnProperties(globalThis)];
  // The long-lived nodes carry expandos beside their listeners: React's
  // `_reactListening*` marker says "my delegated listeners are already here", so
  // removing the listeners and keeping the marker leaves every later portal deaf.
  if (typeof document !== "undefined") {
    owners.push(readOwnProperties(document));
    owners.push(readOwnProperties(document.documentElement));
    owners.push(readOwnProperties(document.body));
    owners.push(readOwnProperties(navigator));
    owners.push(readOwnProperties(window.screen));
  }
  // Vitest defines jsdom's classes as accessors on the global, hence the read.
  const seen = new Set<object>();
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    if (!/^[A-Z]/.test(key)) continue;
    const value: unknown = Reflect.get(globalThis, key);
    if (typeof value !== "function") continue;
    const prototype: unknown = Reflect.get(value, "prototype");
    if (typeof prototype !== "object" || prototype === null) continue;
    if (seen.has(prototype)) continue;
    seen.add(prototype);
    owners.push(readOwnProperties(prototype));
  }
  return owners;
}

function readAccessorGlobals(): ReadonlyMap<string, unknown> {
  const values = new Map<string, unknown>();
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(globalThis, key);
    if (descriptor?.set === undefined || descriptor.get === undefined) continue;
    values.set(key, Reflect.get(globalThis, key));
  }
  return values;
}

function sameDescriptor(a: PropertyDescriptor, b: PropertyDescriptor): boolean {
  return (
    a.value === b.value &&
    a.get === b.get &&
    a.set === b.set &&
    a.writable === b.writable &&
    a.enumerable === b.enumerable &&
    a.configurable === b.configurable
  );
}

function restoreOwnProperties({ owner, descriptors }: OwnProperties): void {
  for (const key of Reflect.ownKeys(owner)) {
    const baseline = descriptors.get(key);
    if (baseline !== undefined) continue;
    if (typeof key === "string" && VITEST_GLOBAL.test(key)) continue;
    if (key === BASELINE_KEY) continue;
    Reflect.deleteProperty(owner, key);
  }
  for (const [key, baseline] of descriptors) {
    const current = Reflect.getOwnPropertyDescriptor(owner, key);
    if (current !== undefined && sameDescriptor(current, baseline)) continue;
    // A non-configurable property (`window.location`) cannot have been replaced.
    if (current !== undefined && current.configurable !== true) continue;
    Reflect.defineProperty(owner, key, baseline);
  }
}

/** Timers and frames a file left running would otherwise fire inside the next file. */
function trackTimers(baseline: WorkerBaseline): void {
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  globalThis.setTimeout = Object.defineProperties(
    (
      handler: TimerHandler,
      timeout: number | undefined,
      ...args: unknown[]
    ) => {
      const timer = realSetTimeout(handler, timeout, ...args);
      baseline.timers.add(timer);
      return timer;
    },
    Object.getOwnPropertyDescriptors(realSetTimeout),
  ) as typeof setTimeout;
  globalThis.setInterval = Object.defineProperties(
    (
      handler: TimerHandler,
      timeout: number | undefined,
      ...args: unknown[]
    ) => {
      const timer = realSetInterval(handler, timeout, ...args);
      baseline.timers.add(timer);
      return timer;
    },
    Object.getOwnPropertyDescriptors(realSetInterval),
  ) as typeof setInterval;
  if (typeof globalThis.requestAnimationFrame === "function") {
    const realRequestFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => {
      const frame = realRequestFrame(callback);
      baseline.frames.add(frame);
      return frame;
    };
  }
}

/**
 * Only the long-lived targets: a listener on a removed element dies with it.
 * Vitest's `window` is the Node global with jsdom's functions bound onto it, so
 * `window.addEventListener` reaches the prototype with jsdom's own window as
 * `this` when it reaches it at all, and is patched separately.
 */
function trackListeners(baseline: WorkerBaseline): void {
  if (typeof document === "undefined") return;
  const isLongLived = (target: EventTarget): boolean =>
    target === document.defaultView ||
    target === document ||
    target === document.documentElement ||
    target === document.body;
  const prototype = EventTarget.prototype;
  const realAdd = Reflect.get(prototype, "addEventListener");
  prototype.addEventListener = function addEventListener(
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options: boolean | AddEventListenerOptions | undefined,
  ): void {
    if (listener !== null && isLongLived(this)) {
      baseline.listeners.push({ target: this, type, listener, options });
    }
    realAdd.call(this, type, listener, options);
  };
  const realWindowAdd = globalThis.addEventListener;
  globalThis.addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options: boolean | AddEventListenerOptions | undefined,
  ): void => {
    baseline.listeners.push({ target: globalThis, type, listener, options });
    realWindowAdd(type, listener, options);
  };
}

/**
 * jsdom answers `hasFocus()` false until the first focus and true for the rest
 * of the document's life, blur included, and nothing public clears that. So it
 * is scoped to the file: a file whose window never took focus sees false, as it
 * does in a worker of its own.
 */
function scopeHasFocusToFile(baseline: WorkerBaseline): void {
  if (typeof document === "undefined") return;
  const prototype = Document.prototype;
  const realHasFocus = Reflect.get(prototype, "hasFocus");
  prototype.hasFocus = function hasFocus(this: Document): boolean {
    return baseline.focusedInThisFile && realHasFocus.call(this);
  };
  document.addEventListener(
    "focus",
    (event) => {
      // Trusted: jsdom's own focus steps, not a test's `fireEvent.focus`.
      if (event.isTrusted) baseline.focusedInThisFile = true;
    },
    true,
  );
}

function clearAttributes(element: Element): void {
  for (const name of element.getAttributeNames()) {
    element.removeAttribute(name);
  }
}

function resetDocument(): void {
  if (typeof document === "undefined") return;
  document.body.replaceChildren();
  document.head.replaceChildren();
  clearAttributes(document.documentElement);
  clearAttributes(document.body);
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  window.getSelection()?.removeAllRanges();
  for (const cookie of document.cookie.split("; ")) {
    const name = cookie.split("=", 1)[0];
    if (name !== "") {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    }
  }
}

function readBaseline(): WorkerBaseline {
  const holder = globalThis as BaselineHolder;
  const existing = holder[BASELINE_KEY];
  if (existing !== undefined) return existing;
  const created: WorkerBaseline = {
    properties: [],
    timers: new Set(),
    frames: new Set(),
    listeners: [],
    globalValues: new Map(),
    focusedInThisFile: false,
  };
  Object.defineProperty(holder, BASELINE_KEY, { value: created });
  // Before the tracking: this listener is the worker's, not a file's to remove.
  scopeHasFocusToFile(created);
  trackTimers(created);
  trackListeners(created);
  created.properties = readPatchableOwners();
  created.globalValues = readAccessorGlobals();
  return created;
}

/**
 * `vi.resetModules()` keeps the `mock:` nodes, and a mock node answers from its
 * cached exports, so the next file's `vi.mock` factory for the same path would
 * never run. An isolated worker clears those too.
 */
function resetModuleGraph(): void {
  const mocker = (globalThis as { __vitest_mocker__?: MockerLike })
    .__vitest_mocker__;
  if (mocker === undefined) {
    throw new Error(
      "test-file-reset: Vitest no longer exposes __vitest_mocker__, so a file's vi.mock would leak into the next",
    );
  }
  mocker.reset();
  vi.resetModules();
  for (const [id, node] of mocker.evaluatedModules.idToModuleMap) {
    if (!id.startsWith("mock:")) continue;
    node.promise = undefined;
    node.exports = undefined;
    node.mockedExports = undefined;
    node.evaluated = false;
    node.importers.clear();
  }
}

const baseline = readBaseline();
// Again at the start of a file, not only at the end of the last one: Vitest's
// own `vi.restoreAllMocks()` runs after every hook, and a spy taken over a fake
// timer puts that fake back. A leftover fake `clearTimeout` throws on every real
// timer, and every `waitFor` of the next file then hangs instead of settling.
restoreGlobalState();
resetModuleGraph();

function restoreGlobalState(): void {
  for (const properties of baseline.properties) {
    restoreOwnProperties(properties);
  }
  for (const [key, value] of baseline.globalValues) {
    if (Reflect.get(globalThis, key) !== value) {
      Reflect.set(globalThis, key, value);
    }
  }
}

/** Everything one file leaves that the next must not see, in dependency order. */
export function resetTestFileState(): void {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanup();
  for (const timer of baseline.timers) clearTimeout(timer);
  baseline.timers.clear();
  if (typeof globalThis.cancelAnimationFrame === "function") {
    for (const frame of baseline.frames) globalThis.cancelAnimationFrame(frame);
  }
  baseline.frames.clear();
  for (const { target, type, listener, options } of baseline.listeners) {
    target.removeEventListener(type, listener, options);
  }
  baseline.listeners.length = 0;
  restoreGlobalState();
  resetDocument();
  baseline.focusedInThisFile = false;
}

afterAll(resetTestFileState);
