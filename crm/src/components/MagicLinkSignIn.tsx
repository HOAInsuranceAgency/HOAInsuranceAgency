import { Field } from "./ui/kit";
import { useEffect, useRef, useState } from "react";
import { signIn, confirmSignIn } from "aws-amplify/auth";

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
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => { if (!cooldown) return; const timer = window.setTimeout(() => setCooldown(c => c - 1), 1000); return () => window.clearTimeout(timer); }, [cooldown]);

  useEffect(() => {
    const match = window.location.hash.match(/magic=([^&]+)/);
    if (match && !consumed.current) {
      consumed.current = true; // StrictMode double-mount guard
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      completeSignIn(decodeURIComponent(match[1]));
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
      window.location.replace(window.location.origin + window.location.pathname + window.location.search);
      return;
    } catch (err) {
      console.warn(err);
      setError("That sign-in link is invalid or has expired. Request a new one.");
      setPhase("email");
    }
  }

  async function requestLink() {
    const addr = email.trim().toLowerCase();
    if (!addr || requesting.current || cooldown > 0) return;
    requesting.current = true; setSending(true);
    setError("");
    try {
      await signIn({
        username: addr,
        options: {
          authFlowType: "CUSTOM_WITHOUT_SRP",
          clientMetadata: { mode: "request" },
        },
      });
    } catch (err) {
      // Same response either way — don't reveal whether the account exists.
      console.warn(err);
    }
    requesting.current = false; setSending(false); setCooldown(30);
    setPhase("sent");
  }

  return (
    <>
      <img className="auth-logo" src="/logo.png" alt="HOA Insurance Agency" />
      <div className="auth-card card">
        <h2 style={{ textAlign: "center" }}>Sign in</h2>

        {phase === "completing" ? (
          <p className="muted" style={{ textAlign: "center" }}>
            Signing you in…
          </p>
        ) : phase === "sent" ? (
          <>
            <p className="muted small">
              If <strong>{email.trim()}</strong> has an account, a sign-in link
              is on its way. Open the email on this device and click the link —
              it's valid for 15 minutes.
            </p>
            <p className="muted small">If it hasn’t arrived, check spam or ask your agency administrator to confirm your invitation.</p>
            <button className="secondary" disabled={sending || cooldown > 0} onClick={requestLink}>{sending ? "Sending…" : cooldown ? `Resend in ${cooldown}s` : "Resend sign-in link"}</button>
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
            <button className="link" onClick={() => { setCooldown(0); setPhase("email"); }}>
              ← Use a different email
            </button>
          </>
        ) : (
          <>
            <p className="muted small" style={{ textAlign: "center" }}>
              Enter your work email and we'll send you a sign-in link.
              No password needed.
            </p>
            <Field className="field">
              <label>Email</label>
              <input
                type="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && requestLink()}
              />
            </Field>
            <div className="form-actions">
              <button className="primary" disabled={sending || !email.trim()} onClick={requestLink}>
                {sending ? "Sending…" : "Email me a sign-in link"}
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
