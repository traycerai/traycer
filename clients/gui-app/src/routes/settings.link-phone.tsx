import { createFileRoute } from "@tanstack/react-router";
import { LinkPhonePanel } from "@/components/settings/panels/link-phone-panel";

export const Route = createFileRoute("/settings/link-phone")({
  component: LinkPhonePanel,
});
