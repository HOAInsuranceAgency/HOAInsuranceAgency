import type { VerifyAuthChallengeResponseTriggerHandler } from "aws-lambda";
import { getSigningSecret, verifyToken } from "./token";

/** The challenge answer is the token carried in the emailed link. */
export const handler: VerifyAuthChallengeResponseTriggerHandler = async (event) => {
  const email = event.request.userAttributes.email;
  const answer = event.request.challengeAnswer;
  event.response.answerCorrect =
    !!email && !!answer && verifyToken(answer, email, await getSigningSecret());
  return event;
};
