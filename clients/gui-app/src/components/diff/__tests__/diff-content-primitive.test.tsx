import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  DiffContentFrame,
  DiffContentPrimitive,
} from "@/components/diff/diff-content-primitive";

const captured = vi.hoisted<{ overflows: Array<"wrap" | "scroll"> }>(() => ({
  overflows: [],
}));

vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: () => [
    {
      files: [{ name: "src/app.ts" }],
    },
  ],
}));

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: (props: {
    readonly options: { readonly overflow: "wrap" | "scroll" };
  }) => {
    captured.overflows.push(props.options.overflow);
    return <div data-testid="file-diff" />;
  },
}));

vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({
    resolvedTheme: "light",
    themePreset: "neutral",
  }),
}));

describe("<DiffContentPrimitive />", () => {
  afterEach(() => {
    cleanup();
    captured.overflows = [];
  });

  it("honors wordWrap=false for content-sized diffs", () => {
    render(
      <DiffContentFrame
        sizing="content"
        banner={null}
        scrollContainerRef={null}
        onScroll={null}
      >
        <DiffContentPrimitive
          patch="@@ -1 +1 @@\n-old\n+new\n"
          cacheScope="test"
          mode="unified"
          wordWrap={false}
          backgrounds
          lineNumbers
          indicatorStyle="bars"
          fileHeaders={false}
        />
      </DiffContentFrame>,
    );

    expect(captured.overflows).toEqual(["scroll"]);
  });
});
