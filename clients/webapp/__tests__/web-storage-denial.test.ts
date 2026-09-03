import { afterEach, describe, expect, it } from "vitest";
import { createSessionScratchpad } from "@traycer-clients/webapp/app-session-mint";
import {
  createLocalStorageCredentialStorage,
  WEB_TOKEN_STORE_KEY,
} from "@traycer-clients/webapp/web-token-store";

/**
 * The two platform seams the pre-render boot reads, against a browser that
 * refuses this origin storage.
 *
 * This is not hypothetical: a third-party context, "block all cookies" and
 * some private modes all raise `SecurityError` on the `window.localStorage` /
 * `window.sessionStorage` GETTER, before any method on it is called. Both
 * seams are built inside `bootstrap()`, whose promise is what mounts the app,
 * so a throw here does not surface as an error - it leaves the inline boot
 * surface up saying "Signing you in…" for as long as the tab is open.
 *
 * Every case installs the area it wants, working or throwing, rather than
 * trusting the test environment's own: this runner's `window.localStorage` is
 * an empty object with no methods, so a test that leaned on it would report
 * "signed out" for every seam under every condition, and could not tell the
 * guard from its absence.
 */
const restorers: (() => void)[] = [];

afterEach(() => {
  while (restorers.length > 0) restorers.pop()?.();
});

type AreaName = "localStorage" | "sessionStorage";

function replaceArea(name: AreaName, descriptor: PropertyDescriptor): void {
  const original = Object.getOwnPropertyDescriptor(window, name);
  Object.defineProperty(window, name, { ...descriptor, configurable: true });
  restorers.push(() => {
    if (original === undefined) {
      Reflect.deleteProperty(window, name);
      return;
    }
    Object.defineProperty(window, name, original);
  });
}

/** A real, working area, so the cases below have something to fail against. */
function installWorkingArea(name: AreaName): Storage {
  const values = new Map<string, string>();
  const area: Storage = {
    get length(): number {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  replaceArea(name, { value: area, writable: true });

  // The install has to be observable through the same expression the seams
  // evaluate, or a case that "passes" may be reading the runner's own stub.
  expect(window[name]).toBe(area);
  return area;
}

/**
 * Denies the area at the PROPERTY, which is where a browser denies it, and
 * proves the denial took.
 *
 * The proof is the point: whether the accessor being shadowed is an own
 * property or an inherited one is environment-dependent, so a helper that
 * only defines a property can silently shadow nothing - and every assertion
 * downstream would then be measuring the happy path.
 */
function denyArea(name: AreaName): void {
  replaceArea(name, {
    get(): Storage {
      throw new DOMException("storage denied for this origin", "SecurityError");
    },
  });

  expect(() => window[name]).toThrow(/denied/);
}

/** A present area whose every mutation is refused, as a full quota is. */
function refuseWrites(name: AreaName): void {
  const area = installWorkingArea(name);
  area.setItem = (): never => {
    throw new DOMException("quota exceeded", "QuotaExceededError");
  };
  area.removeItem = (): never => {
    throw new DOMException("quota exceeded", "QuotaExceededError");
  };

  expect(() => window[name].setItem("probe", "probe")).toThrow(/quota/);
}

describe("credential storage", () => {
  it("round-trips through a working area", () => {
    // The discriminating control. Every case below would also pass against a
    // seam that answered `null` and swallowed everything unconditionally.
    installWorkingArea("localStorage");
    const storage = createLocalStorageCredentialStorage();

    storage.write(WEB_TOKEN_STORE_KEY, '{"probe":true}');
    expect(storage.read(WEB_TOKEN_STORE_KEY)).toBe('{"probe":true}');

    storage.remove(WEB_TOKEN_STORE_KEY);
    expect(storage.read(WEB_TOKEN_STORE_KEY)).toBe(null);
  });

  it("reads signed-out and swallows both mutations on a denied origin", () => {
    denyArea("localStorage");

    const storage = createLocalStorageCredentialStorage();

    expect(storage.read(WEB_TOKEN_STORE_KEY)).toBe(null);
    expect(() => {
      storage.write(WEB_TOKEN_STORE_KEY, "{}");
    }).not.toThrow();
    expect(() => {
      storage.remove(WEB_TOKEN_STORE_KEY);
    }).not.toThrow();
    // No area means no sibling can write it, so there is no adoption edge to
    // arm - and arming one would install a listener nothing can ever fire.
    expect(() => {
      storage.onExternalChange(WEB_TOKEN_STORE_KEY, () => undefined);
    }).not.toThrow();
  });

  it("degrades a refused write to a session that does not persist", () => {
    refuseWrites("localStorage");
    const storage = createLocalStorageCredentialStorage();

    expect(() => {
      storage.write(WEB_TOKEN_STORE_KEY, "{}");
    }).not.toThrow();
    expect(() => {
      storage.remove(WEB_TOKEN_STORE_KEY);
    }).not.toThrow();
    // The bargain, stated: the write is lost, the boot is not.
    expect(storage.read(WEB_TOKEN_STORE_KEY)).toBe(null);
  });
});

describe("mint scratchpad", () => {
  it("round-trips through a working area", () => {
    installWorkingArea("sessionStorage");
    const scratchpad = createSessionScratchpad();

    scratchpad.write("probe", "1");
    expect(scratchpad.read("probe")).toBe("1");

    scratchpad.remove("probe");
    expect(scratchpad.read("probe")).toBe(null);
  });

  it("reads as no handoff in flight on a denied origin", () => {
    denyArea("sessionStorage");

    const scratchpad = createSessionScratchpad();

    // "Nothing was spent" is a state the mint already answers for - it is
    // what a first, unbounced visit looks like - so the tab falls through to
    // the device flow instead of failing the boot.
    expect(scratchpad.read("traycer.webapp.mint.navigations")).toBe(null);
    expect(() => {
      scratchpad.write("traycer.webapp.mint.navigations", "1");
    }).not.toThrow();
    expect(() => {
      scratchpad.remove("traycer.webapp.mint.navigations");
    }).not.toThrow();
  });
});
