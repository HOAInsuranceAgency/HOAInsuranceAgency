import { useEffect, useRef, useState } from "react";
import { signIn, confirmSignIn } from "aws-amplify/auth";
import { destinationSignIn, previewSignInAvailable } from "../lib/migrationAuth";

/**
 * Magic-link sign-in (the only sign-in path — no passwords).
 *
 * Request: start a CUSTOM_WITHOUT_SRP sign-in with mode="request"; the
 * createAuthChallenge Lambda emails a link and this session is abandoned.
 *
 * Consume: the link opens the app with #magic=<token>. We start a fresh
 * sign-in for the email embedded in the token (mode="consume" — no email
 * sent) and answer the challenge with the token itself.
 */
export default function MagicLinkSignIn({ embedded = false }: { embedded?: boolean }) {
  const [sidebarLink, setSidebarLink] = useState("");
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<"email" | "sent" | "completing">("email");
  const [error, setError] = useState("");
  const consumed = useRef(false);
  const requesting = useRef(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const match = window.location.hash.match(/magic=([^&]+)/);
    if (match && !consumed.current) {
      consumed.current = true; // StrictMode double-mount guard
      window.history.replaceState(null, "", window.location.pathname);
      try { void completeSignIn(decodeURIComponent(match[1])); }
      catch { setError('That sign-in link is malformed. Request a new one.'); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function emailFromToken(token: string): string | null {
    try {
      const payload = JSON.parse(
        atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"))
      ) as { email?: string };
      return payload.email ?? null;
    } catch {
      return null;
    }
  }

  async function completeSignIn(token: string) {
    setPhase("completing");
    setError("");
    if (!previewSignInAvailable()) {
      setError("Administrator sign-in is disabled in this migration preview.");
      setPhase("email");
      return;
    }
    const tokenEmail = emailFromToken(token);
    if (!tokenEmail) {
      setError("That sign-in link is malformed. Request a new one.");
      setPhase("email");
      return;
    }
    try {
      await signIn({
        username: tokenEmail,
        options: {
          authFlowType: "CUSTOM_WITHOUT_SRP",
          clientMetadata: { mode: "consume" },
        },
      });
      const { isSignedIn } = await confirmSignIn({ challengeResponse: token });
      if (!isSignedIn) throw new Error("not signed in");
      // Success. The Authenticator's state machine doesn't reliably pick up
      // a confirmSignIn done outside its own UI (Hub-timing race), which
      // left this screen stuck on "Signing you in…". Reload to the clean
      // URL: the restored session resolves straight to the app (the
      // configuring-splash prevents any sign-in flash). The hash is already
      // stripped, so this does not re-consume the token.
      window.location.replace(window.location.origin + window.location.pathname);
      return;
    } catch (err) {
      console.warn(err);
      setError("That sign-in link is invalid or has expired. Request a new one.");
      setPhase("email");
    }
  }

  async function requestLink() {
    const addr = email.trim().toLowerCase();
    if (!addr || requesting.current || !previewSignInAvailable()) return;
    requesting.current = true;
    setSending(true);
    setError("");
    try {
      const result = await signIn({
        username: addr,
        options: {
          authFlowType: "CUSTOM_WITHOUT_SRP",
          clientMetadata: { mode: "request" },
        },
      });
      if (destinationSignIn() && result.nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE") {
        // InitiateAuth metadata is not forwarded to Cognito's create trigger.
        // Only this explicit answer may send a destination sign-in email.
        await confirmSignIn({ challengeResponse: "REQUEST_LINK" });
      }
    } catch (err) {
      // Same response either way — don't reveal whether the account exists.
      console.warn(err);
    } finally {
      requesting.current = false;
      setSending(false);
    }
    setPhase("sent");
  }

  return (
    <>
      <img className="auth-logo" src="/logo.png" alt="HOA Insurance Agency" />
      <div className="auth-card card">
        <h2 style={{ textAlign: "center" }}>Sign in</h2>

        {!previewSignInAvailable() ? (
          <p className="muted small">Administrator sign-in and email are disabled in this migration preview.</p>
        ) : phase === "completing" ? (
          <p className="muted" style={{ textAlign: "center" }}>
            Signing you in…
          </p>
        ) : phase === "sent" ? (
          <>
            <p className="muted small">
              Check <strong>{email.trim()}</strong> for a sign-in link. If it
              doesn't arrive, try again later or contact an administrator.
              Open the email on this device; links are valid for 15 minutes.
            </p>
            {embedded && <form onSubmit={e => {
              e.preventDefault();
              try {
                const url = new URL(sidebarLink);
                const token = url.hash.match(/(?:^#|&)magic=([^&]+)/)?.[1];
                if (url.origin !== window.location.origin || !token) throw new Error("Invalid link");
                setSidebarLink(""); void completeSignIn(decodeURIComponent(token));
              } catch { setError("Paste the sign-in link from your CRM email."); }
            }}>
              <p className="muted small">For the Front sidebar, copy the sign-in link from your email without opening it, then paste it here. This signs in this panel directly.</p>
              <label className="field">Private sign-in link<input type="password" autoComplete="off" required value={sidebarLink} onChange={e => setSidebarLink(e.target.value)} /></label>
              <button disabled={!sidebarLink}>Sign in to this sidebar</button>
            </form>}
            <button className="link" onClick={() => setPhase("email")}>
              ← Use a different email
            </button>
          </>
        ) : (
          <>
            <p className="muted small" style={{ textAlign: "center" }}>
              Enter your work email and we'll send you a sign-in link.
              No password needed.
            </p>
            <div className="field">
              <label>Email</label>
              <input
                type="email"
                autoFocus
                value={email}
                disabled={sending}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && requestLink()}
              />
            </div>
            <div className="form-actions">
              <button className="primary" disabled={sending || !email.trim()} onClick={requestLink}>
                {sending ? 'Sending…' : 'Email me a sign-in link'}
              </button>
            </div>
          </>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
      <div className="auth-tag">Agency CRM · ProtectMyHOA</div>
    </>
  );
}
