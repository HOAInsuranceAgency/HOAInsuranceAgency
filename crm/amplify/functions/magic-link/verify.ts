import type { VerifyAuthChallengeResponseTriggerHandler } from "aws-lambda";
import { getSigningSecret, verifyToken } from "./token";
import { assertMigrationAuth, destinationAuth, REQUEST_LINK } from "./migration";
import { sendDestinationLink } from "./send";

/** The challenge answer is the token carried in the emailed link. */
export const handler: VerifyAuthChallengeResponseTriggerHandler = async (event, context) => {
  assertMigrationAuth(event, context);
  const { email, sub } = event.request.userAttributes;
  const answer = event.request.challengeAnswer;
  event.response.answerCorrect = false;
  if (!email || !sub || !answer) return event;
  if (destinationAuth() && answer === REQUEST_LINK) {
    await sendDestinationLink(email, sub, event.request.privateChallengeParameters);
    return event;
  }
  event.response.answerCorrect = verifyToken(answer, email, sub, await getSigningSecret());
  return event;
};
