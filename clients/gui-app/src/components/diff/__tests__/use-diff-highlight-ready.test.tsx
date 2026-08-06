import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { FileContents, FileDiffMetadata } from "@pierre/diffs";
import {
  useDiffsDiffHighlightReady,
  useDiffsFileHighlightReady,
} from "@/components/diff/use-diff-highlight-ready";
import { DiffHighlightLoading } from "@/components/diff/diff-highlight-loading";

const poolState = vi.hoisted(() => ({
  pool: undefined as
    | undefined
    | {
        setRenderOptions: Mock;
        primeFileHighlightCache: Mock;
        primeDiffHighlightCache: Mock;
      },
}));

vi.mock("@pierre/diffs/react", () => ({
  useWorkerPool: () => poolState.pool,
  EditProvider: (props: { readonly children: unknown }) => props.children,
}));

describe("useDiffs highlight gates", () => {
  beforeEach(() => {
    poolState.pool = undefined;
  });

  afterEach(() => {
    cleanup();
  });

  it("treats a missing worker pool as ready so main-thread render can proceed", () => {
    render(<FileReadyProbe file={sampleFile()} theme="pierre-dark" enabled />);
    expect(screen.getByTestId("ready").textContent).toBe("ready");
  });

  it("keeps the file surface gated until primeFileHighlightCache resolves", async () => {
    let resolvePrime: (() => void) | null = null;
    const primePromise = new Promise<void>((resolve) => {
      resolvePrime = resolve;
    });
    const setRenderOptions = vi.fn(() => Promise.resolve());
    const primeFileHighlightCache = vi.fn(() => primePromise);
    poolState.pool = {
      setRenderOptions,
      primeFileHighlightCache,
      primeDiffHighlightCache: vi.fn(() => Promise.resolve()),
    };

    render(<FileReadyProbe file={sampleFile()} theme="pierre-dark" enabled />);

    expect(screen.getByTestId("ready").textContent).toBe("pending");
    await waitFor(() => {
      expect(primeFileHighlightCache).toHaveBeenCalledWith(sampleFile());
    });
    expect(setRenderOptions).not.toHaveBeenCalled();

    await act(async () => {
      resolvePrime?.();
      await primePromise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("ready");
    });
  });

  it("keeps the diff surface gated until every primeDiffHighlightCache call resolves", async () => {
    let resolvePrime: (() => void) | null = null;
    const primePromise = new Promise<void>((resolve) => {
      resolvePrime = resolve;
    });
    const setRenderOptions = vi.fn(() => Promise.resolve());
    const primeDiffHighlightCache = vi.fn(() => primePromise);
    poolState.pool = {
      setRenderOptions,
      primeFileHighlightCache: vi.fn(() => Promise.resolve()),
      primeDiffHighlightCache,
    };
    const fileDiffs = [sampleDiff("a.ts"), sampleDiff("b.ts")];

    render(
      <DiffReadyProbe fileDiffs={fileDiffs} theme="pierre-light" enabled />,
    );

    expect(screen.getByTestId("ready").textContent).toBe("pending");
    await waitFor(() => {
      expect(primeDiffHighlightCache).toHaveBeenCalledTimes(2);
    });
    expect(setRenderOptions).not.toHaveBeenCalled();

    await act(async () => {
      resolvePrime?.();
      await primePromise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("ready");
    });
  });

  it("never closes an already released file surface for later cache misses", async () => {
    let resolveFirst: (() => void) | null = null;
    const firstPrime = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const neverSettles = new Promise<void>(() => undefined);
    const primeFileHighlightCache = vi
      .fn()
      .mockReturnValueOnce(firstPrime)
      .mockReturnValueOnce(neverSettles);
    poolState.pool = {
      setRenderOptions: vi.fn(() => Promise.resolve()),
      primeFileHighlightCache,
      primeDiffHighlightCache: vi.fn(() => Promise.resolve()),
    };
    const rendered = render(
      <FileReadyProbe file={sampleFile()} theme="pierre-dark" enabled />,
    );
    await act(async () => {
      resolveFirst?.();
      await firstPrime;
    });
    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("ready");
    });

    rendered.rerender(
      <FileReadyProbe
        file={{ ...sampleFile(), contents: "const value = 2;\n" }}
        theme="pierre-light"
        enabled
      />,
    );

    expect(screen.getByTestId("ready").textContent).toBe("ready");
    await waitFor(() => {
      expect(primeFileHighlightCache).toHaveBeenCalledTimes(2);
    });
  });

  it("renders DiffHighlightLoading with the requested test id", () => {
    render(<DiffHighlightLoading testId="workspace-file-highlighting" />);
    expect(screen.getByTestId("workspace-file-highlighting")).toBeTruthy();
  });
});

function FileReadyProbe(props: {
  readonly file: FileContents;
  readonly theme: "pierre-dark" | "pierre-light";
  readonly enabled: boolean;
}) {
  const ready = useDiffsFileHighlightReady(props);
  return <div data-testid="ready">{ready ? "ready" : "pending"}</div>;
}

function DiffReadyProbe(props: {
  readonly fileDiffs: ReadonlyArray<FileDiffMetadata>;
  readonly theme: "pierre-dark" | "pierre-light";
  readonly enabled: boolean;
}) {
  const ready = useDiffsDiffHighlightReady(props);
  return <div data-testid="ready">{ready ? "ready" : "pending"}</div>;
}

function sampleFile(): FileContents {
  return {
    name: "source.ts",
    contents: "const value = 1;\n",
    lang: "typescript",
    cacheKey: "workspace-file:source.ts",
  };
}

function sampleDiff(name: string): FileDiffMetadata {
  return { name } as FileDiffMetadata;
}
