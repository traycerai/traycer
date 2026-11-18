import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostUnresponsivePrompt } from "@/components/layout/bridges/host-unresponsive-prompt";
import { Toaster } from "@/components/ui/sonner";
import { RunnerHostContext } from "@/providers/runner-host-context";

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

const TITLE = "Host is not responding. Force restart?";
const NOTICE_TITLE = "Host is not responding.";

function createRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.example/sign-in",
    authnBaseUrl: "https://auth.example",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function renderPrompt(host: MockRunnerHost): { readonly rerender: () => void } {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const tree = (): ReactElement => (
    <QueryClientProvider client={queryClient}>
      <RunnerHostContext.Provider value={host}>
        <HostUnresponsivePrompt />
        <Toaster />
      </RunnerHostContext.Provider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { rerender: () => view.rerender(tree()) };
}

afterEach(() => {
  cleanup();
});

describe("<HostUnresponsivePrompt />", () => {
  it("shows nothing while the host is not reported unresponsive", () => {
    const host = createRunnerHost();
    renderPrompt(host);

    expect(screen.queryByText(TITLE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Force restart" })).toBeNull();
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
  });

  it("offers a force restart naming how long the host has been silent", async () => {
    const host = createRunnerHost();
    renderPrompt(host);

    act(() => {
      host.setLocalHostUnresponsive({
        pid: 4242,
        offerId: 7,
        unreachableForMs: 12 * 60_000,
      });
    });

    expect(await screen.findByText(TITLE)).not.toBeNull();
    // The duration is the figure at the moment of the report, so it is a
    // lower bound on how long the host has been silent.
    expect(screen.getByText(/not answered for at least 12 min/)).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Force restart" }),
    ).not.toBeNull();
  });

  it("says a force restart ends work in progress when it offers one", async () => {
    const host = createRunnerHost();
    renderPrompt(host);

    act(() => {
      host.setLocalHostUnresponsive({
        pid: 4242,
        offerId: 7,
        unreachableForMs: 12 * 60_000,
      });
    });

    expect(await screen.findByText(TITLE)).not.toBeNull();
    expect(
      screen.getByText(
        "It has not answered for at least 12 min. A force restart ends any work in progress on it.",
      ),
    ).not.toBeNull();
  });

  describe("when the shell makes no offer (offerId null)", () => {
    it("tells the person the host is not responding, for how long, and offers no Force restart", async () => {
      const host = createRunnerHost();
      const forceRestart = vi
        .spyOn(host, "forceRestartUnresponsiveHost")
        .mockResolvedValue({ kind: "restarted" });
      renderPrompt(host);

      act(() => {
        host.setLocalHostUnresponsive({
          pid: 4242,
          offerId: null,
          unreachableForMs: 12 * 60_000,
        });
      });

      expect(await screen.findByText(NOTICE_TITLE)).not.toBeNull();
      expect(
        screen.getByText("It has not answered for at least 12 min."),
      ).not.toBeNull();
      expect(screen.queryByText(TITLE)).toBeNull();
      expect(screen.queryByText(/A force restart ends any work/)).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Force restart" }),
      ).toBeNull();
      expect(forceRestart).not.toHaveBeenCalled();
    });

    it("withdraws the notice when the shell reports the host answering again", async () => {
      const host = createRunnerHost();
      renderPrompt(host);
      act(() => {
        host.setLocalHostUnresponsive({
          pid: 4242,
          offerId: null,
          unreachableForMs: 12 * 60_000,
        });
      });
      expect(await screen.findByText(NOTICE_TITLE)).not.toBeNull();

      act(() => {
        host.setLocalHostUnresponsive(null);
      });

      await waitFor(() => {
        expect(screen.queryByText(NOTICE_TITLE)).toBeNull();
      });
    });

    it("gives way to the offer when a later verdict carries an offer id, and back to the notice when one does not", async () => {
      const host = createRunnerHost();
      renderPrompt(host);
      act(() => {
        host.setLocalHostUnresponsive({
          pid: 4242,
          offerId: null,
          unreachableForMs: 12 * 60_000,
        });
      });
      expect(await screen.findByText(NOTICE_TITLE)).not.toBeNull();

      act(() => {
        host.setLocalHostUnresponsive({
          pid: 4242,
          offerId: 9,
          unreachableForMs: 13 * 60_000,
        });
      });
      expect(await screen.findByText(TITLE)).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Force restart" }),
      ).not.toBeNull();
      await waitFor(() => {
        expect(screen.queryByText(NOTICE_TITLE)).toBeNull();
      });

      act(() => {
        host.setLocalHostUnresponsive({
          pid: 4242,
          offerId: null,
          unreachableForMs: 14 * 60_000,
        });
      });
      expect(await screen.findByText(NOTICE_TITLE)).not.toBeNull();
      await waitFor(() => {
        expect(screen.queryByText(TITLE)).toBeNull();
        expect(
          screen.queryByRole("button", { name: "Force restart" }),
        ).toBeNull();
      });
    });
  });

  it("force-restarts the offered host by its pid and offer id, not by a bare respawn request", async () => {
    const host = createRunnerHost();
    const forceRestart = vi
      .spyOn(host, "forceRestartUnresponsiveHost")
      .mockResolvedValue({ kind: "restarted" });
    renderPrompt(host);
    act(() => {
      host.setLocalHostUnresponsive({
        pid: 4242,
        offerId: 7,
        unreachableForMs: 12 * 60_000,
      });
    });

    const button = await screen.findByRole("button", { name: "Force restart" });
    expect(forceRestart).not.toHaveBeenCalled();
    fireEvent.click(button);

    await waitFor(() => {
      expect(forceRestart).toHaveBeenCalledTimes(1);
    });
    expect(forceRestart).toHaveBeenCalledWith({ pid: 4242, offerId: 7 });
    expect(host.requestHostRespawnCalls).toBe(0);
  });

  it("tells the person the host was not restarted when the shell declines", async () => {
    const host = createRunnerHost();
    vi.spyOn(host, "forceRestartUnresponsiveHost").mockResolvedValue({
      kind: "declined",
      message:
        "The host started responding again or was replaced, so it was not restarted.",
    });
    renderPrompt(host);
    act(() => {
      host.setLocalHostUnresponsive({
        pid: 4242,
        offerId: 7,
        unreachableForMs: 12 * 60_000,
      });
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Force restart" }),
    );

    expect(await screen.findByText("Host not restarted")).not.toBeNull();
    expect(
      await screen.findByText(
        "The host started responding again or was replaced, so it was not restarted.",
      ),
    ).not.toBeNull();
  });

  it("withdraws the offer when the shell reports the host answering again", async () => {
    const host = createRunnerHost();
    renderPrompt(host);
    act(() => {
      host.setLocalHostUnresponsive({
        pid: 4242,
        offerId: 7,
        unreachableForMs: 12 * 60_000,
      });
    });
    expect(await screen.findByText(TITLE)).not.toBeNull();

    act(() => {
      host.setLocalHostUnresponsive(null);
    });

    await waitFor(() => {
      expect(screen.queryByText(TITLE)).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Force restart" }),
      ).toBeNull();
    });
  });

  it("keeps an open offer through a re-render, and Force restart still force-restarts the offered host once", async () => {
    const host = createRunnerHost();
    const forceRestart = vi
      .spyOn(host, "forceRestartUnresponsiveHost")
      .mockResolvedValue({ kind: "restarted" });
    const view = renderPrompt(host);
    act(() => {
      host.setLocalHostUnresponsive({
        pid: 4242,
        offerId: 7,
        unreachableForMs: 12 * 60_000,
      });
    });
    expect(await screen.findByText(TITLE)).not.toBeNull();

    act(() => {
      view.rerender();
    });
    expect(screen.queryByText(TITLE)).not.toBeNull();

    fireEvent.click(
      await screen.findByRole("button", { name: "Force restart" }),
    );
    await waitFor(() => {
      expect(forceRestart).toHaveBeenCalledTimes(1);
    });
    expect(forceRestart).toHaveBeenCalledWith({ pid: 4242, offerId: 7 });
  });

  it("force-restarts with the offer id of the offer on screen, after a later offer replaced an earlier one for the same pid", async () => {
    const host = createRunnerHost();
    const forceRestart = vi
      .spyOn(host, "forceRestartUnresponsiveHost")
      .mockResolvedValue({ kind: "restarted" });
    renderPrompt(host);
    act(() => {
      host.setLocalHostUnresponsive({
        pid: 4242,
        offerId: 7,
        unreachableForMs: 12 * 60_000,
      });
    });
    expect(await screen.findByText(TITLE)).not.toBeNull();
    act(() => {
      host.setLocalHostUnresponsive(null);
    });
    await waitFor(() => {
      expect(screen.queryByText(TITLE)).toBeNull();
    });
    act(() => {
      host.setLocalHostUnresponsive({
        pid: 4242,
        offerId: 8,
        unreachableForMs: 13 * 60_000,
      });
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Force restart" }),
    );
    await waitFor(() => {
      expect(forceRestart).toHaveBeenCalledTimes(1);
    });
    expect(forceRestart).toHaveBeenCalledWith({ pid: 4242, offerId: 8 });
  });
});
