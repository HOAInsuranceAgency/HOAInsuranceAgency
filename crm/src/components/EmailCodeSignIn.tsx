import { useState } from "react";
import { signIn, confirmSignIn } from "aws-amplify/auth";

/**
 * Passwordless sign-in: Cognito USER_AUTH flow with an emailed one-time
 * code (EMAIL_OTP). On successful confirmSignIn the Hub auth event flips
 * the Authenticator context to authenticated — no callback needed.
 */
export default function EmailCodeSignIn({ onBack }: { onBack: () => void }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function requestCode() {
    if (!email.trim()) return;
    setBusy(true);
    setError("");
    try {
      const { nextStep } = await signIn({
        username: email.trim().toLowerCase(),
        options: {
          authFlowType: "USER_AUTH",
          preferredChallenge: "EMAIL_OTP",
        },
      });
      if (nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_EMAIL_CODE") {
        setStep("code");
      } else {
        setError(
          "This account can't use code sign-in yet — use your password instead."
        );
      }
    } catch (err) {
      // Don't leak whether the account exists.
      console.warn(err);
      setError("Couldn't send a code. Check the email address or use your password.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    if (!code.trim()) return;
    setBusy(true);
    setError("");
    try {
      const { isSignedIn } = await confirmSignIn({
        challengeResponse: code.trim(),
      });
      if (!isSignedIn) setError("That code didn't work. Try again.");
    } catch (err) {
      console.warn(err);
      setError("Invalid or expired code. Request a new one and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-card card">
      <h2 style={{ textAlign: "center" }}>Sign in with a code</h2>
      {step === "email" ? (
        <>
          <p className="muted small">
            We'll email you a one-time sign-in code — no password needed.
          </p>
          <div className="field">
            <label>Email</label>
            <input
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && requestCode()}
            />
          </div>
          <div className="form-actions">
            <button className="primary" disabled={busy} onClick={requestCode}>
              {busy ? "Sending…" : "Email me a code"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted small">
            Enter the code we sent to <strong>{email.trim()}</strong>.
          </p>
          <div className="field">
            <label>Code</label>
            <input
              inputMode="numeric"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitCode()}
            />
          </div>
          <div className="form-actions">
            <button className="primary" disabled={busy} onClick={submitCode}>
              {busy ? "Verifying…" : "Sign in"}
            </button>
            <button className="link" disabled={busy} onClick={requestCode}>
              Resend code
            </button>
          </div>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
      <button className="link" style={{ marginTop: 10 }} onClick={onBack}>
        ← Sign in with a password instead
      </button>
    </div>
  );
}
