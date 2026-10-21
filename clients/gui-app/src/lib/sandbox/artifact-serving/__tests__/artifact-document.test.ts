import { JSDOM, type DOMWindow } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForwardedShortcut } from "../../forwarded-shortcuts";
import type { SandboxTheme } from "../../theme-map";
import {
  artifactBasePolicy,
  buildArtifactDocument,
  type ArtifactDocumentOptions,
} from "../artifact-document";

// The loader is a classic script with no exports, run for its effect: it
// waits, in a jsdom window that is its own parent, for a resource message.
// A variable specifier keeps the type-checker from treating it as a module.
const LOADER = "../../sandbox-loader";
// Every fixture below is served as if by desktop; the mobile and Android
// cases (their own policy source shape) get their own tests further down.
const POLICY_SOURCE = "traycer-sandbox:";
const BASE_META = `<meta http-equiv="Content-Security-Policy" content="${artifactBasePolicy(POLICY_SOURCE)}">`;

interface Delivery {
  readonly kind: "page" | "wireframe" | "app";
  readonly html: string;
  readonly csp: string | null;
  readonly nonce: string;
  readonly theme: SandboxTheme;
  readonly shortcuts: readonly ForwardedShortcut[];
}

function resourceMessage(delivery: Delivery) {
  return {
    jsonrpc: "2.0",
    method: "ui/notifications/sandbox-resource-ready",
    params: {
      html: delivery.html,
      kind: delivery.kind,
      csp: delivery.csp,
      nonce: delivery.nonce,
      bootstrap: {
        theme: {
          appliesToRoot: delivery.theme.appliesToRoot,
          colorScheme: delivery.theme.colorScheme,
          background: delivery.theme.background,
          variables: delivery.theme.variables,
        },
        forwardedShortcuts: delivery.shortcuts,
      },
    },
  };
}

/** The document the live loader writes for a delivered resource, as one string. */
async function loaderDocument(delivery: Delivery): Promise<string> {
  vi.resetModules();
  vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
  await import(LOADER);

  const written: string[] = [];
  vi.spyOn(document, "open").mockImplementation(() => window);
  vi.spyOn(document, "close").mockImplementation(() => undefined);
  vi.spyOn(document, "write").mockImplementation((...chunks: string[]) => {
    written.push(...chunks);
  });
  window.dispatchEvent(
    new MessageEvent("message", {
      data: resourceMessage(delivery),
      source: window.parent,
    }),
  );
  return written.join("");
}

function documentOptionsOf(delivery: Delivery): ArtifactDocumentOptions {
  return {
    policySource: POLICY_SOURCE,
    csp: delivery.csp,
    nonce: delivery.nonce,
    theme: delivery.theme,
    shortcuts: delivery.shortcuts,
  };
}

const bootstrapWindows: DOMWindow[] = [];

afterEach(() => {
  for (const window of bootstrapWindows.splice(0)) window.close();
  vi.restoreAllMocks();
});

const CASES: readonly [string, Delivery][] = [
  [
    "a page, with a source doctype, no per-page CSP",
    {
      kind: "page",
      html: "<!doctype html><p>hi</p>",
      csp: null,
      nonce: "n-1",
      theme: {
        appliesToRoot: true,
        colorScheme: "dark",
        background: "rgb(1, 2, 3)",
        variables: { "--color-text-primary": "red" },
      },
      shortcuts: [
        { code: "KeyK", ctrl: false, meta: true, alt: false, shift: false },
      ],
    },
  ],
  [
    "an app, appliesToRoot off, a per-page CSP needing attribute escaping",
    {
      kind: "app",
      html: "<p>app body</p>",
      csp: `default-src 'self'; script-src 'nonce-"quoted"' & more`,
      nonce: "n-2",
      theme: {
        appliesToRoot: false,
        colorScheme: "light",
        background: null,
        variables: {},
      },
      shortcuts: [],
    },
  ],
  [
    "a theme value that must be escaped out of the style element",
    {
      kind: "page",
      html: "<p>styled</p>",
      csp: null,
      nonce: "n-3",
      theme: {
        appliesToRoot: true,
        colorScheme: "dark",
        background: "red</style><script>bad</script>",
        variables: {},
      },
      shortcuts: [],
    },
  ],
  [
    "html whose own body contains a script-closing sequence",
    {
      kind: "page",
      html: "<p>before</script><script>after</p>",
      csp: null,
      nonce: "n-4",
      theme: {
        appliesToRoot: true,
        colorScheme: "light",
        background: null,
        variables: { "--x": "1" },
      },
      shortcuts: [],
    },
  ],
];

describe("buildArtifactDocument / sandbox loader parity", () => {
  it.each(CASES)(
    "matches the live loader's own document, base policy aside, for: %s",
    async (_label, delivery) => {
      const fromLoader = await loaderDocument(delivery);
      const composed = buildArtifactDocument(
        delivery.html,
        documentOptionsOf(delivery),
      );

      expect(composed.startsWith(`<!doctype html>${BASE_META}`)).toBe(true);
      // The loader never gains the base policy meta (it inherits the sandbox
      // origin's own base policy). A served document is a page of its
      // artifact, so its bootstrap carries the "found" role and follows
      // sibling html links; the loader's inline document has no pages, so it
      // carries null. With those two deliberate differences taken out, the
      // composed document must reproduce the loader's output byte for byte.
      expect(
        composed
          .replace(BASE_META, "")
          .replace('"artifactPage":"found"', '"artifactPage":null'),
      ).toBe(fromLoader);
    },
  );

  it.each(CASES)(
    "puts the base policy meta first, ahead of any per-page policy, for: %s",
    (_label, delivery) => {
      const composed = buildArtifactDocument(
        delivery.html,
        documentOptionsOf(delivery),
      );
      const doc = new DOMParser().parseFromString(composed, "text/html");
      const policies = [
        ...doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]'),
      ];

      expect(policies[0].getAttribute("content")).toBe(
        artifactBasePolicy(POLICY_SOURCE),
      );
      if (delivery.csp === null) {
        expect(policies).toHaveLength(1);
      } else {
        expect(policies).toHaveLength(2);
        expect(policies[1].getAttribute("content")).toBe(delivery.csp);
        expect(
          policies[0].compareDocumentPosition(policies[1]) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    },
  );
});

describe("artifactBasePolicy, by policy source", () => {
  it("names the given colon-bearing source literally in default-src, same as desktop's own", () => {
    expect(artifactBasePolicy("traycer-artifact:")).toBe(
      "default-src * traycer-artifact: data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'; base-uri 'none'",
    );
  });

  it("adds no extra source at all for a null policy source - Android's https origin needs none", () => {
    expect(artifactBasePolicy(null)).toBe(
      "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'; base-uri 'none'",
    );
  });

  it("keeps form-action and base-uri locked to 'none' for the mobile source too", () => {
    const policy = artifactBasePolicy("traycer-artifact:");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("base-uri 'none'");
  });

  it("keeps form-action and base-uri locked to 'none' for the null (Android) source too", () => {
    const policy = artifactBasePolicy(null);
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("base-uri 'none'");
  });

  it("rejects a non-null source that is not a valid, colon-terminated URI scheme token", () => {
    expect(() => artifactBasePolicy("not valid:")).toThrow(
      "Invalid artifact policy source",
    );
    expect(() => artifactBasePolicy("traycer-artifact")).toThrow(
      "Invalid artifact policy source",
    );
  });

  it("composes the mobile source into the actual base meta a served document carries", () => {
    const delivery: Delivery = {
      kind: "page",
      html: "<!doctype html><p>hi</p>",
      csp: null,
      nonce: "n-mobile",
      theme: {
        appliesToRoot: true,
        colorScheme: "dark",
        background: null,
        variables: {},
      },
      shortcuts: [],
    };
    const composed = buildArtifactDocument(delivery.html, {
      ...documentOptionsOf(delivery),
      policySource: "traycer-artifact:",
    });
    const doc = new DOMParser().parseFromString(composed, "text/html");
    const [basePolicy] = [
      ...doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]'),
    ];
    expect(basePolicy.getAttribute("content")).toBe(
      artifactBasePolicy("traycer-artifact:"),
    );
    expect(basePolicy.getAttribute("content")).toContain("form-action 'none'");
    expect(basePolicy.getAttribute("content")).toContain("base-uri 'none'");
  });

  it("composes a null (Android) source into the actual base meta, with no extra source token", () => {
    const delivery: Delivery = {
      kind: "page",
      html: "<!doctype html><p>hi</p>",
      csp: null,
      nonce: "n-android",
      theme: {
        appliesToRoot: true,
        colorScheme: "dark",
        background: null,
        variables: {},
      },
      shortcuts: [],
    };
    const composed = buildArtifactDocument(delivery.html, {
      ...documentOptionsOf(delivery),
      policySource: null,
    });
    const doc = new DOMParser().parseFromString(composed, "text/html");
    const [basePolicy] = [
      ...doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]'),
    ];
    expect(basePolicy.getAttribute("content")).toBe(artifactBasePolicy(null));
  });
});

interface CapturedMessage {
  readonly jsonrpc: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** The single inline `<script>` a composed document carries, as raw text. */
function extractBootstrapScript(composedHtml: string): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(composedHtml);
  if (match === null) {
    throw new Error(
      "expected an inline bootstrap script in the composed document",
    );
  }
  return match[1];
}

/**
 * Runs a composed document's real, generated bootstrap script in its own
 * isolated jsdom window - never the shared one `loaderDocument` above
 * drives - so this test's listeners (none of them `{once: true}`) cannot
 * leak into any other test.
 */
function runBootstrapInIsolatedWindow(composedHtml: string): {
  readonly window: DOMWindow;
  readonly messages: CapturedMessage[];
} {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "dangerously",
    url: "https://sandbox.test/",
  });
  const window = dom.window;
  bootstrapWindows.push(window);
  // jsdom implements no ResizeObserver; the bootstrap only needs one that
  // does not throw when constructed and observed.
  window.ResizeObserver = class {
    observe(): void {
      return;
    }
  };
  const messages: CapturedMessage[] = [];
  window.postMessage = (message: CapturedMessage) => {
    messages.push(message);
  };
  window.eval(extractBootstrapScript(composedHtml));
  return { window, messages };
}

describe("sandbox bootstrap load ordering", () => {
  it("sends document-ready with the nonce before a forced size-changed, even though the size has not changed", () => {
    const options: ArtifactDocumentOptions = {
      policySource: POLICY_SOURCE,
      csp: null,
      nonce: "n-document-ready",
      shortcuts: [],
      theme: {
        appliesToRoot: true,
        colorScheme: "dark",
        background: null,
        variables: {},
      },
    };
    const composed = buildArtifactDocument("<p>hi</p>", options);
    const { window, messages } = runBootstrapInIsolatedWindow(composed);

    // Seed a measured size the way the real page does, at DOMContentLoaded.
    window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
    const seeded = messages.find(
      (message) => message.method === "ui/notifications/size-changed",
    );
    if (seeded === undefined) {
      throw new Error(
        "expected a size-changed notification after DOMContentLoaded",
      );
    }
    const seededHeight = seeded.params.height;

    messages.length = 0;
    window.dispatchEvent(new window.Event("load"));

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      jsonrpc: "2.0",
      method: "traycer/notifications/document-ready",
      // The address is what the host matches a page navigation against.
      params: {
        nonce: "n-document-ready",
        height: seededHeight,
        url: "https://sandbox.test/",
      },
    });
    // A port dropped any size report sent before document-ready proved the
    // nonce; the bootstrap must still get one through once it is proven,
    // even though nothing actually changed since DOMContentLoaded.
    expect(messages[1]).toMatchObject({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: seededHeight },
    });
  });
});
