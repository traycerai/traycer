import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SecretExportNoticeLine } from "@/components/notifications/secret-export-notice-line";
import type { SecretsNotificationDetail } from "@/lib/notifications/secrets-notification-detail";

type ExportMintedDetail = Extract<
  SecretsNotificationDetail,
  { kind: "export-minted" }
>;

function textOf(testId: string): string {
  return screen.getByTestId(testId).textContent;
}

afterEach(cleanup);

describe("<SecretExportNoticeLine />", () => {
  const EXPORT: ExportMintedDetail = {
    kind: "export-minted",
    secretName: "DEPLOY_KEY",
    exportKind: "presigned_url",
    expiresAt: new Date(2026, 9, 12, 14, 32).getTime(),
  };

  it("renders the notice naming the secret and what was minted", () => {
    render(<SecretExportNoticeLine detail={EXPORT} />);
    const text = textOf("secret-export-notice");
    expect(text).toContain(
      "An agent minted a presigned URL from DEPLOY_KEY. It works until",
    );
    expect(text).toContain("wherever it is copied.");
  });

  it("states the expiry as a date and a time in the reader's locale", () => {
    render(<SecretExportNoticeLine detail={EXPORT} />);
    const expiry = new Date(EXPORT.expiresAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(textOf("secret-export-notice")).toContain(
      `It works until ${expiry} wherever`,
    );
  });
});
