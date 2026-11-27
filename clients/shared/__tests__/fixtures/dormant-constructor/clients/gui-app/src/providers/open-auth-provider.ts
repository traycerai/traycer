import { createLocalOpenAuth } from "../../../shared/host-transport/create-local-open-auth";

// A production caller outside every scan root: a provider of the gui-app.
export const providerAuth = createLocalOpenAuth({
  authnBaseUrl: "https://authn.example.test",
});
