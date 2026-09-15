/**
 * The shared lazy viewer owns the code-split lifecycle for PDF and Word.
 * These tests deliberately construct it directly so both formats exercise the
 * same React.lazy/Suspense cache and local error boundary without importing a
 * renderer chunk or a format-specific loader module.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, type ReactNode } from "react";
import {
  createLazyDocumentViewer,
  type LazyDocumentViewerProps,
  type DocumentViewerProps,
} from "../lazy-document-viewer";

const errorSummary = vi.hoisted(() => vi.fn());

vi.mock("@/lib/logger", () => ({
  appLogger: {
    errorSummary,
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

type ViewerModule = {
  readonly default: (props: DocumentViewerProps) => ReactNode;
};

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

const VIEWER_PROPS: DocumentViewerProps = {
  url: "blob:document-bytes",
  fileName: "report.docx",
  compact: false,
  toolbarActions: null,
  onRenderFailure: vi.fn(),
};

function FakeViewer(props: DocumentViewerProps): ReactNode {
  return <div data-testid="fake-viewer" data-url={props.url} />;
}

function makeLazyViewer(
  load: () => Promise<ViewerModule>,
): (props: LazyDocumentViewerProps) => ReactNode {
  return createLazyDocumentViewer({ load, logTag: "document-preview" });
}

function child(
  Viewer: (props: LazyDocumentViewerProps) => ReactNode,
  onUnavailable: () => void,
): ReactNode {
  return <Viewer {...VIEWER_PROPS} onUnavailable={onUnavailable} />;
}

function childWithProps(
  Viewer: (props: LazyDocumentViewerProps) => ReactNode,
  onUnavailable: () => void,
  overrides: Partial<DocumentViewerProps>,
): ReactNode {
  return (
    <Viewer {...VIEWER_PROPS} {...overrides} onUnavailable={onUnavailable} />
  );
}

describe("createLazyDocumentViewer", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shares one successful load across concurrent viewers and forwards props", async () => {
    const deferred = new Deferred<ViewerModule>();
    const load = vi.fn(() => deferred.promise);
    const Viewer = makeLazyViewer(load);
    const firstUnavailable = vi.fn();
    const secondUnavailable = vi.fn();

    const { container } = render(
      <>
        {child(Viewer, firstUnavailable)}
        {childWithProps(Viewer, secondUnavailable, { url: "blob:other-bytes" })}
      </>,
    );

    expect(
      container.querySelectorAll('[data-testid="fake-viewer"]'),
    ).toHaveLength(0);
    expect(load).toHaveBeenCalledTimes(1);

    deferred.resolve({ default: FakeViewer });

    await waitFor(() =>
      expect(screen.getAllByTestId("fake-viewer")).toHaveLength(2),
    );
    expect(
      screen.getAllByTestId("fake-viewer")[0].getAttribute("data-url"),
    ).toBe("blob:document-bytes");
    expect(
      screen.getAllByTestId("fake-viewer")[1].getAttribute("data-url"),
    ).toBe("blob:other-bytes");
    expect(firstUnavailable).not.toHaveBeenCalled();
    expect(secondUnavailable).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shares a rejected load across viewers and reports unavailable once per viewer", async () => {
    const deferred = new Deferred<ViewerModule>();
    const load = vi.fn(() => deferred.promise);
    const Viewer = makeLazyViewer(load);
    const firstUnavailable = vi.fn();
    const secondUnavailable = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const { container } = render(
      <>
        {child(Viewer, firstUnavailable)}
        {child(Viewer, secondUnavailable)}
      </>,
    );
    deferred.reject(new Error("viewer chunk failed"));

    await waitFor(() => {
      expect(firstUnavailable).toHaveBeenCalledTimes(1);
      expect(secondUnavailable).toHaveBeenCalledTimes(1);
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(
      container.querySelectorAll('[data-testid="fake-viewer"]'),
    ).toHaveLength(0);
    expect(errorSummary).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("reports each rejected viewer once under StrictMode", async () => {
    const deferred = new Deferred<ViewerModule>();
    const load = vi.fn(() => deferred.promise);
    const Viewer = makeLazyViewer(load);
    const firstUnavailable = vi.fn();
    const secondUnavailable = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    render(
      <StrictMode>
        {child(Viewer, firstUnavailable)}
        {child(Viewer, secondUnavailable)}
      </StrictMode>,
    );
    deferred.reject(new Error("strict viewer chunk failed"));

    await waitFor(() => {
      expect(firstUnavailable).toHaveBeenCalledTimes(1);
      expect(secondUnavailable).toHaveBeenCalledTimes(1);
    });
    expect(load).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("keeps a cached rejection for a later mount without retrying the load", async () => {
    const deferred = new Deferred<ViewerModule>();
    const load = vi.fn(() => deferred.promise);
    const Viewer = makeLazyViewer(load);
    const firstUnavailable = vi.fn();
    const secondUnavailable = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const first = render(child(Viewer, firstUnavailable));
    deferred.reject(new Error("cached viewer failure"));
    await waitFor(() => expect(firstUnavailable).toHaveBeenCalledTimes(1));

    first.unmount();
    render(child(Viewer, secondUnavailable));
    await waitFor(() => expect(secondUnavailable).toHaveBeenCalledTimes(1));

    expect(load).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it.each([
    ["resolution", false],
    ["rejection", true],
  ] as const)(
    "does not report a late %s after unmount",
    async (_label, reject) => {
      const deferred = new Deferred<ViewerModule>();
      const load = vi.fn(() => deferred.promise);
      const Viewer = makeLazyViewer(load);
      const onUnavailable = vi.fn();
      const { container, unmount } = render(child(Viewer, onUnavailable));

      unmount();
      if (reject) deferred.reject(new Error("late failure"));
      else deferred.resolve({ default: FakeViewer });
      await Promise.resolve();
      await Promise.resolve();

      expect(onUnavailable).not.toHaveBeenCalled();
      expect(container.innerHTML).toBe("");
    },
  );

  it.each([
    [
      "render",
      (): ReactNode => {
        throw new Error("render setup failure");
      },
    ],
    [
      "effect",
      (): ReactNode => {
        useEffect(() => {
          throw new Error("effect setup failure");
        }, []);
        return <div data-testid="fake-viewer" />;
      },
    ],
  ] as const)(
    "reports %s failure as unavailable",
    async (_label, FailingViewer) => {
      const Viewer = makeLazyViewer(() =>
        Promise.resolve({ default: FailingViewer }),
      );
      const onUnavailable = vi.fn();
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const { container } = render(child(Viewer, onUnavailable));

      await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));
      expect(container.textContent).toBe("");
      expect(VIEWER_PROPS.onRenderFailure).not.toHaveBeenCalled();
      consoleError.mockRestore();
    },
  );

  it("reports a synchronous setup failure once under StrictMode", async () => {
    const FailingViewer = (): ReactNode => {
      useEffect(() => {
        throw new Error("strict effect setup failure");
      }, []);
      return <div data-testid="fake-viewer" />;
    };
    const Viewer = makeLazyViewer(() =>
      Promise.resolve({ default: FailingViewer }),
    );
    const onUnavailable = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    render(<StrictMode>{child(Viewer, onUnavailable)}</StrictMode>);

    await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));
    consoleError.mockRestore();
  });

  it("keeps document decode failure separate from viewer unavailability", async () => {
    const onRenderFailure = vi.fn();
    const DecodeFailingViewer = (props: DocumentViewerProps): ReactNode => {
      const reportFailure = props.onRenderFailure;
      useEffect(() => {
        reportFailure();
      }, [reportFailure]);
      return <div data-testid="fake-viewer" />;
    };
    const Viewer = makeLazyViewer(() =>
      Promise.resolve({ default: DecodeFailingViewer }),
    );
    const onUnavailable = vi.fn();

    render(childWithProps(Viewer, onUnavailable, { onRenderFailure }));

    await waitFor(() => expect(onRenderFailure).toHaveBeenCalledTimes(1));
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(screen.getByTestId("fake-viewer")).not.toBeNull();
  });
});
