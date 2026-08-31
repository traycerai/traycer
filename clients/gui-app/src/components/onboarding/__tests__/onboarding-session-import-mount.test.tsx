/// <reference types="node" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionImportSelection } from "@traycer/protocol/host/session-import/candidate";
import {
  setSessionImportStartHandle,
  startSessionImportRun,
} from "@/components/session-import/session-import-run-handle";

/**
 * The tour renders through `RootSurface`'s standalone branch - `StandaloneShell`
 * + `OnboardingPage` - and never through `AppShell`. While the run controller
 * was mounted inside `AppShell`, the onboarding act's Import button called a
 * handle nobody had registered, so the import silently never started.
 *
 * The mount now sits above the router, where no component can render it in
 * isolation, so the topology is asserted against the two files that decide it
 * and the handle is exercised at both ends.
 */
const SRC_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

function sourceOf(relativePath: string): string {
  return readFileSync(path.join(SRC_DIR, relativePath), "utf8");
}

const SELECTION: SessionImportSelection = {
  harness: "claude",
  nativeSessionId: "native-1",
};

describe("SessionImportRunController mount point", () => {
  it("mounts under HostStreamProvider, which every routed shell renders beneath", () => {
    const source = sourceOf("traycer-app.tsx");
    const providerOpensAt = source.indexOf("<HostStreamProvider>");
    const providerClosesAt = source.indexOf("</HostStreamProvider>");
    const mountAt = source.indexOf("<SessionImportRunController />");
    // The routed tree: `AppShell` for the signed-in app, `StandaloneShell` +
    // `OnboardingPage` for the tour. Both inherit whatever sits above it here.
    const routedTreeAt = source.indexOf("<TraycerAppRuntimeSurface");

    expect(providerOpensAt).toBeGreaterThanOrEqual(0);
    expect(mountAt).toBeGreaterThan(providerOpensAt);
    expect(mountAt).toBeLessThan(providerClosesAt);
    expect(routedTreeAt).toBeGreaterThan(providerOpensAt);
    expect(routedTreeAt).toBeLessThan(providerClosesAt);
  });

  it("is not mounted inside AppShell, which the onboarding surface never renders", () => {
    expect(sourceOf("components/layout/app-shell.tsx")).not.toContain(
      "SessionImportRunController",
    );
    const rootSurface = sourceOf("routes/root-route-components.tsx");
    expect(rootSurface).toContain("<OnboardingPage");
    expect(rootSurface).not.toContain("SessionImportRunController");
  });
});

describe("startSessionImportRun", () => {
  afterEach(() => {
    setSessionImportStartHandle(null);
    vi.restoreAllMocks();
  });

  it("forwards the submission to the mounted controller", () => {
    const start = vi.fn();
    setSessionImportStartHandle({ start });
    const request = {
      selections: [SELECTION],
      titles: new Map([["claude:native-1", "My Session"]]),
    };

    startSessionImportRun(request);

    expect(start).toHaveBeenCalledWith(request);
  });

  it("logs an error rather than swallowing the click when no controller is mounted", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    startSessionImportRun({ selections: [SELECTION], titles: new Map() });

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain(
      "no run controller mounted",
    );
  });
});
