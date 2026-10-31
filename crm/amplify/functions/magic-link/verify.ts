import type { VerifyAuthChallengeResponseTriggerHandler } from "aws-lambda";
import { getSigningSecret, verifyToken } from "./token";
import { assertMigrationAuth, destinationAuth, REQUEST_LINK } from "./migration";
import { sendDestinationLink } from "./send";

/** The challenge answer is the token carried in the emailed link. */
export const handler: VerifyAuthChallengeResponseTriggerHandler = async (event, context) => {
  assertMigrationAuth(event, context);
  const email = event.request.userAttributes.email;
  const answer = event.request.challengeAnswer;
  if (destinationAuth() && answer === REQUEST_LINK) {
    await sendDestinationLink(email);
    event.response.answerCorrect = false;
    return event;
  }
  event.response.answerCorrect =
    !!email && !!answer && verifyToken(answer, email, await getSigningSecret());
  return event;
};
