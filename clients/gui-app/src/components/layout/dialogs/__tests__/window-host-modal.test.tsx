import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { SelectionIncompatibility } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { ClientCompatibilityRequirement } from "@traycer/protocol/framework/index";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  WindowHostModal,
  type WindowHostModalProps,
} from "@/components/layout/dialogs/window-host-modal";
import type { HostProgressView } from "@/lib/host/host-progress-copy";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

afterEach(() => {
  cleanup();
  useDesktopDialogStore.setState({ reportIssueAvailable: false });
});

function buildProgress(overrides: Partial<HostProgressView>): HostProgressView {
  return {
    heading: "Setting up Traycer Host…",
    shortLabel: "Setting up…",
    detail: null,
    stage: null,
    percent: null,
    transferLabel: null,
    ...overrides,
  };
}

function baseProps(
  overrides: Partial<WindowHostModalProps>,
): WindowHostModalProps {
  return {
    cause: "no-usable-host",
    variant: { kind: "offline" },
    progress: null,
    bootBody: null,
    onRetry: null,
    retryPending: false,
    onUpdateHost: null,
    onOpenSettings: () => undefined,
    // The DIALOG ignores this - it keeps its own right-aligned footer - and
    // this base describes a settled ∅, which is never settings-only anyway.
    settingsOnly: false,
    // The default mirrors this base's `cause: "no-usable-host"` - a settled
    // failure - so existing fixtures keep describing the state they were
    // written for. The healthy-start arm passes these explicitly.
    showReportIssue: true,
    settingsEmphasis: "button",
    ...overrides,
  };
}

function renderModal(props: WindowHostModalProps) {
  return render(<WindowHostModal {...props} />);
}

function renderModalWithProviders(props: WindowHostModalProps) {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <WindowHostModal {...props} />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

describe("<WindowHostModal />", () => {
  it("draws different titles for offline + cold-start vs offline + no-usable-host", () => {
    renderModal(
      baseProps({ cause: "cold-start", variant: { kind: "offline" } }),
    );
    const coldStartTitle = screen.getByTestId(
      "window-host-modal-title",
    ).textContent;

    cleanup();

    renderModal(
      baseProps({ cause: "no-usable-host", variant: { kind: "offline" } }),
    );
    const noUsableHostTitle = screen.getByTestId(
      "window-host-modal-title",
    ).textContent;

    expect(coldStartTitle).not.toBe(noUsableHostTitle);
  });

  it("sets data-variant and data-cause on the content", () => {
    renderModal(
      baseProps({ cause: "cold-start", variant: { kind: "offline" } }),
    );
    const content = screen.getByTestId("window-host-modal");
    expect(content.getAttribute("data-variant")).toBe("offline");
    expect(content.getAttribute("data-cause")).toBe("cold-start");
  });

  it("plan-restricted: shows the upgrade action, and withholds Retry when onRetry is null", () => {
    renderModalWithProviders(
      baseProps({ variant: { kind: "plan-restricted" }, onRetry: null }),
    );
    expect(screen.getByTestId("host-scope-plan-upgrade")).toBeTruthy();
    expect(screen.queryByTestId("window-host-modal-retry")).toBeNull();
  });

  it("update-host: shows hostVersion, minSupportedVersion, and code in the incompatible detail", () => {
    const detail: SelectionIncompatibility = {
      code: "protocol-major-behind",
      hostVersion: "1.0.0",
      minSupportedVersion: "1.2.0",
      clientCompatibility: null,
    };
    renderModal(
      baseProps({
        variant: {
          kind: "update-host",
          hostId: "host-a",
          isTargetHost: true,
          detail,
        },
        onUpdateHost: () => undefined,
      }),
    );
    const body = screen.getByTestId("window-host-modal-incompatible-detail");
    expect(body.textContent).toContain("1.0.0");
    expect(body.textContent).toContain("1.2.0");
    expect(body.textContent).toContain("protocol-major-behind");
  });

  it("update-host: the Update host button is present when onUpdateHost is a function", () => {
    const detail: SelectionIncompatibility = {
      code: "protocol-major-behind",
      hostVersion: "1.0.0",
      minSupportedVersion: "1.2.0",
      clientCompatibility: null,
    };
    const onUpdateHost = vi.fn();
    renderModal(
      baseProps({
        variant: {
          kind: "update-host",
          hostId: "host-a",
          isTargetHost: true,
          detail,
        },
        onUpdateHost,
      }),
    );
    const button = screen.getByTestId("window-host-modal-update-host");
    fireEvent.click(button);
    expect(onUpdateHost).toHaveBeenCalledTimes(1);
  });

  it("update-host: a NON-target incompatible host explains why it cannot be updated here", () => {
    // Arm 3 of `deriveNoHostVariant`. The action is withheld upstream because
    // this machine's provisioning cannot fix another machine's host - so the
    // copy has to say that, or the card reads as "update the host" beside no
    // button, which is an unexplained gap rather than an honest absence.
    const detail: SelectionIncompatibility = {
      code: "protocol-major-behind",
      hostVersion: "1.0.0",
      minSupportedVersion: "1.2.0",
      clientCompatibility: null,
    };
    renderModal(
      baseProps({
        variant: {
          kind: "update-host",
          hostId: "host-b",
          isTargetHost: false,
          detail,
        },
        onUpdateHost: null,
      }),
    );
    const description = screen.getByTestId("window-host-modal-description");
    expect(description.textContent).toContain("Another host on this account");
    expect(description.textContent).toContain("can't be updated from here");
    // And it must NOT still tell the reader to do the thing there is no
    // control for.
    expect(description.textContent).not.toContain(
      "Update the host to continue",
    );
  });

  it("update-host: the Update host button is absent when onUpdateHost is null", () => {
    const detail: SelectionIncompatibility = {
      code: "protocol-major-behind",
      hostVersion: "1.0.0",
      minSupportedVersion: "1.2.0",
      clientCompatibility: null,
    };
    renderModal(
      baseProps({
        variant: {
          kind: "update-host",
          hostId: "host-a",
          isTargetHost: true,
          detail,
        },
        onUpdateHost: null,
      }),
    );
    expect(screen.queryByTestId("window-host-modal-update-host")).toBeNull();
  });

  it("renders heading and percent - never the byte count or the lane's message - in window-host-modal-progress when progress is set and bootBody is null", () => {
    renderModal(
      baseProps({
        variant: { kind: "offline" },
        progress: buildProgress({
          heading: "Setting up Traycer Host…",
          percent: 42,
          transferLabel: "1.0 MB of 2.0 MB",
          detail: "extracting host archive into /Users/me/.traycer/staging",
        }),
        bootBody: null,
      }),
    );
    const progressBlock = screen.getByTestId("window-host-modal-progress");
    expect(progressBlock.textContent).toContain("Setting up Traycer Host…");
    expect(progressBlock.textContent).toContain("42%");
    // The view carries both (supplied above); the launch card draws neither -
    // same rule as the boot body's bar, see `HostProgress`.
    expect(progressBlock.textContent).not.toContain("MB");
    expect(progressBlock.textContent).not.toContain("extracting host archive");
  });

  it("the bootstrap body wins over progress when both are supplied", () => {
    renderModal(
      baseProps({
        variant: { kind: "offline" },
        progress: buildProgress({}),
        bootBody: <div data-testid="local-bootstrap-body">boot</div>,
      }),
    );
    expect(screen.getByTestId("local-bootstrap-body")).toBeTruthy();
    expect(screen.queryByTestId("window-host-modal-progress")).toBeNull();
  });

  it("does not close on Escape or an outside pointer-down — there is no dismissal path", () => {
    renderModal(baseProps({ variant: { kind: "offline" } }));
    expect(screen.getByTestId("window-host-modal")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("window-host-modal")).toBeTruthy();

    fireEvent.pointerDown(document.body);
    fireEvent.pointerUp(document.body);
    expect(screen.getByTestId("window-host-modal")).toBeTruthy();
  });
});

describe("<WindowHostModal /> update-client (epoch rejection)", () => {
  // Typed at the CONTRACT rather than inferred: a `typeof requirement`
  // override type narrows every member to the literal this fixture happens to
  // use, so the "host could not read a version" case below - the whole point
  // of the second arm - would not type-check.
  const requirement: ClientCompatibilityRequirement = {
    minimumCompatibilityEpoch: 2,
    observedCompatibilityEpoch: 1,
    failure: "below-minimum",
    observedClientKind: "desktop",
    observedClientAppVersion: "1.1.10",
    observedClientAppVersionStatus: "valid",
    minimumKnownClientAppVersion: null,
    upgradeChannel: null,
    hostReleaseChannel: "rc",
  };

  function updateClientProps(
    overrides: Partial<ClientCompatibilityRequirement>,
  ): WindowHostModalProps {
    return baseProps({
      variant: {
        kind: "update-client",
        hostId: "host-a",
        isTargetHost: true,
        requirement: { ...requirement, ...overrides },
      },
      // The narrator withholds this on the update-client arm; passed as `null`
      // here so the assertion below is about the COMPONENT's own refusal to
      // draw a host action, not about the caller happening not to supply one.
      onUpdateHost: null,
    });
  }

  it("titles the app update and names the observed version plus the generic remedy", () => {
    renderModalWithProviders(updateClientProps({}));
    expect(screen.getByTestId("window-host-modal-title").textContent).toBe(
      "Update Traycer to continue",
    );
    const description = screen.getByTestId(
      "window-host-modal-description",
    ).textContent;
    expect(description).toContain("1.1.10");
    expect(description).toContain("the latest version");
    expect(description).not.toContain("1.2.0-rc.2");
  });

  it("says so plainly when the host could not read a version", () => {
    renderModalWithProviders(
      updateClientProps({
        observedClientAppVersion: null,
        observedClientAppVersionStatus: "invalid",
      }),
    );
    expect(
      screen.getByTestId("window-host-modal-description").textContent,
    ).toBe(
      "This Traycer installation is too old to identify a compatible generation. Install the latest Traycer app.",
    );
  });

  it("offers an app-update action and NEVER an Update host button", () => {
    renderModalWithProviders(updateClientProps({}));
    // The host is the newer leg by construction here, so re-installing it can
    // only fail while implying the user is fixing the right machine.
    expect(screen.queryByTestId("window-host-modal-update-host")).toBeNull();
    expect(screen.queryByTestId("window-host-modal-retry")).toBeNull();
    // No update bridge in this shell, so the remedy is the first-party
    // download page - the arm that guarantees this surface is never a dead end.
    expect(
      screen.getByTestId("client-update-required-download-page"),
    ).toBeTruthy();
  });

  it("keeps Report issue available as a secondary action", () => {
    // The shell decides whether reporting exists at all; this arm's job is to
    // ASK for it (`showReportIssue`), which is invisible unless the store says
    // the affordance is available.
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    renderModalWithProviders(updateClientProps({}));
    expect(screen.getByRole("button", { name: /report issue/i })).toBeTruthy();
  });

  it("puts the epoch numbers in the detail block, not the headline", () => {
    renderModalWithProviders(updateClientProps({}));
    const detail = screen.getByTestId(
      "window-host-modal-client-compatibility-detail",
    ).textContent;
    // Users act on an application update, not on an internal protocol
    // generation - so the numbers belong where support reads them.
    expect(detail).toContain("host needs 2");
    expect(detail).toContain("this app declares 1");
    expect(
      screen.getByTestId("window-host-modal-title").textContent,
    ).not.toContain("generation 2");
  });
});
