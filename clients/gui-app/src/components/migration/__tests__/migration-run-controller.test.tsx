import "../../../../__tests__/test-browser-apis";
import { act, cleanup, render } from "@testing-library/react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { ExternalToast } from "sonner";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type {
  MigrationStreamCallbacks,
  MigrationStreamClientOptions,
} from "@traycer-clients/shared/host-transport/migration-stream-client";

interface MigrationClientHarness {
  callbacks: MigrationStreamCallbacks | null;
  readonly close: Mock<() => void>;
}

const migrationClient = vi.hoisted((): MigrationClientHarness => ({
  callbacks: null,
  close: vi.fn(),
}));
const invalidateQueries = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const toastSuccess = vi.hoisted(() =>
  vi.fn<(message: ReactNode, options: ExternalToast | undefined) => string>(
    () => "success-toast",
  ),
);
const toastWarning = vi.hoisted(() =>
  vi.fn<(message: ReactNode, options: ExternalToast | undefined) => string>(
    () => "warning-toast",
  ),
);

vi.mock(
  "@traycer-clients/shared/host-transport/migration-stream-client",
  () => ({
    MigrationStreamClient: class {
      constructor(options: MigrationStreamClientOptions) {
        migrationClient.callbacks = options.callbacks;
      }

      close(): void {
        migrationClient.close();
      }
    },
  }),
);

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccess,
    warning: toastWarning,
  },
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({ getActiveHostId: () => "host-test" }),
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => ({ stream: "test" }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ migration: null }),
}));

import {
  getMigrationStartHandle,
  setMigrationStartHandle,
} from "@/components/migration/migration-run-handle";
import { MigrationRunController } from "@/components/migration/migration-run-controller";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useMigrationRunStore } from "@/stores/migration/migration-run-store";

beforeEach(() => {
  migrationClient.callbacks = null;
  migrationClient.close.mockClear();
  invalidateQueries.mockClear();
  toastSuccess.mockClear();
  toastWarning.mockClear();
  setMigrationStartHandle(null);
  useMigrationRunStore.getState().reset();
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
    reportIssueDraftId: 0,
  });
});

afterEach(() => {
  cleanup();
  setMigrationStartHandle(null);
  useMigrationRunStore.getState().reset();
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
    reportIssueDraftId: 0,
  });
});

describe("<MigrationRunController />", () => {
  it("keeps incomplete migration results as privacy-safe reportable warnings", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    render(<MigrationRunController />);

    completeMigration(false);

    expect(toastWarning.mock.lastCall?.[0]).toBe(
      "Migration re-attempt incomplete. Some local data still needs migration.",
    );
    expect(readWarningOptions().cancel).toMatchObject({
      label: "Report issue",
    });
    clickWarningReportAction();
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Migration incomplete",
      message: null,
      code: null,
      source: "Data migration",
    });
    expect(
      JSON.stringify(useDesktopDialogStore.getState().reportIssueContext),
    ).not.toMatch(/taskChains|epicsFailed|replaysIncomplete|host-test/);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("omits the report action when reporting is unavailable", () => {
    render(<MigrationRunController />);

    completeMigration(false);

    expect(toastWarning).toHaveBeenCalledWith(
      "Migration re-attempt incomplete. Some local data still needs migration.",
    );
  });

  it("leaves successful migration notifications unchanged", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    render(<MigrationRunController />);

    completeMigration(true);

    expect(toastSuccess).toHaveBeenCalledWith("Migration re-attempt complete.");
    expect(toastWarning).not.toHaveBeenCalled();
  });
});

function completeMigration(success: boolean): void {
  const startHandle = getMigrationStartHandle();
  if (startHandle === null) {
    throw new Error("Expected a migration start handle.");
  }
  act(() => {
    startHandle.start();
  });
  const callbacks = migrationClient.callbacks;
  if (callbacks === null) {
    throw new Error("Expected migration callbacks.");
  }
  act(() => {
    callbacks.onComplete({
      success,
      counts: {
        taskChainsComplete: 1,
        taskChainsSkipped: 2,
        taskChainsFailed: 3,
        epicsComplete: 4,
        epicsFailed: 5,
        replaysIncomplete: 6,
      },
    });
  });
}

function clickWarningReportAction(): void {
  const cancel = readWarningOptions().cancel;
  if (typeof cancel !== "object" || cancel === null || !("onClick" in cancel)) {
    throw new Error("Expected a warning report action.");
  }
  cancel.onClick({} as ReactMouseEvent<HTMLButtonElement>);
}

function readWarningOptions(): ExternalToast {
  const options = toastWarning.mock.lastCall?.[1];
  if (options === undefined) {
    throw new Error("Expected warning toast options.");
  }
  return options;
}
