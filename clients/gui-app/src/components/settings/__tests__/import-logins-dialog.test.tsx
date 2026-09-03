import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportLoginsDialog } from "@/components/settings/import-logins-dialog";
import { ImportLoginsFlow } from "@/components/settings/import-logins-flow";
import { PLAIN_IMPORT_LOGINS_FRAME } from "@/components/settings/import-logins-frame";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import type {
  LoginImportBlocked,
  LoginImportRequest,
  LoginImportResult,
  LoginImportScan,
  LoginImportSource,
} from "@traycer-clients/shared/platform/browser-view";

/**
 * Settings › Browser › Saved logins › "Import logins from another browser".
 * Drives the three-step dialog against a bridge subclass so each step's
 * bridge call (list / scan / import) is asserted at its own seam. The push to
 * the hosts is main's and rides back on the import result, so what is asserted
 * here is that the Done step reports the `notifiedHosts` it was handed.
 */

const openFullDiskAccessMocks = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock("@/hooks/runner/use-open-full-disk-access-settings-mutation", () => ({
  useRunnerOpenFullDiskAccessSettings: () => ({
    mutate: openFullDiskAccessMocks.mutate,
    isPending: false,
  }),
}));

class TestBridge extends FakeBrowserViewBridge {
  sources: readonly LoginImportSource[] = [];
  scanBySourceId = new Map<string, LoginImportScan>();
  importResult: LoginImportResult = {
    status: "imported",
    importedSites: 0,
    importedCookies: 0,
    replacedSites: 0,
    skippedInvalid: 0,
    notifiedHosts: 0,
  };
  readonly importCalls: LoginImportRequest[] = [];
  /**
   * When true, `importLogins` never settles on its own - the test settles it
   * later via `releaseImport`, so it can assert the pending UI first.
   */
  deferImport = false;
  releaseImport: (() => void) | null = null;
  /** Answers to successive `pickLoginImportFile()` calls, in order. */
  pickResults: Array<LoginImportSource | null> = [];
  private pickLoginImportFileCalls = 0;

  override listLoginImportSources(): Promise<readonly LoginImportSource[]> {
    return Promise.resolve(this.sources);
  }

  override pickLoginImportFile(): Promise<LoginImportSource | null> {
    const index = this.pickLoginImportFileCalls;
    this.pickLoginImportFileCalls += 1;
    return Promise.resolve(this.pickResults[index] ?? null);
  }

  override scanLoginImportSource(sourceId: string): Promise<LoginImportScan> {
    const scan = this.scanBySourceId.get(sourceId);
    if (scan === undefined) {
      throw new Error(`no scan configured for ${sourceId}`);
    }
    return Promise.resolve(scan);
  }

  override importLogins(input: LoginImportRequest): Promise<LoginImportResult> {
    this.importCalls.push(input);
    if (this.deferImport) {
      return new Promise<LoginImportResult>((resolve) => {
        this.releaseImport = () => {
          resolve(this.importResult);
        };
      });
    }
    return Promise.resolve(this.importResult);
  }
}

function source(overrides: Partial<LoginImportSource>): LoginImportSource {
  return {
    id: "source-1",
    browser: "chrome",
    profileLabel: "Default",
    lastUsedAt: null,
    ...overrides,
  };
}

function scan(overrides: Partial<LoginImportScan>): LoginImportScan {
  return {
    sourceId: "source-1",
    scanId: "scan-1",
    sites: [],
    excluded: [],
    protectedCookieCount: 0,
    partitionedCookieCount: 0,
    unreadableCookieCount: 0,
    unlock: null,
    blocked: null,
    ...overrides,
  };
}

function renderDialog(bridge: TestBridge): {
  readonly onOpenChange: ReturnType<typeof vi.fn>;
  readonly client: QueryClient;
} {
  const onOpenChange = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ImportLoginsDialog
        open
        onOpenChange={onOpenChange}
        browserView={bridge}
      />
    </QueryClientProvider>,
  );
  return { onOpenChange, client };
}

async function pickSource(name: RegExp | string): Promise<void> {
  const button = await screen.findByRole("button", { name });
  fireEvent.click(button);
}

/** The Choose step's confirm, by the label the user reads: "Import N sites". */
const IMPORT_CONFIRM_NAME = /^Import \d+ sites?$/u;

function importConfirmButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", {
    name: IMPORT_CONFIRM_NAME,
  });
}

afterEach(() => {
  cleanup();
  openFullDiskAccessMocks.mutate.mockReset();
});

describe("<ImportLoginsDialog /> pick step", () => {
  it("lists sources with last-used copy and an import-from-file entry", async () => {
    const bridge = new TestBridge();
    bridge.sources = [
      source({
        id: "source-1",
        browser: "chrome",
        profileLabel: "Default",
        lastUsedAt: Date.now() - 60 * 60 * 1000,
      }),
    ];
    renderDialog(bridge);

    await waitFor(() => {
      expect(screen.getByText("Google Chrome")).not.toBeNull();
    });
    expect(screen.getByText("Default")).not.toBeNull();
    expect(screen.getByText("1h ago")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /Import from a file…/ }),
    ).not.toBeNull();
  });

  it("groups profiles under one heading per browser, most recently used browser first", async () => {
    const bridge = new TestBridge();
    const hour = 60 * 60 * 1000;
    bridge.sources = [
      source({
        id: "safari",
        browser: "safari",
        profileLabel: "Safari",
        lastUsedAt: Date.now() - hour,
      }),
      source({
        id: "chrome-work",
        browser: "chrome",
        profileLabel: "Work",
        lastUsedAt: Date.now() - 2 * hour,
      }),
      source({
        id: "chrome-default",
        browser: "chrome",
        profileLabel: "Default",
        lastUsedAt: Date.now() - 3 * hour,
      }),
    ];
    renderDialog(bridge);

    const headings = await screen.findAllByRole("heading", { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "Safari",
      "Google Chrome",
    ]);
    const chrome = screen.getByRole("region", { name: "Google Chrome" });
    expect(
      within(chrome)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Work2h ago", "Default3h ago"]);
    expect(
      screen.getAllByRole("heading", { level: 3, name: "Google Chrome" }),
    ).toHaveLength(1);
    // And the heading is the only place the browser name is rendered: the
    // rows under it carry the profile alone.
    expect(screen.getAllByText("Google Chrome")).toHaveLength(1);
  });

  it("picking the same file twice lists it once", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const bridge = new TestBridge();
    const fileSourceAt = (lastUsedAt: number): LoginImportSource => ({
      id: "file-source-1",
      browser: "file",
      profileLabel: "exported-cookies.txt",
      lastUsedAt,
    });
    bridge.pickResults = [fileSourceAt(60_000), fileSourceAt(120_000)];
    bridge.scanBySourceId.set("file-source-1", scan({}));
    renderDialog(bridge);

    await pickSource(/Import from a file…/);
    await screen.findByRole("button", { name: IMPORT_CONFIRM_NAME });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("button", { name: /exported-cookies\.txt/ });

    await pickSource(/Import from a file…/);
    await screen.findByRole("button", { name: IMPORT_CONFIRM_NAME });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("button", { name: /exported-cookies\.txt/ });

    expect(
      screen.getAllByRole("button", { name: /exported-cookies\.txt/ }),
    ).toHaveLength(1);
    const duplicateKeyWarning = consoleError.mock.calls.some((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes("same key")),
    );
    expect(duplicateKeyWarning).toBe(false);
    consoleError.mockRestore();
  });
});

describe("<ImportLoginsDialog /> choose-sites step", () => {
  it("lists a checklist of registrable domains with counts, all checked by default", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [
          { domain: "example.com", cookieCount: 3, unlock: null },
          { domain: "example.org", cookieCount: 1, unlock: null },
        ],
      }),
    );
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    await waitFor(() => {
      expect(screen.getByText("example.com")).not.toBeNull();
    });
    expect(screen.getByText("example.org")).not.toBeNull();
    expect(screen.getByText("3 cookies")).not.toBeNull();
    expect(screen.getByText("1 cookie")).not.toBeNull();
    const first = screen.getByRole("checkbox", {
      name: "Import logins for example.com",
    });
    const second = screen.getByRole("checkbox", {
      name: "Import logins for example.org",
    });
    expect(first.getAttribute("data-state")).toBe("checked");
    expect(second.getAttribute("data-state")).toBe("checked");
    expect(screen.getByText("2 of 2 sites selected")).not.toBeNull();
  });

  it("disables and unchecks Google's excluded rows, with the opt-in switch off and no alert", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 2, unlock: null }],
        excluded: [
          {
            domain: "google.com",
            cookieCount: 5,
            unlock: null,
            reason: "google-device-bound",
          },
        ],
      }),
    );
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    const excludedCheckbox = await screen.findByRole<HTMLButtonElement>(
      "checkbox",
      {
        name: "google.com can't be imported",
      },
    );
    expect(excludedCheckbox.getAttribute("data-state")).toBe("unchecked");
    expect(excludedCheckbox.disabled).toBe(true);
    expect(
      screen.getByText(
        "Google accounts are left out: Google binds sign-ins to the device they were made on. Sign in to Google inside Traycer once, or import them anyway and accept that they can stop working.",
      ),
    ).not.toBeNull();
    const optIn = screen.getByRole("switch", {
      name: "Import Google logins anyway",
    });
    expect(optIn.getAttribute("aria-checked")).toBe("false");
    expect(
      screen.queryByText(/An imported Google login can stop working/),
    ).toBeNull();
  });

  it("has no opt-in switch when the scan lists no excluded rows", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 1, unlock: null }],
      }),
    );
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText("example.com");
    expect(
      screen.queryByRole("switch", { name: "Import Google logins anyway" }),
    ).toBeNull();
  });

  it("toggling the opt-in on shows the warning, ticks google.com in the checklist, and updates the count", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 2, unlock: null }],
        excluded: [
          {
            domain: "google.com",
            cookieCount: 5,
            unlock: null,
            reason: "google-device-bound",
          },
        ],
      }),
    );
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText("example.com");
    expect(screen.getByText("1 of 1 sites selected")).not.toBeNull();
    const optIn = screen.getByRole("switch", {
      name: "Import Google logins anyway",
    });

    fireEvent.click(optIn);

    expect(optIn.getAttribute("aria-checked")).toBe("true");
    // Plain content (`note`), not an assertive live region: it re-renders on
    // every toggle and must not interrupt a screen reader each time.
    const warning = await screen.findByText(
      /An imported Google login can stop working/,
    );
    expect(warning.closest("[role='note']")).not.toBeNull();
    expect(warning.textContent).toContain(
      "Google binds sign-ins to the device they were made on.",
    );
    expect(
      screen.queryByRole("checkbox", { name: "google.com can't be imported" }),
    ).toBeNull();
    const googleCheckbox = screen.getByRole("checkbox", {
      name: "Import logins for google.com",
    });
    expect(googleCheckbox.getAttribute("data-state")).toBe("checked");
    expect(screen.getByText("device-bound · 5 cookies")).not.toBeNull();
    expect(screen.getByText("2 of 2 sites selected")).not.toBeNull();

    fireEvent.click(optIn);

    expect(optIn.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("1 of 1 sites selected")).not.toBeNull();
    expect(
      screen.getByRole("checkbox", { name: "google.com can't be imported" }),
    ).not.toBeNull();
  });

  it("shows the unreadable-records notice when unreadableCookieCount > 0", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 1, unlock: null }],
        unreadableCookieCount: 2,
      }),
    );
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText(
      /2 records in this profile couldn't be read and are left out/,
    );
  });

  it("shows the protected-cookie banner when protectedCookieCount > 0", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 1, unlock: null }],
        protectedCookieCount: 2,
      }),
    );
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    const banner = await screen.findByText(
      /protected by the browser on Windows and can't be imported/,
    );
    expect(banner.textContent).toContain(
      "2 logins are protected by the browser on Windows and can't be imported.",
    );
    expect(banner.closest("[role='note']")).not.toBeNull();
  });

  it("renders the needs-full-disk-access explainer, whose button opens the pane through its own RunnerHost method", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({ blocked: "needs-full-disk-access" }),
    );
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    const openButton = await screen.findByRole("button", {
      name: "Open Full Disk Access settings",
    });
    fireEvent.click(openButton);

    expect(openFullDiskAccessMocks.mutate).toHaveBeenCalledOnce();
  });

  it.each<LoginImportBlocked>([
    "keyring-unavailable",
    "browser-locked",
    "source-changed",
    "unreadable",
    "file-too-large",
    "profile-too-large",
    "too-many-sites",
  ])("renders the %s explainer and a Try again affordance", async (reason) => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set("source-1", scan({ blocked: reason }));
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    const notes = await screen.findAllByRole("note");
    expect(screen.getByRole("button", { name: "Try again" })).not.toBeNull();

    // source-changed is the guard that fires when a chosen site's rows
    // changed under the user between the scan and the Import click; its
    // explainer has to say the import is safe to retry, not just that
    // something went wrong.
    if (reason === "source-changed") {
      const explainerText = notes.map((note) => note.textContent).join(" ");
      expect(explainerText).toContain("try again to read the profile afresh");
    }

    // profile-too-large is the desktop's own size guard on the profile's
    // cookie database (distinct from file-too-large, a picked file), so its
    // explainer has to name the database rather than reuse the file copy.
    if (reason === "profile-too-large") {
      const explainerText = notes.map((note) => note.textContent).join(" ");
      expect(explainerText).toContain(
        "far larger than a browser normally keeps",
      );
    }
  });

  it("renders the macOS-keychain unlock hint when the selected site's unlock is macos-keychain", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({ browser: "chrome" })];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [
          { domain: "example.com", cookieCount: 1, unlock: "macos-keychain" },
        ],
        unlock: "macos-keychain",
      }),
    );
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    const hint = await screen.findByRole("note");
    expect(hint.textContent).toContain(
      'macOS will ask whether "security" may read Google Chrome\'s key from your keychain. Click Allow, not Always Allow.',
    );
  });

  it("shows no keychain hint when only plaintext sites are selected", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({ browser: "chrome" })];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [
          { domain: "encrypted.com", cookieCount: 1, unlock: "macos-keychain" },
          { domain: "plain.com", cookieCount: 1, unlock: null },
        ],
        unlock: "macos-keychain",
      }),
    );
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText("encrypted.com");
    expect(screen.getByText(/macOS will ask whether/)).not.toBeNull();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Import logins for encrypted.com",
      }),
    );

    expect(screen.queryByText(/macOS will ask whether/)).toBeNull();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Import logins for encrypted.com",
      }),
    );

    expect(screen.getByText(/macOS will ask whether/)).not.toBeNull();
  });

  it("disables the Import button with 0 sites selected", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 1, unlock: null }],
      }),
    );
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText("example.com");
    fireEvent.click(screen.getByRole("button", { name: "Select none" }));

    expect(importConfirmButton().disabled).toBe(true);
  });

  it("freezes Select all and Select none while the import is pending", async () => {
    const bridge = new TestBridge();
    bridge.deferImport = true;
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [
          { domain: "example.com", cookieCount: 1, unlock: null },
          { domain: "example.org", cookieCount: 1, unlock: null },
        ],
      }),
    );
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText("example.com");
    fireEvent.click(importConfirmButton());

    await waitFor(() => {
      expect(bridge.importCalls).toHaveLength(1);
    });
    // The mutation's `isPending` flip re-renders the Choose step, and the
    // bridge object itself is part of the scan query's key - waiting for
    // "Select all" to be findable (rather than reading the DOM synchronously)
    // rides past that re-render instead of racing it.
    expect(
      (
        await screen.findByRole<HTMLButtonElement>("button", {
          name: "Select all",
        })
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Select none" })
        .disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("checkbox", {
        name: "Import logins for example.com",
      }).disabled,
    ).toBe(true);

    const release = bridge.releaseImport;
    if (release === null) {
      throw new Error("the import was not deferred");
    }
    release();
    await screen.findByText("Logins imported");
  });
});

describe("<ImportLoginsDialog /> import", () => {
  it("sends exactly the currently-checked domains", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [
          { domain: "example.com", cookieCount: 1, unlock: null },
          { domain: "example.org", cookieCount: 1, unlock: null },
        ],
      }),
    );
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText("example.com");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Import logins for example.org" }),
    );
    fireEvent.click(importConfirmButton());

    await waitFor(() => {
      expect(bridge.importCalls).toHaveLength(1);
    });
    expect(bridge.importCalls[0]).toEqual({
      sourceId: "source-1",
      scanId: "scan-1",
      domains: ["example.com"],
      includeDeviceBound: false,
    });
  });

  it("sends includeDeviceBound: true and the google domain when the opt-in is on", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 1, unlock: null }],
        excluded: [
          {
            domain: "google.com",
            cookieCount: 3,
            unlock: null,
            reason: "google-device-bound",
          },
        ],
      }),
    );
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText("example.com");
    fireEvent.click(
      screen.getByRole("switch", { name: "Import Google logins anyway" }),
    );
    await screen.findByRole("checkbox", {
      name: "Import logins for google.com",
    });
    fireEvent.click(importConfirmButton());

    await waitFor(() => {
      expect(bridge.importCalls).toHaveLength(1);
    });
    expect(bridge.importCalls[0]).toEqual({
      sourceId: "source-1",
      scanId: "scan-1",
      domains: ["example.com", "google.com"],
      includeDeviceBound: true,
    });
  });

  it("sends includeDeviceBound: false and no google domain when the opt-in is toggled on then off again before importing", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 1, unlock: null }],
        excluded: [
          {
            domain: "google.com",
            cookieCount: 3,
            unlock: null,
            reason: "google-device-bound",
          },
        ],
      }),
    );
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText("example.com");
    const optIn = screen.getByRole("switch", {
      name: "Import Google logins anyway",
    });
    fireEvent.click(optIn);
    await screen.findByRole("checkbox", {
      name: "Import logins for google.com",
    });
    fireEvent.click(optIn);
    await waitFor(() => {
      expect(
        screen.getByRole("checkbox", { name: "google.com can't be imported" }),
      ).not.toBeNull();
    });
    fireEvent.click(importConfirmButton());

    await waitFor(() => {
      expect(bridge.importCalls).toHaveLength(1);
    });
    expect(bridge.importCalls[0]).toEqual({
      sourceId: "source-1",
      scanId: "scan-1",
      domains: ["example.com"],
      includeDeviceBound: false,
    });
  });

  it("pushes once on a successful import and shows the sent/saved copy on Done", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 2, unlock: null }],
      }),
    );
    bridge.importResult = {
      status: "imported",
      importedSites: 1,
      importedCookies: 2,
      replacedSites: 0,
      skippedInvalid: 0,
      notifiedHosts: 2,
    };
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText("example.com");
    fireEvent.click(importConfirmButton());

    await screen.findByText("Logins imported");
    expect(bridge.importCalls).toHaveLength(1);
    expect(
      screen.getByText("Signed in to 1 site on this machine (2 cookies)."),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Sent to 2 hosts. Hosts apply it when they next open a browser session.",
      ),
    ).not.toBeNull();
  });

  it("shows the saved-on-this-machine copy when nothing was pushed", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 1, unlock: null }],
      }),
    );
    bridge.importResult = {
      status: "imported",
      importedSites: 1,
      importedCookies: 1,
      replacedSites: 0,
      skippedInvalid: 0,
      notifiedHosts: 0,
    };
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText("example.com");
    fireEvent.click(importConfirmButton());

    await screen.findByText("Logins imported");
    expect(
      screen.getByText(
        "Saved on this machine. Hosts pick it up at the next capture.",
      ),
    ).not.toBeNull();
  });

  it("a declined desktop confirmation leaves the checklist in place", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 1, unlock: null }],
      }),
    );
    bridge.importResult = { status: "cancelled" };
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText("example.com");
    fireEvent.click(importConfirmButton());

    await waitFor(() => {
      expect(bridge.importCalls).toHaveLength(1);
    });
    // The Choose step is still rendered - a declined confirmation is not an
    // outcome, so there is nothing for a Done step to show.
    await screen.findByText("example.com");
    expect(importConfirmButton()).not.toBeNull();
    expect(screen.queryByText("Logins imported")).toBeNull();
    expect(screen.queryByText("Nothing was imported")).toBeNull();
  });

  it("renders a Try again affordance for a blocked import result", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 1, unlock: null }],
      }),
    );
    bridge.importResult = { status: "blocked", reason: "browser-locked" };
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText("example.com");
    fireEvent.click(importConfirmButton());

    await screen.findByText("Nothing was imported");
    expect(screen.getByRole("button", { name: "Try again" })).not.toBeNull();
  });

  it("shows the part-way title and explainer for an incomplete import", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 1, unlock: null }],
      }),
    );
    bridge.importResult = { status: "blocked", reason: "incomplete" };
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText("example.com");
    fireEvent.click(importConfirmButton());

    await screen.findByText("The import stopped part-way");
    expect(screen.getByText(/import again to finish the rest/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).not.toBeNull();
  });

  it("invalidates the saved sites after an incomplete import", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 1, unlock: null }],
      }),
    );
    bridge.importResult = { status: "blocked", reason: "incomplete" };
    const { client } = renderDialog(bridge);
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");
    await pickSource(/Google Chrome/);

    await screen.findByText("example.com");
    fireEvent.click(importConfirmButton());

    await screen.findByText("The import stopped part-way");
    // What it did write is in the jar and was pushed, so the saved-sites
    // list is just as stale as after a completed import.
    expect(invalidateQueries).toHaveBeenCalled();
  });

  it("leaves the saved sites alone for a blocked import that wrote nothing", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 1, unlock: null }],
      }),
    );
    bridge.importResult = { status: "blocked", reason: "saved-logins-off" };
    const { client } = renderDialog(bridge);
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");
    await pickSource(/Google Chrome/);

    await screen.findByText("example.com");
    fireEvent.click(importConfirmButton());

    await screen.findByText("Nothing was imported");
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("keeps the previous selection after a retry from a blocked import", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [
          { domain: "site-a.com", cookieCount: 1, unlock: null },
          { domain: "site-b.com", cookieCount: 1, unlock: null },
          { domain: "site-c.com", cookieCount: 1, unlock: null },
        ],
      }),
    );
    bridge.importResult = { status: "blocked", reason: "keychain-denied" };
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText("site-a.com");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Import logins for site-b.com" }),
    );
    fireEvent.click(importConfirmButton());

    await screen.findByText("Nothing was imported");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByText("site-a.com");
    expect(
      screen
        .getByRole("checkbox", { name: "Import logins for site-a.com" })
        .getAttribute("data-state"),
    ).toBe("checked");
    expect(
      screen
        .getByRole("checkbox", { name: "Import logins for site-b.com" })
        .getAttribute("data-state"),
    ).toBe("unchecked");
    expect(
      screen
        .getByRole("checkbox", { name: "Import logins for site-c.com" })
        .getAttribute("data-state"),
    ).toBe("checked");
    expect(
      screen.getByRole("button", { name: "Import 2 sites" }),
    ).not.toBeNull();
  });

  it("keeps the Google opt-in switch on after a retry from a blocked import", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 1, unlock: null }],
        excluded: [
          {
            domain: "google.com",
            cookieCount: 1,
            unlock: null,
            reason: "google-device-bound",
          },
        ],
      }),
    );
    bridge.importResult = { status: "blocked", reason: "keychain-denied" };
    renderDialog(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText("example.com");
    fireEvent.click(
      screen.getByRole("switch", { name: "Import Google logins anyway" }),
    );
    await screen.findByRole("checkbox", {
      name: "Import logins for google.com",
    });
    fireEvent.click(importConfirmButton());

    await screen.findByText("Nothing was imported");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByText("example.com");
    // `previousChoice.includeDeviceBound` restores the opt-in exactly as the
    // blocked import was made with it - the retry does not fall back to the
    // off-by-default state.
    expect(
      screen
        .getByRole("switch", { name: "Import Google logins anyway" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("checkbox", { name: "Import logins for google.com" })
        .getAttribute("data-state"),
    ).toBe("checked");
  });
});

describe("<ImportLoginsDialog /> Done step affordance", () => {
  it("shows a Done affordance on a successful import when onFinished is present", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 1, unlock: null }],
      }),
    );
    bridge.importResult = {
      status: "imported",
      importedSites: 1,
      importedCookies: 1,
      replacedSites: 0,
      skippedInvalid: 0,
      notifiedHosts: 0,
    };
    const { onOpenChange } = renderDialog(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText("example.com");
    fireEvent.click(importConfirmButton());

    await screen.findByText("Logins imported");
    const done = screen.getByRole("button", { name: "Done" });
    fireEvent.click(done);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("<ImportLoginsFlow /> with nowhere to go (onFinished null)", () => {
  function renderPlainFlow(bridge: TestBridge): void {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ImportLoginsFlow
          browserView={bridge}
          enabled
          frame={PLAIN_IMPORT_LOGINS_FRAME}
          onFinished={null}
        />
      </QueryClientProvider>,
    );
  }

  it("shows no Close/Done button on the Done step", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 1, unlock: null }],
      }),
    );
    bridge.importResult = {
      status: "imported",
      importedSites: 1,
      importedCookies: 1,
      replacedSites: 0,
      skippedInvalid: 0,
      notifiedHosts: 0,
    };
    renderPlainFlow(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText("example.com");
    fireEvent.click(importConfirmButton());

    await screen.findByText("Logins imported");
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("keeps Try again on a blocked Done step, with no Close button", async () => {
    const bridge = new TestBridge();
    bridge.sources = [source({})];
    bridge.scanBySourceId.set(
      "source-1",
      scan({
        sites: [{ domain: "example.com", cookieCount: 1, unlock: null }],
      }),
    );
    bridge.importResult = { status: "blocked", reason: "browser-locked" };
    renderPlainFlow(bridge);
    await pickSource(/Google Chrome/);

    await screen.findByText("example.com");
    fireEvent.click(importConfirmButton());

    await screen.findByText("Nothing was imported");
    expect(screen.getByRole("button", { name: "Try again" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });
});
