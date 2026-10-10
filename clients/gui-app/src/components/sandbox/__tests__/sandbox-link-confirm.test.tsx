import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxLinkConfirm } from "@/components/sandbox/sandbox-link-confirm";

const URL_ASKED = "https://example.com/a/very/long/path?q=1#frag";

afterEach(() => {
  cleanup();
});

describe("<SandboxLinkConfirm />", () => {
  it("names an app as an app", () => {
    render(
      <SandboxLinkConfirm
        url={URL_ASKED}
        kind="app"
        appName={null}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog").textContent).toContain(
      "The app wants to open:",
    );
  });

  it("names the asking app's server when it has one", () => {
    render(
      <SandboxLinkConfirm
        url={URL_ASKED}
        kind="app"
        appName="linear"
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog").textContent).toContain(
      "The linear app wants to open:",
    );
  });

  it("shows nothing until a page asks", () => {
    render(
      <SandboxLinkConfirm
        url={null}
        kind="page"
        appName={null}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the whole URL and opens only on Open", async () => {
    const onDecide = vi.fn<(open: boolean) => void>();
    render(
      <SandboxLinkConfirm
        url={URL_ASKED}
        kind="page"
        appName={null}
        onDecide={onDecide}
      />,
    );
    expect(screen.getByRole("dialog").textContent).toContain(URL_ASKED);
    // Cancel takes focus, so a stray Enter never opens the link.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onDecide.mock.calls).toEqual([[true]]);
  });

  it.each([
    [
      "Cancel",
      () => userEvent.click(screen.getByRole("button", { name: "Cancel" })),
    ],
    ["Esc", () => userEvent.keyboard("{Escape}")],
  ])("declines on %s", async (_label, act) => {
    const onDecide = vi.fn<(open: boolean) => void>();
    render(
      <SandboxLinkConfirm
        url={URL_ASKED}
        kind="page"
        appName={null}
        onDecide={onDecide}
      />,
    );
    await act();
    expect(onDecide.mock.calls).toEqual([[false]]);
  });
});
