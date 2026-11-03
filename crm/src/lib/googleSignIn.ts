import { Amplify } from "aws-amplify";
import { Hub } from "aws-amplify/utils";

export const GOOGLE_SIGN_IN_ERROR =
  "Google sign-in could not be completed. Use your invited work account, try again, or request an email link.";

let error = "";
const listeners = new Set<() => void>();

function setError(value: string) {
  error = value;
  listeners.forEach(listener => listener());
}

export function isGoogleSignInConfigured(): boolean {
  return Amplify.getConfig().Auth?.Cognito?.loginWith?.oauth?.providers?.includes("Google") ?? false;
}

export const getGoogleSignInError = () => error;
export const clearGoogleSignInError = () => setError("");
export function subscribeGoogleSignInError(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Register before Amplify.configure: a redirect can fail before React mounts. */
export function listenForGoogleSignInFailures() {
  return Hub.listen("auth", ({ payload }) => {
    if (payload.event !== "signInWithRedirect_failure") return;
    // Amplify has finished processing this callback. Remove credentials and
    // provider details from the address bar without exposing its error text.
    const url = new URL(window.location.href);
    for (const key of ["code", "state", "error", "error_description"]) {
      url.searchParams.delete(key);
    }
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    setError(GOOGLE_SIGN_IN_ERROR);
  });
}
