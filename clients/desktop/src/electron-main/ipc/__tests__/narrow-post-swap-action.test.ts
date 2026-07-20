import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `narrowPostSwapAction` is the CLI → renderer projection for the
// `serviceLifecycle.postSwapAction` field. It must:
//   - round-trip every known union member,
//   - silently collapse `undefined` to `"none"` (the legitimate
//     absent-field case),
//   - log.warn for any unknown string before collapsing to `"none"` so
//     CLI/desktop version skew shows up in support bundles instead of
//     being lost.

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp"),
    isPackaged: false,
    getAppPath: vi.fn(() => "/tmp"),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info", resolvePathFn: vi.fn() } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  transports: { file: { level: "info", resolvePathFn: vi.fn() } },
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("narrowPostSwapAction", () => {
  it("round-trips every known union member", async () => {
    const { narrowPostSwapAction } = await import("../host-management-ipc");
    expect(narrowPostSwapAction("install")).toBe("install");
    expect(narrowPostSwapAction("restart")).toBe("restart");
    expect(narrowPostSwapAction("start")).toBe("start");
    expect(narrowPostSwapAction("none")).toBe("none");
  });

  it("returns 'none' for undefined without warning (legitimate absent field)", async () => {
    const { log } = await import("../../app/logger");
    const warnMock = vi.mocked(log.warn);
    warnMock.mockClear();
    const { narrowPostSwapAction } = await import("../host-management-ipc");
    expect(narrowPostSwapAction(undefined)).toBe("none");
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("returns 'none' for an explicit \"none\" without warning - routine for externally-managed labels, not version skew", async () => {
    const { log } = await import("../../app/logger");
    const warnMock = vi.mocked(log.warn);
    warnMock.mockClear();
    const { narrowPostSwapAction } = await import("../host-management-ipc");
    expect(narrowPostSwapAction("none")).toBe("none");
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("collapses unknown string to 'none' and emits a warn (surfaces CLI/desktop drift)", async () => {
    const { log } = await import("../../app/logger");
    const warnMock = vi.mocked(log.warn);
    warnMock.mockClear();
    const { narrowPostSwapAction } = await import("../host-management-ipc");
    expect(narrowPostSwapAction("reload")).toBe("none");
    expect(warnMock).toHaveBeenCalledTimes(1);
    const [message, payload] = warnMock.mock.calls[0];
    expect(String(message)).toMatch(/unknown postSwapAction/i);
    // Raw value must be included so support bundles capture the drift.
    expect(payload).toMatchObject({ raw: "reload" });
  });

  it("collapses non-string raw values (e.g. number, object) to 'none' and warns", async () => {
    const { log } = await import("../../app/logger");
    const warnMock = vi.mocked(log.warn);
    warnMock.mockClear();
    const { narrowPostSwapAction } = await import("../host-management-ipc");
    expect(narrowPostSwapAction(42)).toBe("none");
    expect(narrowPostSwapAction({ kind: "restart" })).toBe("none");
    expect(narrowPostSwapAction(null)).toBe("none");
    expect(warnMock).toHaveBeenCalledTimes(3);
  });
});
