import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const userDataDir = "/tmp/traycer-capture-test";
const showItemInFolder = vi.fn();

vi.mock("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: {
    showItemInFolder: (path: string) => {
      showItemInFolder(path);
    },
  },
}));

const {
  browserCaptureDir,
  browserCaptureFileName,
  isInsideCaptureDir,
  revealBrowserCapture,
} = await import("../browser-capture-store");

const bytes = Uint8Array.from([1, 2, 3, 4]);

beforeEach(() => {
  showItemInFolder.mockClear();
});

describe("browserCaptureFileName", () => {
  it("mints a filename-safe, sortable name with no page-chosen text in it", () => {
    const name = browserCaptureFileName({
      bytes,
      capturedAt: Date.UTC(2026, 8, 11, 4, 5, 6),
    });
    expect(name).toMatch(/^page-20260911-040506-[0-9a-f]{12}-[0-9a-f]{8}\.png$/);
  });

  it("keeps colons out, so the name does not differ per platform", () => {
    const name = browserCaptureFileName({ bytes, capturedAt: Date.now() });
    expect(name).not.toContain(":");
  });

  it("names every save separately, even for the same bytes in the same second", () => {
    // Two presses of the button are two records. Time-to-the-second plus a
    // content digest collided for a still page, and the second write replaced
    // the first while the user was told a path both times.
    const at = Date.UTC(2026, 0, 1);
    expect(browserCaptureFileName({ bytes, capturedAt: at })).not.toBe(
      browserCaptureFileName({ bytes, capturedAt: at }),
    );
  });

  it("still carries the content digest, so identical bytes share that segment", () => {
    const at = Date.UTC(2026, 0, 1);
    const digestOf = (name: string): string => name.split("-")[3] ?? "";
    expect(
      digestOf(browserCaptureFileName({ bytes, capturedAt: at })),
    ).toBe(
      digestOf(
        browserCaptureFileName({
          bytes: Uint8Array.from([1, 2, 3, 4]),
          capturedAt: at,
        }),
      ),
    );
    expect(
      digestOf(browserCaptureFileName({ bytes, capturedAt: at })),
    ).not.toBe(
      digestOf(
        browserCaptureFileName({ bytes: Uint8Array.from([9]), capturedAt: at }),
      ),
    );
  });

  it("falls back to now rather than emitting an invalid stamp", () => {
    const name = browserCaptureFileName({ bytes, capturedAt: Number.NaN });
    expect(name).toMatch(/^page-\d{8}-\d{6}-[0-9a-f]{12}-[0-9a-f]{8}\.png$/);
  });
});

describe("isInsideCaptureDir", () => {
  it("accepts a file main itself would have written", () => {
    expect(isInsideCaptureDir(join(browserCaptureDir(), "page-x.png"))).toBe(
      true,
    );
  });

  it("refuses a traversal out of the directory", () => {
    expect(
      isInsideCaptureDir(join(browserCaptureDir(), "..", "..", "secrets.txt")),
    ).toBe(false);
  });

  it("refuses a sibling whose name merely starts the same", () => {
    // Without the separator check, `browser-captures-evil` passes as a child.
    expect(isInsideCaptureDir(`${browserCaptureDir()}-evil/x.png`)).toBe(false);
  });

  it("refuses an unrelated absolute path", () => {
    expect(isInsideCaptureDir("/etc/passwd")).toBe(false);
  });

  it("refuses the directory itself, which is not a file to reveal", () => {
    expect(isInsideCaptureDir(browserCaptureDir())).toBe(false);
  });
});

describe("revealBrowserCapture", () => {
  it("reveals a path inside the directory main owns", () => {
    const path = join(browserCaptureDir(), "page-y.png");
    expect(revealBrowserCapture(path)).toBe(true);
    expect(showItemInFolder).toHaveBeenCalledWith(path);
  });

  it("refuses anything else without touching the shell", () => {
    expect(revealBrowserCapture("/etc/passwd")).toBe(false);
    expect(showItemInFolder).not.toHaveBeenCalled();
  });
});
