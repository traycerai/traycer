import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EpicReadFileRequest,
  EpicReadFileResponse,
} from "@traycer/protocol/host/epic/files";
import { VideoViewer } from "@/components/files/viewers/video-viewer";
import type { EpicFileAddress } from "@/hooks/files/use-epic-file-text-query";
import {
  EpicFileRpcContext,
  type EpicFileRpc,
} from "@/lib/files/epic-file-rpc";

const HOST_ID = "host-1";
const ADDRESS: EpicFileAddress = {
  epicId: "epic-1",
  path: "files/demo.mp4",
  sha256: "a".repeat(64),
  via: null,
};
const URL_A = "https://files.example/demo.mp4?sig=a";
const URL_B = "https://files.example/demo.mp4?sig=b";

function signed(url: string): EpicReadFileResponse {
  return { kind: "url", url, expiresAt: Date.now() + 3_600_000 };
}

const BLOB_SPAN: EpicReadFileResponse = {
  kind: "bytes",
  bytesBase64: btoa("frames"),
  offset: 0,
  totalBytes: 6,
  mediaType: "video/mp4",
};

/** A host whose URL answers come from `urls` in order, the last repeating. */
function host(urls: (() => Promise<EpicReadFileResponse>)[]): EpicFileRpc {
  let urlCalls = 0;
  return {
    readFile: vi
      .fn<EpicFileRpc["readFile"]>()
      .mockImplementation((request: EpicReadFileRequest) => {
        if (request.want.kind === "range") return Promise.resolve(BLOB_SPAN);
        const answer = urls[Math.min(urlCalls, urls.length - 1)];
        urlCalls += 1;
        return answer();
      }),
    fetchFile: vi.fn<EpicFileRpc["fetchFile"]>(),
    cancelFetchFile: vi.fn<EpicFileRpc["cancelFetchFile"]>(),
  };
}

const answer =
  (response: EpicReadFileResponse) => (): Promise<EpicReadFileResponse> =>
    Promise.resolve(response);

function renderViewer(rpc: EpicFileRpc): QueryClient {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <EpicFileRpcContext.Provider value={rpc}>
        <VideoViewer hostId={HOST_ID} address={ADDRESS} actions={null} />
      </EpicFileRpcContext.Provider>
    </QueryClientProvider>,
  );
  return client;
}

function urlReads(rpc: EpicFileRpc): number {
  return vi
    .mocked(rpc.readFile)
    .mock.calls.filter(([request]) => request.want.kind === "url").length;
}

function rangeReads(rpc: EpicFileRpc): number {
  return vi
    .mocked(rpc.readFile)
    .mock.calls.filter(([request]) => request.want.kind === "range").length;
}

function video(): HTMLVideoElement {
  const element = screen.getByTestId("epic-file-video");
  if (!(element instanceof HTMLVideoElement)) throw new Error("not a video");
  return element;
}

/** Fails the first element and waits for the reload that answers it. */
async function errorAndReload(): Promise<HTMLVideoElement> {
  const first = await screen.findByTestId("epic-file-video");
  fireEvent.error(first);
  return waitFor(() => {
    const element = video();
    expect(element).not.toBe(first);
    return element;
  });
}

beforeEach(() => {
  let next = 0;
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: () => {
      next += 1;
      return `blob:video-${next}`;
    },
    revokeObjectURL: () => {},
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("<VideoViewer /> recovery", () => {
  it("refreshes once on a media error and reloads the element when the host answers the same URL", async () => {
    const rpc = host([answer(signed(URL_A))]);
    renderViewer(rpc);
    const first = await screen.findByTestId("epic-file-video");

    fireEvent.error(first);

    await waitFor(() => expect(urlReads(rpc)).toBe(2));
    await waitFor(() => expect(video()).not.toBe(first));
    expect(video().getAttribute("src")).toBe(URL_A);
    expect(rangeReads(rpc)).toBe(0);
  });

  it("swaps a refreshed URL into the same element", async () => {
    const rpc = host([answer(signed(URL_A)), answer(signed(URL_B))]);
    renderViewer(rpc);
    const first = await screen.findByTestId("epic-file-video");

    fireEvent.error(first);

    await waitFor(() => expect(video().getAttribute("src")).toBe(URL_B));
    expect(video()).toBe(first);
  });

  it("falls through to the Blob on a second error before the element plays, then to Download only", async () => {
    const rpc = host([answer(signed(URL_A))]);
    renderViewer(rpc);
    const reloaded = await errorAndReload();

    fireEvent.error(reloaded);

    await waitFor(() =>
      expect(video().getAttribute("src")).toMatch(/^blob:video-/),
    );
    expect(rangeReads(rpc)).toBe(1);
    expect(urlReads(rpc)).toBe(2);

    fireEvent.error(video());

    expect(
      await screen.findByText(/can't be played here\. Download it/),
    ).toBeTruthy();
  });

  it("gives a later failure its own refresh once the element has played again", async () => {
    const rpc = host([answer(signed(URL_A))]);
    renderViewer(rpc);
    const reloaded = await errorAndReload();

    fireEvent.loadedData(reloaded);
    fireEvent.error(reloaded);

    await waitFor(() => expect(urlReads(rpc)).toBe(3));
    expect(rangeReads(rpc)).toBe(0);
  });

  it("keeps a playing element when a background renewal fails", async () => {
    const rpc = host([
      answer(signed(URL_A)),
      () => Promise.reject(new Error("relay dropped")),
    ]);
    const client = renderViewer(rpc);
    const first = await screen.findByTestId("epic-file-video");

    await act(() => client.refetchQueries());

    expect(urlReads(rpc)).toBe(2);
    expect(video()).toBe(first);
    expect(video().getAttribute("src")).toBe(URL_A);
  });

  it("reads an unpublished video into a Blob", async () => {
    const rpc = host([
      answer({ kind: "unavailable", reason: "upload-pending" }),
    ]);
    renderViewer(rpc);

    await waitFor(() =>
      expect(video().getAttribute("src")).toMatch(/^blob:video-/),
    );
    expect(rangeReads(rpc)).toBe(1);
  });

  it("returns to the signed URL once the file is published", async () => {
    const rpc = host([
      answer({ kind: "unavailable", reason: "upload-pending" }),
      answer(signed(URL_A)),
    ]);
    const client = renderViewer(rpc);
    await waitFor(() =>
      expect(video().getAttribute("src")).toMatch(/^blob:video-/),
    );

    await act(() => client.refetchQueries());

    await waitFor(() => expect(video().getAttribute("src")).toBe(URL_A));
  });
});
