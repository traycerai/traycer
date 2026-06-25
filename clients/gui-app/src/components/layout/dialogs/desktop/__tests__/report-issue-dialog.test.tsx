import "../../../../../../__tests__/test-browser-apis";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { ReportIssueDialog } from "../report-issue-dialog";

function renderDialog(): void {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <ReportIssueDialog open onOpenChange={() => {}} support={null} />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

describe("ReportIssueDialog", () => {
  it("gives every field's control a programmatic label", () => {
    renderDialog();

    // queryByLabelText resolves only when the visible <Label> is associated
    // with the control (htmlFor -> id), which is the accessibility contract
    // this form must keep - screen readers announce the name and clicking the
    // label focuses the input.
    for (const fieldLabel of [
      "Title",
      "What happened?",
      "Steps to reproduce",
      "Expected behavior",
      "Actual behavior",
    ]) {
      expect(screen.queryByLabelText(fieldLabel)).not.toBeNull();
    }
  });
});
