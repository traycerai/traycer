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
        html="<p>page</p>"
        kind="page"
        title="Page"
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
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(openLink).not.toHaveBeenCalled();
  });
});
