import { vi } from "vitest";

// What the real settings panel reaches through the host runtime: the model
// picker and the usage dialog. The panel's own suite stubs the same two.
vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: () => <div data-testid="stub-harness-model-picker" />,
}));
vi.mock("@/components/epic-canvas/panels/epic-usage-dialog", () => ({
  EpicUsageDialog: () => null,
}));
vi.mock("@/hooks/usage-analytics/use-usage-summary-support", () => ({
  useUsageSummarySupported: () => false,
}));
