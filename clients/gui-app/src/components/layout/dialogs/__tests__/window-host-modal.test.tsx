import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { SelectionIncompatibility } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  WindowHostModal,
  type WindowHostModalProps,
} from "@/components/layout/dialogs/window-host-modal";
import type { HostProgressView } from "@/lib/host/host-progress-copy";

afterEach(cleanup);

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
    localBootstrapBody: null,
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

  it("renders heading/percent/transfer in window-host-modal-progress when progress is set and localBootstrapBody is null", () => {
    renderModal(
      baseProps({
        variant: { kind: "offline" },
        progress: buildProgress({
          heading: "Setting up Traycer Host…",
          percent: 42,
          transferLabel: "1.0 MB of 2.0 MB",
        }),
        localBootstrapBody: null,
      }),
    );
    const progressBlock = screen.getByTestId("window-host-modal-progress");
    expect(progressBlock.textContent).toContain("Setting up Traycer Host…");
    expect(progressBlock.textContent).toContain("42%");
    expect(progressBlock.textContent).toContain("1.0 MB of 2.0 MB");
  });

  it("the bootstrap body wins over progress when both are supplied", () => {
    renderModal(
      baseProps({
        variant: { kind: "offline" },
        progress: buildProgress({}),
        localBootstrapBody: <div data-testid="local-bootstrap-body">boot</div>,
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
