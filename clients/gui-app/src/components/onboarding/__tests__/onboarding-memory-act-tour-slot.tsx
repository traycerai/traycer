import { useEffect, useState } from "react";
import { OnboardingPage } from "@/components/onboarding/onboarding-page";

/** The tour, which a test can take out of the page while the host stays. */
export function TourSlot(props: {
  readonly onMount: (leave: () => void) => void;
}) {
  const [mounted, setMounted] = useState(true);
  const { onMount } = props;
  useEffect(() => {
    onMount(() => setMounted(false));
  }, [onMount]);
  return mounted ? <OnboardingPage /> : null;
}
