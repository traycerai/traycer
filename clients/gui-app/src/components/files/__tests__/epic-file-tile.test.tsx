import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EpicReadFileResponse } from "@traycer/protocol/host/epic/files";
import { EpicFileTile } from "@/components/files/epic-file-tile";
import type { HostReachability } from "@/hooks/agent/use-host-reachability";
import {
  EpicFileRpcContext,
  type EpicFileRpc,
} from "@/lib/files/epic-file-rpc";
import { makeEpicFileTileRef } from "@/stores/epics/canvas/tile-schema/epic-file-tile";

const HOST_ID = "host-1";

const mocks = vi.hoisted(() => {
  const current: HostReachability = {
    status: "reachable",
    hostLabel: "Studio Mac",
    unavailability: null,
    basis: "directory",
    hostKind: "local",
  };
  return { reachability: { current } };
});

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => HOST_ID,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => mocks.reachability.current,
}));

// jsdom runs no frame; a box stands in for the running page.
vi.mock("@/components/sandbox/sandbox-frame", () => ({
  SandboxFrame: (props: { readonly html: string }) => (
    <div data-testid="sandbox-frame">{props.html}</div>
  ),
}));

const PAGE: EpicReadFileResponse = {
  kind: "text",
  text: "<h1>Report</h1>",
  mediaType: "text/html",
  networkPolicy: "open",
};

function makeRpc(): EpicFileRpc {
  return {
    readFile: vi.fn<EpicFileRpc["readFile"]>().mockResolvedValue(PAGE),
    openFileInBrowser: vi.fn<EpicFileRpc["openFileInBrowser"]>(),
    fetchFile: vi.fn<EpicFileRpc["fetchFile"]>(),
  };
}

function setReachability(status: HostReachability["status"]): void {
  mocks.reachability.current = {
    ...mocks.reachability.current,
    status,
    unavailability: null,
  };
}

function tile(path: string): ReactNode {
  return (
    <EpicFileTile
      node={makeEpicFileTileRef({
        path,
        sha256: "a".repeat(64),
        name: "Report",
        hostId: HOST_ID,
        via: null,
      })}
      epicId="epic-1"
    />
  );
}

function renderTile(path: string) {
  const client = new QueryClient();
  const wrap = (children: ReactNode): ReactNode => (
    <QueryClientProvider client={client}>
      <EpicFileRpcContext.Provider value={makeRpc()}>
        {children}
      </EpicFileRpcContext.Provider>
    </QueryClientProvider>
  );
  const view = render(wrap(tile(path)));
  return {
    rerender: (): void => view.rerender(wrap(tile(path))),
  };
}

afterEach(() => {
  cleanup();
  setReachability("reachable");
});

describe("<EpicFileTile /> when its host goes away", () => {
  it("keeps the loaded page running under a notice, with the host's actions disabled", async () => {
    const view = renderTile("files/pages/report.html");
    const frame = await screen.findByTestId("sandbox-frame");

    setReachability("unreachable");
    view.rerender();

    expect(screen.getByTestId("sandbox-frame")).toBe(frame);
    expect(screen.getByTestId("epic-file-tile-offline").textContent).toContain(
      "Studio Mac",
    );
    expect(
      screen.getByRole("button", { name: "Open in browser" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Download" })).toHaveProperty(
      "disabled",
      true,
    );
  });
});

describe("<EpicFileTile /> for a file with no viewer", () => {
  it("offers no Download until its bytes have a source", () => {
    renderTile("files/data.bin");

    expect(screen.getByText("No preview for this file.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });
});
