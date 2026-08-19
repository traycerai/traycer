import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type {
  ImportLegacyPlainTerminalRequest,
  ImportLegacyPlainTerminalResponse,
  PlainTerminalProjection,
} from "@traycer/protocol/host/terminal/plain-schemas";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";

interface AuthorityTestState {
  capability: "unknown" | "legacy" | "capable";
  canMutate: boolean;
  terminalsById: Record<string, PlainTerminalProjection | undefined>;
  importLegacy: Mock<
    (
      request: ImportLegacyPlainTerminalRequest,
    ) => Promise<ImportLegacyPlainTerminalResponse>
  >;
  importError: boolean;
  importReset: Mock<() => void>;
}

const authorityState = vi.hoisted((): AuthorityTestState => ({
  capability: "capable",
  canMutate: true,
  terminalsById: {},
  importLegacy:
    vi.fn<
      (
        request: ImportLegacyPlainTerminalRequest,
      ) => Promise<ImportLegacyPlainTerminalResponse>
    >(),
  importError: false,
  importReset: vi.fn<() => void>(),
}));

vi.mock("@/hooks/terminal/use-plain-terminal-authority", () => ({
  useTabPlainTerminalAuthority: (scope: { kind: "epic"; epicId: string }) => ({
    hostId: "host-1",
    scope,
    capability: { status: authorityState.capability },
    collection: {
      terminalsById: authorityState.terminalsById,
      streamStatus: "open",
      streamCompatibility: "compatible",
      streamSnapshotFresh: true,
    },
    terminals: Object.values(authorityState.terminalsById),
    canMutate: authorityState.canMutate,
    query: {},
  }),
}));

vi.mock("@/hooks/terminal/use-plain-terminal-mutations", () => ({
  useTabPlainTerminalMutations: () => ({
    create: {},
    ensureRunning: {},
    rename: {},
    close: {},
    importLegacy: {
      isError: authorityState.importError,
      mutateAsync: authorityState.importLegacy,
      reset: authorityState.importReset,
    },
  }),
}));

import { useEpicTerminalAuthority } from "../use-epic-terminal-authority";

function projection(args: {
  readonly terminalId: string;
  readonly manualTitle?: string | null;
}): PlainTerminalProjection {
  return {
    record: {
      terminalId: args.terminalId,
      hostId: "host-1",
      scope: { kind: "epic", epicId: "epic-1" },
      launch: {
        cwd: "/canonical",
        shellCommand: "/bin/zsh",
        shellArgs: ["-l"],
      },
      manualTitle: args.manualTitle ?? null,
      revision: 7,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    },
    runtime: { status: "dormant" },
  };
}

function legacyRef(id: string, instanceId: string): EpicTerminalRef {
  return {
    id,
    instanceId,
    type: "terminal",
    name: "Local presentation",
    titleSource: "manual",
    hostId: "host-1",
    cwd: "/legacy",
  };
}

function HookHarness(props: { readonly instanceId: string }) {
  const node = useEpicCanvasStore((state) =>
    Object.values(state.canvasByTabId)
      .flatMap((canvas) =>
        canvas === undefined
          ? []
          : [canvas.tilesByInstanceId[props.instanceId]],
      )
      .find((candidate) => candidate?.type === "terminal"),
  );
  if (node?.type !== "terminal") return null;
  return <Controller node={node} />;
}

function Controller(props: { readonly node: EpicTerminalRef }) {
  const controller = useEpicTerminalAuthority({
    epicId: "epic-1",
    node: props.node,
  });
  return (
    <div
      data-testid={`authority-${props.node.instanceId}`}
      data-ref-authority={controller.refAuthority}
      data-capability={controller.capability}
      data-can-mutate={String(controller.canMutate)}
    />
  );
}

function openRef(ref: EpicTerminalRef): string {
  const store = useEpicCanvasStore.getState();
  const viewTabId = store.openEpicTab("epic-1", "Epic");
  store.openTileInTab(viewTabId, ref);
  return viewTabId;
}

beforeEach(() => {
  window.localStorage.clear();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  authorityState.capability = "capable";
  authorityState.canMutate = true;
  authorityState.terminalsById = {};
  authorityState.importLegacy.mockReset();
  authorityState.importReset.mockReset();
  authorityState.importError = false;
});

afterEach(cleanup);

describe("useEpicTerminalAuthority", () => {
  it("adopts the host winner while preserving local canvas presentation identity", async () => {
    const ref = legacyRef("terminal-ack", "instance-ack");
    const winner = projection({
      terminalId: ref.id,
      manualTitle: "Host winner",
    });
    authorityState.importLegacy.mockImplementation(() => {
      authorityState.terminalsById[ref.id] = winner;
      return Promise.resolve({ status: "existing", terminal: winner });
    });
    const viewTabId = openRef(ref);
    const before = useEpicCanvasStore.getState().canvasByTabId[viewTabId];

    render(<HookHarness instanceId={ref.instanceId} />);

    await waitFor(() => {
      const after = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
      expect(after?.tilesByInstanceId[ref.instanceId]).toMatchObject({
        id: ref.id,
        instanceId: ref.instanceId,
        authority: "host",
        name: ref.name,
        legacyFallback: {
          name: "Host winner",
          cwd: "/canonical",
          shellCommand: "/bin/zsh",
        },
      });
    });
    const after = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
    expect(after?.root).toBe(before?.root);
    expect(after?.sizesByGroupId).toBe(before?.sizesByGroupId);
    expect(after?.activePaneId).toBe(before?.activePaneId);
  });

  it("keeps legacy evidence untouched when import fails", async () => {
    const ref = legacyRef("terminal-failed", "instance-failed");
    authorityState.importLegacy.mockRejectedValue(new Error("offline"));
    const viewTabId = openRef(ref);

    render(<HookHarness instanceId={ref.instanceId} />);

    await waitFor(() => expect(authorityState.importLegacy).toHaveBeenCalled());
    expect(
      useEpicCanvasStore.getState().canvasByTabId[viewTabId]?.tilesByInstanceId[
        ref.instanceId
      ],
    ).toEqual(ref);
  });

  it("deduplicates a concurrent import and all local refs adopt its winner", async () => {
    const first = legacyRef("terminal-race", "instance-race-a");
    const second = legacyRef("terminal-race", "instance-race-b");
    const winner = projection({ terminalId: first.id });
    let acknowledge:
      | ((value: {
          readonly status: "existing";
          readonly terminal: PlainTerminalProjection;
        }) => void)
      | undefined;
    authorityState.importLegacy.mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    openRef(first);
    openRef(second);

    render(
      <>
        <HookHarness instanceId={first.instanceId} />
        <HookHarness instanceId={second.instanceId} />
      </>,
    );

    await waitFor(() =>
      expect(authorityState.importLegacy).toHaveBeenCalledTimes(1),
    );
    authorityState.terminalsById[first.id] = winner;
    acknowledge?.({ status: "existing", terminal: winner });

    await waitFor(() => {
      const refs = Object.values(useEpicCanvasStore.getState().canvasByTabId)
        .flatMap((canvas) =>
          canvas === undefined ? [] : Object.values(canvas.tilesByInstanceId),
        )
        .filter((ref) => ref?.id === first.id);
      expect(refs).toHaveLength(2);
      expect(
        refs.every(
          (ref) => ref?.type === "terminal" && ref.authority === "host",
        ),
      ).toBe(true);
    });
  });

  it("leaves canonical omission fanout to the shared stream acceptance boundary", () => {
    const ref: EpicTerminalRef = {
      id: "terminal-deleted",
      instanceId: "instance-deleted",
      type: "terminal",
      name: "Presentation",
      hostId: "host-1",
      authority: "host",
      legacyFallback: {
        name: "Fallback",
        titleSource: "manual",
        cwd: "/fallback",
      },
    };
    const viewTabId = openRef(ref);

    render(<HookHarness instanceId={ref.instanceId} />);

    expect(
      useEpicCanvasStore.getState().canvasByTabId[viewTabId]?.tilesByInstanceId[
        ref.instanceId
      ],
    ).toEqual(ref);
    expect(authorityState.importLegacy).not.toHaveBeenCalled();
  });

  it("does not multiply a later authoritative omission per mounted ref", () => {
    const ref: EpicTerminalRef = {
      id: "terminal-natural-exit",
      instanceId: "instance-natural-exit",
      type: "terminal",
      name: "Presentation",
      hostId: "host-1",
      authority: "host",
      legacyFallback: {
        name: "Fallback",
        titleSource: "manual",
        cwd: "/fallback",
      },
    };
    authorityState.terminalsById = {
      [ref.id]: projection({ terminalId: ref.id }),
    };
    const viewTabId = openRef(ref);
    const rendered = render(<HookHarness instanceId={ref.instanceId} />);

    expect(
      useEpicCanvasStore.getState().canvasByTabId[viewTabId]?.tilesByInstanceId[
        ref.instanceId
      ],
    ).toEqual(ref);

    authorityState.terminalsById = {};
    rendered.rerender(<HookHarness instanceId={ref.instanceId} />);

    expect(
      useEpicCanvasStore.getState().canvasByTabId[viewTabId]?.tilesByInstanceId[
        ref.instanceId
      ],
    ).toEqual(ref);
    expect(authorityState.importLegacy).not.toHaveBeenCalled();
  });

  it("preserves released legacy behavior against an old host", async () => {
    authorityState.capability = "legacy";
    const ref = legacyRef("terminal-old-host", "instance-old-host");
    const viewTabId = openRef(ref);

    render(<HookHarness instanceId={ref.instanceId} />);

    await waitFor(() => {
      expect(
        useEpicCanvasStore.getState().canvasByTabId[viewTabId]
          ?.tilesByInstanceId[ref.instanceId],
      ).toEqual(ref);
    });
    expect(authorityState.importLegacy).not.toHaveBeenCalled();
  });

  it("does not import a provider-login ref against a capable host", async () => {
    const ref: EpicTerminalRef = {
      ...legacyRef("terminal-signin", "instance-signin"),
      origin: "provider-login",
      originProviderId: "copilot",
    };
    const viewTabId = openRef(ref);

    const rendered = render(<HookHarness instanceId={ref.instanceId} />);

    await Promise.resolve();
    await Promise.resolve();
    expect(authorityState.importLegacy).not.toHaveBeenCalled();
    expect(
      useEpicCanvasStore.getState().canvasByTabId[viewTabId]?.tilesByInstanceId[
        ref.instanceId
      ],
    ).toEqual(ref);
    const controller = rendered.getByTestId(`authority-${ref.instanceId}`);
    expect(controller.dataset.capability).toBe("legacy");
  });

  it("does not import a setup ref against a capable host", async () => {
    const ref: EpicTerminalRef = {
      ...legacyRef("terminal-setup", "instance-setup"),
      origin: "setup",
    };
    const viewTabId = openRef(ref);

    const rendered = render(<HookHarness instanceId={ref.instanceId} />);

    await Promise.resolve();
    await Promise.resolve();
    expect(authorityState.importLegacy).not.toHaveBeenCalled();
    expect(
      useEpicCanvasStore.getState().canvasByTabId[viewTabId]?.tilesByInstanceId[
        ref.instanceId
      ],
    ).toEqual(ref);
    const controller = rendered.getByTestId(`authority-${ref.instanceId}`);
    expect(controller.dataset.capability).toBe("legacy");
  });

  it("never imports or mutates an unsupported future-authority ref", () => {
    const ref: EpicTerminalRef = {
      id: "terminal-host-v2",
      instanceId: "instance-host-v2",
      type: "terminal",
      name: "Future presentation",
      hostId: "host-1",
      authority: "unsupported",
      rawAuthority: "host-v2",
      legacyFallback: {
        name: "Rollback only",
        titleSource: "manual",
        cwd: "/rollback-only",
      },
    };
    authorityState.terminalsById = {
      [ref.id]: projection({ terminalId: ref.id }),
    };
    const viewTabId = openRef(ref);

    const rendered = render(<HookHarness instanceId={ref.instanceId} />);

    const controller = rendered.getByTestId(`authority-${ref.instanceId}`);
    expect(controller.dataset.refAuthority).toBe("unsupported");
    expect(controller.dataset.capability).toBe("unknown");
    expect(controller.dataset.canMutate).toBe("false");
    expect(authorityState.importLegacy).not.toHaveBeenCalled();
    expect(
      useEpicCanvasStore.getState().canvasByTabId[viewTabId]?.tilesByInstanceId[
        ref.instanceId
      ],
    ).toEqual(ref);
  });
});
