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
export default function MagicLinkSignIn() {
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<"email" | "sent" | "completing">("email");
  const [error, setError] = useState("");
  const consumed = useRef(false);

  useEffect(() => {
    const match = window.location.hash.match(/magic=([^&]+)/);
    if (match && !consumed.current) {
      consumed.current = true; // StrictMode double-mount guard
      window.history.replaceState(null, "", window.location.pathname);
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
      // Success: the Hub auth event flips authStatus and unmounts this screen.
    } catch (err) {
      console.warn(err);
      setError("That sign-in link is invalid or has expired. Request a new one.");
      setPhase("email");
    }
  }

  async function requestLink() {
    const addr = email.trim().toLowerCase();
    if (!addr) return;
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
    setPhase("sent");
  }

  return (
    <div className="auth-card card">
      <h2 style={{ textAlign: "center" }}>HOA CRM</h2>

      {phase === "completing" ? (
        <p className="muted" style={{ textAlign: "center" }}>
          Signing you in…
        </p>
      ) : phase === "sent" ? (
        <>
          <p className="muted small">
            If <strong>{email.trim()}</strong> has an account, a sign-in link is
            on its way. Open the email on this device and click the link —
            it's valid for 15 minutes.
          </p>
          <button className="link" onClick={() => setPhase("email")}>
            ← Use a different email
          </button>
        </>
      ) : (
        <>
          <p className="muted small">
            Enter your work email and we'll send you a sign-in link. No
            password needed.
          </p>
          <div className="field">
            <label>Email</label>
            <input
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && requestLink()}
            />
          </div>
          <div className="form-actions">
            <button className="primary" disabled={!email.trim()} onClick={requestLink}>
              Email me a sign-in link
            </button>
          </div>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
