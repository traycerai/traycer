import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxFrame } from "@/components/sandbox/sandbox-frame";
import type { SandboxStatus } from "@/lib/sandbox/bridge-host";

const { openLink } = vi.hoisted(() => ({ openLink: vi.fn() }));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => openLink }));

afterEach(() => {
  cleanup();
  openLink.mockReset();
});

function frameWindow(): Window {
  const iframe = document.querySelector("iframe");
  const win = iframe?.contentWindow ?? null;
  if (win === null) throw new Error("no frame window");
  return win;
}

/** A message as the frame's own window posts it. */
function fromFrame(data: unknown): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { data, source: frameWindow() }),
    );
  });
}

const PROXY_READY = {
  jsonrpc: "2.0",
  method: "ui/notifications/sandbox-proxy-ready",
  params: {},
};

describe("<SandboxFrame /> link confirm", () => {
  it("takes the confirm down when the bridge is disposed under it", () => {
    const statuses: SandboxStatus[] = [];
    render(
      <SandboxFrame
        source={{ kind: "html", html: "<p>page</p>" }}
        kind="page"
        title="Page"
        appName={null}
        networkPolicy="open"
        appCsp={null}
        permissions={[]}
        appRequests={null}
        className=""
        height={null}
        onSize={() => undefined}
        onStatus={(status) => statuses.push(status)}
        onRequestTeardown={() => undefined}
        displayMode="inline"
        onBridge={null}
        ref={null}
      />,
    );
    fromFrame(PROXY_READY);
    fromFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url: "https://example.com/a" },
    });
    expect(screen.getByRole("dialog").textContent).toContain(
      "https://example.com/a",
    );

    // The loader coming back disposes the bridge; the frame stays mounted.
    fromFrame(PROXY_READY);
    expect(statuses).toContain("disposed");
    expect(statuses).toContain("crashed");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(openLink).not.toHaveBeenCalled();
  });
});

describe("<SandboxFrame /> unexpected disposal", () => {
  function frame(html: string, onStatus: (status: SandboxStatus) => void) {
    return (
      <SandboxFrame
        source={{ kind: "html", html }}
        kind="page"
        title="Page"
        appName={null}
        networkPolicy="open"
        appCsp={null}
        permissions={[]}
        appRequests={null}
        className=""
        height={null}
        onSize={() => undefined}
        onStatus={onStatus}
        onRequestTeardown={() => undefined}
        displayMode="inline"
        onBridge={null}
        ref={null}
      />
    );
  }

  it("reports crashed when the loader comes back while mounted", () => {
    const statuses: SandboxStatus[] = [];
    render(frame("<p>page</p>", (status) => statuses.push(status)));
    fromFrame(PROXY_READY);
    expect(statuses).not.toContain("crashed");

    fromFrame(PROXY_READY);
    expect(statuses).toContain("crashed");
  });

  it("does not report crashed when new content replaces the frame", () => {
    const statuses: SandboxStatus[] = [];
    const onStatus = (status: SandboxStatus): void => {
      statuses.push(status);
    };
    const { rerender } = render(frame("<p>one</p>", onStatus));
    fromFrame(PROXY_READY);

    rerender(frame("<p>two</p>", onStatus));
    expect(statuses).not.toContain("crashed");
  });

  it("does not report crashed when the frame unmounts", () => {
    const statuses: SandboxStatus[] = [];
    const { unmount } = render(
      frame("<p>page</p>", (status) => statuses.push(status)),
    );
    fromFrame(PROXY_READY);

    unmount();
    expect(statuses).not.toContain("crashed");
  });
});
