import type {
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";

/**
 * Prints where the first test on each worker spent its time: when it began
 * and ended on this process's clock, the duration the worker reported, and
 * its steps (hooks, fixtures such as the browser launch, and each Playwright
 * call). The JSON report carries none of this, and a trace for every test
 * costs a third of CI's test time (`playwright.config.ts`), so a budget
 * overrun on a worker's first test left nothing to read.
 */
export default class FirstTestTimingReporter implements Reporter {
  private runBegan = 0;
  private readonly beganAtByTestId = new Map<string, number>();
  private readonly reportedWorkers = new Set<number>();

  onBegin(): void {
    this.runBegan = Date.now();
  }

  onTestBegin(test: TestCase): void {
    this.beganAtByTestId.set(test.id, Date.now());
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const beganAt = this.beganAtByTestId.get(test.id);
    this.beganAtByTestId.delete(test.id);
    if (beganAt === undefined || this.reportedWorkers.has(result.workerIndex)) {
      return;
    }
    this.reportedWorkers.add(result.workerIndex);
    const lines = [
      `first test on worker ${String(result.workerIndex)}: ${test.titlePath().slice(2).join(" › ")}`,
      `  began ${String(beganAt - this.runBegan)} ms and ended ${String(Date.now() - this.runBegan)} ms after the run began; reported ${String(result.duration)} ms`,
      ...stepLines(result.steps, 1),
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  printsToStdio(): boolean {
    return false;
  }
}

function stepLines(steps: readonly TestStep[], depth: number): string[] {
  return steps.flatMap((step) => [
    `${"  ".repeat(depth)}${String(step.duration)} ms  ${step.category}: ${step.title}`,
    ...stepLines(step.steps, depth + 1),
  ]);
}
