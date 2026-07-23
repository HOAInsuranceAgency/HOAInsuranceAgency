import type { DefineAuthChallengeTriggerHandler } from "aws-lambda";

/** Orchestrates the custom flow: one CUSTOM_CHALLENGE, max 3 attempts. */
export const handler: DefineAuthChallengeTriggerHandler = async (event) => {
  const session = event.request.session ?? [];
  const last = session[session.length - 1];

  if (last?.challengeName === "CUSTOM_CHALLENGE" && last.challengeResult === true) {
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
  } else if (session.length >= 3) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
  } else {
    event.response.issueTokens = false;
    event.response.failAuthentication = false;
    event.response.challengeName = "CUSTOM_CHALLENGE";
  }
  return event;
};
