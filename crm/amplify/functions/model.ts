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
