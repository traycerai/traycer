import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  ShellOutputAvailabilityNotice,
  type ShellOutputAvailabilityNoticeProps,
  type ShellOutputNoticeAvailability,
} from "@/components/managed-commands/shell-output-availability-notice";

/**
 * The one place the output window's fallback states get their words, tone and
 * action - pinned directly against the component so a copy change or a
 * dropped action shows up here, not as a mystery three layers up in a
 * renderer test.
 */

function renderNotice(
  over: Partial<ShellOutputAvailabilityNoticeProps> & {
    readonly availability: ShellOutputNoticeAvailability;
  },
): void {
  render(
    <ShellOutputAvailabilityNotice
      onClose={null}
      onReopen={null}
      className={undefined}
      testId="notice"
      {...over}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("ShellOutputAvailabilityNotice", () => {
  describe("bootstrapping", () => {
    it("names each wait by which machinery it is waiting on", () => {
      renderNotice({
        availability: { kind: "bootstrapping", phase: "checking-host" },
      });

      expect(screen.getByText("Checking host…")).not.toBeNull();
      const panel = screen.getByRole("status");
      expect(panel.getAttribute("data-availability")).toBe("bootstrapping");
      expect(panel.getAttribute("data-phase")).toBe("checking-host");
      expect(panel.getAttribute("aria-busy")).toBe("true");
    });

    it("says the same words the chat's own host-starting banner uses", () => {
      renderNotice({
        availability: { kind: "bootstrapping", phase: "starting-host" },
      });

      expect(screen.getByText("Waiting for the host to start…")).not.toBeNull();
    });

    it("names the stream wait once the host gate has already passed", () => {
      renderNotice({
        availability: { kind: "bootstrapping", phase: "opening-stream" },
      });

      expect(screen.getByText("Opening stream…")).not.toBeNull();
    });

    it("never offers Close, even with a close handler in hand - the wait clears on its own", () => {
      renderNotice({
        availability: { kind: "bootstrapping", phase: "checking-host" },
        onClose: () => undefined,
      });

      expect(screen.queryByRole("button", { name: "Close tab" })).toBeNull();
    });
  });

  it("reads an old host as too old, and never as something Close can fix", () => {
    renderNotice({
      availability: { kind: "unsupported-host" },
      onClose: () => undefined,
    });

    expect(
      screen.getByText("This host is too old to show shells."),
    ).not.toBeNull();
    const panel = screen.getByRole("status");
    expect(panel.getAttribute("data-availability")).toBe("unsupported-host");
    expect(panel.getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByRole("button", { name: "Close tab" })).toBeNull();
  });

  describe("unreachable-host", () => {
    it("names the host and offers Close when the surface has a tab of its own", () => {
      renderNotice({
        availability: { kind: "unreachable-host", hostLabel: "Work laptop" },
        onClose: () => undefined,
      });

      expect(
        screen.getByText(
          'Host "Work laptop" is unreachable, so this output cannot be read. The shell and its log are kept on that host.',
        ),
      ).not.toBeNull();
      const panel = screen.getByRole("status");
      expect(panel.getAttribute("data-availability")).toBe("unreachable-host");
      expect(screen.getByRole("button", { name: "Close tab" })).not.toBeNull();
    });

    it("withholds Close on a surface with no tab of its own", () => {
      renderNotice({
        availability: { kind: "unreachable-host", hostLabel: "Work laptop" },
        onClose: null,
      });

      expect(screen.queryByRole("button", { name: "Close tab" })).toBeNull();
    });
  });

  describe("gone", () => {
    it("says deleted for a deletion", () => {
      renderNotice({
        availability: { kind: "gone", cause: "deleted" },
        onClose: () => undefined,
      });

      expect(screen.getByText("This shell was deleted.")).not.toBeNull();
      const panel = screen.getByRole("status");
      expect(panel.getAttribute("data-availability")).toBe("gone");
      expect(panel.getAttribute("data-cause")).toBe("deleted");
      expect(screen.getByRole("button", { name: "Close tab" })).not.toBeNull();
    });

    it("stays deliberately vague for a refusal the wire cannot tell apart from an unknown id", () => {
      renderNotice({
        availability: { kind: "gone", cause: "not-found" },
        onClose: () => undefined,
      });

      expect(
        screen.getByText("This shell is no longer on this host."),
      ).not.toBeNull();
      expect(screen.getByRole("status").getAttribute("data-cause")).toBe(
        "not-found",
      );
    });

    it("drops Close when the caller has no tab to close", () => {
      renderNotice({
        availability: { kind: "gone", cause: "deleted" },
        onClose: null,
      });

      expect(screen.queryByRole("button", { name: "Close tab" })).toBeNull();
    });
  });

  it("reads unauthorized as an access loss, not a shell state, and still offers a way out", () => {
    renderNotice({
      availability: { kind: "unauthorized" },
      onClose: () => undefined,
    });

    expect(
      screen.getByText("You no longer have access to this epic's shells."),
    ).not.toBeNull();
    expect(screen.getByRole("status").getAttribute("data-availability")).toBe(
      "unauthorized",
    );
    expect(screen.getByRole("button", { name: "Close tab" })).not.toBeNull();
  });

  describe("connecting / stale", () => {
    it("renders Connecting as a centred bootstrapping panel, not a banner - there is nothing to keep in view yet", () => {
      renderNotice({
        availability: { kind: "bootstrapping", phase: "connecting" },
      });

      expect(screen.getByText("Connecting…")).not.toBeNull();
      const panel = screen.getByRole("status");
      expect(panel.getAttribute("data-availability")).toBe("bootstrapping");
      expect(panel.getAttribute("data-phase")).toBe("connecting");
    });

    it("says Reconnecting as a banner once a snapshot has landed and the stream drops", () => {
      renderNotice({ availability: { kind: "stale" } });

      expect(screen.getByText("Reconnecting…")).not.toBeNull();
      expect(screen.getByRole("status").getAttribute("data-availability")).toBe(
        "stale",
      );
    });
  });

  describe("stream-error", () => {
    it("carries the host's own reason in its own span, with Retry when a session exists to reopen", () => {
      renderNotice({
        availability: {
          kind: "stream-error",
          message: "socket closed: EPIPE",
        },
        onReopen: () => undefined,
      });

      const banner = screen.getByRole("status");
      expect(banner.getAttribute("data-availability")).toBe("stream-error");
      expect(banner.textContent).toContain("The output stream failed.");
      const reason = screen.getByTestId("notice-reason");
      expect(reason.textContent).toBe("socket closed: EPIPE");
      expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
    });

    it("drops Retry when there is no stream session yet to reopen", () => {
      renderNotice({
        availability: {
          kind: "stream-error",
          message: "socket closed: EPIPE",
        },
        onReopen: null,
      });

      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });
  });

  it("renders empty as a placeholder inside the log, not a panel or a banner", () => {
    renderNotice({ availability: { kind: "empty" } });

    const placeholder = screen.getByTestId("notice");
    expect(placeholder.textContent).toBe("No output yet.");
    expect(placeholder.getAttribute("data-availability")).toBe("empty");
    expect(placeholder.tagName).toBe("P");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
