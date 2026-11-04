import type { PreSignUpTriggerEvent } from "aws-lambda";
import {
  AdminGetUserCommand,
  AdminLinkProviderForUserCommand,
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

const cognito = new CognitoIdentityProviderClient({ maxAttempts: 2 });
const CRM_ROLES = new Set(["OWNER", "ADMIN", "STAFF", "PRODUCER"]);
const DENIED = "Use your invited work email to request an email sign-in link, or contact your administrator.";

/**
 * Google may only add a sign-in method to an existing invited account. The
 * destination retains its Cognito sub, role groups, assignments and profile.
 * No user, password or membership is created here.
 */
export async function handler(event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> {
  // Team invitations use AdminCreateUser; ordinary SignUp is never allowed.
  if (event.triggerSource === "PreSignUp_AdminCreateUser") return event;
  if (event.triggerSource !== "PreSignUp_ExternalProvider") throw new Error(DENIED);

  // Case-insensitive pools lowercase the provider prefix too. Keep the whole
  // subject after the first separator, rather than splitting an opaque ID.
  const subject = /^google_(.+)$/i.exec(event.userName)?.[1];
  const attributes = event.request.userAttributes;
  const email = attributes.email?.trim().toLowerCase();
  const domain = email?.split("@")[1];
  const hostedDomain = attributes["custom:googleHostedDomain"]?.toLowerCase();

  // For third-party Google accounts, email_verified can remain true after
  // mailbox ownership changes. Google is authoritative only for Gmail or a
  // Workspace domain identified by its provider-mapped hd claim. Trust only
  // this fresh external signup event, never a browser-writable saved attribute.
  if (!subject || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      attributes.email_verified !== "true" ||
      (domain !== "gmail.com" && (!hostedDomain || hostedDomain !== domain))) {
    throw new Error(DENIED);
  }

  // Email is an existing sign-in alias. AdminGetUser is consistent, unlike an
  // eventually consistent ListUsers lookup that could miss a fresh invite.
  const member = await cognito.send(new AdminGetUserCommand({
    UserPoolId: event.userPoolId,
    Username: email,
  }));
  const memberEmail = member.UserAttributes?.find(attribute => attribute.Name === "email")?.Value?.toLowerCase();
  const memberVerified = member.UserAttributes?.find(attribute => attribute.Name === "email_verified")?.Value;
  const sub = member.UserAttributes?.find(attribute => attribute.Name === "sub")?.Value;
  if (!member.Username || !sub || member.Enabled !== true ||
      !["CONFIRMED", "FORCE_CHANGE_PASSWORD"].includes(member.UserStatus ?? "") ||
      memberEmail !== email || memberVerified !== "true") {
    throw new Error(DENIED);
  }

  // A partially failed invitation must not acquire access through Google.
  let hasRole = false;
  let nextToken: string | undefined;
  do {
    const page = await cognito.send(new AdminListGroupsForUserCommand({
      UserPoolId: event.userPoolId,
      Username: member.Username,
      NextToken: nextToken,
    }));
    hasRole ||= (page.Groups ?? []).some(group => CRM_ROLES.has(group.GroupName ?? ""));
    nextToken = page.NextToken;
  } while (!hasRole && nextToken);
  if (!hasRole) throw new Error(DENIED);

  await cognito.send(new AdminLinkProviderForUserCommand({
    UserPoolId: event.userPoolId,
    DestinationUser: { ProviderName: "Cognito", ProviderAttributeValue: member.Username },
    SourceUser: {
      ProviderName: "Google",
      ProviderAttributeName: "Cognito_Subject",
      ProviderAttributeValue: subject,
    },
  }));
  // Do not autoVerifyEmail: with email aliases it can move the alias away from
  // the original account. Linking is the only identity mutation we perform.
  return event;
}
