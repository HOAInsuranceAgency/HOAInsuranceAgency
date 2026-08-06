/**
 * The Claude model every handler in this backend calls.
 *
 * One constant, imported by both `extract-lead` and `form-filler`, because
 * two independent pins drift: the day one is upgraded and the other is not,
 * a lead extracted by one model is completed on a carrier form by another,
 * and nothing in the app says so. Upgrading is a one-line change here that
 * moves both together.
 *
 * Nothing else lives in this file on purpose — a handler importing it must
 * not pull in anything else.
 */
export const CLAUDE_MODEL = "claude-opus-5";

/**
 * The model for work that is judged by the eye, not relied on.
 *
 * `CLAUDE_MODEL` reads condo docs and fills carrier forms; being wrong there
 * costs the agency something real, so it is the strongest model available.
 * Naming an uploaded PDF is the opposite: it runs on every upload, the
 * producer reads the result in a table the moment it lands, and a bad name is
 * fixed by typing over it. That is a different trade, so it gets a different
 * pin rather than quietly riding along on the expensive one.
 *
 * This is a second pin, and the file's whole argument is that pins drift —
 * the difference is that these two are *meant* to differ. Upgrading one does
 * not oblige you to upgrade the other.
 */
export const CLAUDE_CHEAP_MODEL = "claude-haiku-4-5";
