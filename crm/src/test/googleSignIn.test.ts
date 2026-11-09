import type { PreSignUpTriggerEvent } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminGetUserCommand,
  AdminLinkProviderForUserCommand,
  AdminListGroupsForUserCommand,
  type AdminGetUserCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";

const send = vi.hoisted(() => vi.fn());
const withTeamIdentityLock = vi.hoisted(() => vi.fn());
const markWrite = vi.fn();
vi.mock("@aws-sdk/client-cognito-identity-provider", async importOriginal => ({
  ...await importOriginal<object>(),
  CognitoIdentityProviderClient: class { send = send; },
}));
vi.mock("../../amplify/functions/crm-access/team-identity-lock", () => ({ withTeamIdentityLock }));
import { handler } from "../../amplify/functions/google-sign-in/handler";

function event(attributes: Record<string, string> = {}, userName = "Google_subject_123"): PreSignUpTriggerEvent {
  return {
    version: "1", region: "us-east-1", userPoolId: "us-east-1_pool", userName,
    callerContext: { awsSdkVersion: "test", clientId: "client" },
    triggerSource: "PreSignUp_ExternalProvider",
    request: { userAttributes: {
      email: "person@example.com", email_verified: "true",
      "custom:googleHostedDomain": "example.com", ...attributes,
    } },
    response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
  };
}

let member: AdminGetUserCommandOutput;
const links = () => send.mock.calls.map(([command]) => command).filter(command => command instanceof AdminLinkProviderForUserCommand);

beforeEach(() => {
  send.mockReset();
  markWrite.mockReset();
  withTeamIdentityLock.mockReset().mockImplementation(async (_userId, work) => work(markWrite));
  member = {
    $metadata: {}, Username: "original-cognito-username", Enabled: true, UserStatus: "CONFIRMED",
    UserAttributes: [
      { Name: "sub", Value: "original-sub" },
      { Name: "email", Value: "person@example.com" },
      { Name: "email_verified", Value: "true" },
    ],
  };
  send.mockImplementation(async command => {
    if (command instanceof AdminGetUserCommand) return member;
    if (command instanceof AdminListGroupsForUserCommand) return { Groups: [{ GroupName: "PRODUCER" }] };
    return {};
  });
});

describe("invite-only Google account linking", () => {
  it("links the Google subject to the canonical invited identity without changing roles, sub or verification flags", async () => {
    const request = event();
    expect(await handler(request)).toBe(request);
    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "AdminGetUserCommand", "AdminGetUserCommand", "AdminListGroupsForUserCommand", "AdminLinkProviderForUserCommand",
    ]);
    expect(withTeamIdentityLock).toHaveBeenCalledExactlyOnceWith("original-sub", expect.any(Function), "us-east-1_pool");
    expect(send.mock.calls[0][0].input).toEqual({ UserPoolId: "us-east-1_pool", Username: "person@example.com" });
    expect(send.mock.calls[1][0].input).toEqual({ UserPoolId: "us-east-1_pool", Username: "original-cognito-username" });
    expect(links()[0].input).toEqual({
      UserPoolId: "us-east-1_pool",
      DestinationUser: { ProviderName: "Cognito", ProviderAttributeValue: "original-cognito-username" },
      SourceUser: { ProviderName: "Google", ProviderAttributeName: "Cognito_Subject", ProviderAttributeValue: "subject_123" },
    });
    expect(markWrite).toHaveBeenCalledExactlyOnceWith();
    expect(markWrite.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[3]);
    expect(request.response).toEqual({ autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false });
  });

  it("rechecks the current email after acquiring the lock and rejects a stale Google claim", async () => {
    withTeamIdentityLock.mockImplementation(async (_userId, work) => {
      // The alias lookup saw the previous address before the email edit.
      member = { ...member, UserAttributes: member.UserAttributes?.map(attribute =>
        attribute.Name === "email" ? { ...attribute, Value: "new@example.com" } : attribute) };
      return work(markWrite);
    });
    await expect(handler(event())).rejects.toThrow(/email sign-in link/);
    expect(send.mock.calls.map(([command]) => command.input.Username)).toEqual([
      "person@example.com", "original-cognito-username",
    ]);
    expect(links()).toHaveLength(0);
    expect(markWrite).not.toHaveBeenCalled();
  });

  it("denies linking when an email edit already holds the member's lock", async () => {
    withTeamIdentityLock.mockRejectedValue(new Error("Identity update in progress"));
    await expect(handler(event())).rejects.toThrow("Identity update in progress");
    expect(send).toHaveBeenCalledTimes(1);
    expect(links()).toHaveLength(0);
  });

  it("accepts lowercased Cognito provider prefixes and normalized Workspace email", async () => {
    await handler(event({ email: " Person@Example.COM ", "custom:googleHostedDomain": "EXAMPLE.com" }, "google_opaque_subject"));
    expect(links()[0].input.SourceUser).toMatchObject({ ProviderAttributeValue: "opaque_subject" });
  });

  it("accepts a verified Gmail account without a Workspace claim", async () => {
    member.UserAttributes![1].Value = "person@gmail.com";
    const request = event({ email: "person@gmail.com" });
    delete request.request.userAttributes["custom:googleHostedDomain"];
    await handler(request);
    expect(links()).toHaveLength(1);
  });

  it("accepts native admin-created invitations that still have FORCE_CHANGE_PASSWORD status", async () => {
    member.UserStatus = "FORCE_CHANGE_PASSWORD";
    await handler(event());
    expect(links()).toHaveLength(1);
  });

  it("allows admin invitations without looking up or linking their identity", async () => {
    const request = { ...event(), triggerSource: "PreSignUp_AdminCreateUser" as const };
    expect(await handler(request)).toBe(request);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects ordinary self-signup even if email and hd look verified", async () => {
    await expect(handler({ ...event(), triggerSource: "PreSignUp_SignUp" })).rejects.toThrow(/email sign-in link/);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["Facebook_subject", "Google_", "subject", "google"])("rejects unexpected provider identity %s", async username => {
    await expect(handler(event({}, username))).rejects.toThrow(/email sign-in link/);
    expect(send).not.toHaveBeenCalled();
  });

  const invalidClaims: Record<string, string>[] = [
    { email_verified: "false" },
    { email_verified: "" },
    { email: "malformed" },
    { email: "person@@example.com" },
    { email: "" },
    { "custom:googleHostedDomain": "different.com" },
    { "custom:googleHostedDomain": "" },
  ];
  it.each(invalidClaims)("rejects untrusted Google claims before reading any invited identity: %j", async attributes => {
    await expect(handler(event(attributes))).rejects.toThrow(/email sign-in link/);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not trust a saved hosted-domain value for a third-party Google email", async () => {
    member.UserAttributes!.push({ Name: "custom:googleHostedDomain", Value: "example.com" });
    const request = event();
    delete request.request.userAttributes["custom:googleHostedDomain"];
    await expect(handler(request)).rejects.toThrow(/email sign-in link/);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an uninvited email without creating an account", async () => {
    send.mockRejectedValue(new Error("User does not exist"));
    await expect(handler(event())).rejects.toThrow("User does not exist");
    expect(send).toHaveBeenCalledTimes(1);
    expect(links()).toHaveLength(0);
  });

  it.each([false, undefined])("rejects disabled or unconfirmed enabled state (%s)", async enabled => {
    member.Enabled = enabled;
    await expect(handler(event())).rejects.toThrow(/email sign-in link/);
    expect(send).toHaveBeenCalledTimes(2);
    expect(links()).toHaveLength(0);
  });

  it.each(["EXTERNAL_PROVIDER", "UNCONFIRMED", "RESET_REQUIRED", undefined] as const)("rejects non-invited account status %s", async status => {
    member.UserStatus = status;
    await expect(handler(event())).rejects.toThrow(/email sign-in link/);
    expect(links()).toHaveLength(0);
  });

  it.each(["email", "email_verified", "sub"])("rejects a local identity missing %s", async attribute => {
    member.UserAttributes = member.UserAttributes!.filter(item => item.Name !== attribute);
    await expect(handler(event())).rejects.toThrow(/email sign-in link/);
    expect(links()).toHaveLength(0);
  });

  it("rejects a mismatched local email rather than moving an alias", async () => {
    member.UserAttributes![1].Value = "someone-else@example.com";
    await expect(handler(event())).rejects.toThrow(/email sign-in link/);
    expect(links()).toHaveLength(0);
  });

  it("rejects a local email that is not verified", async () => {
    member.UserAttributes![2].Value = "false";
    await expect(handler(event())).rejects.toThrow(/email sign-in link/);
    expect(links()).toHaveLength(0);
  });

  it("follows group pagination before recognizing an invited teammate", async () => {
    send.mockImplementation(async command => {
      if (command instanceof AdminGetUserCommand) return member;
      if (command instanceof AdminListGroupsForUserCommand) {
        return command.input.NextToken
          ? { Groups: [{ GroupName: "OWNER" }] }
          : { Groups: [{ GroupName: "UNRELATED" }], NextToken: "next-page" };
      }
      return {};
    });
    await handler(event());
    const reads = send.mock.calls.map(([command]) => command).filter(command => command instanceof AdminListGroupsForUserCommand);
    expect(reads.map(command => command.input.NextToken)).toEqual([undefined, "next-page"]);
    expect(links()).toHaveLength(1);
  });

  it("denies a partially invited account without any CRM role", async () => {
    send.mockImplementation(async command => command instanceof AdminGetUserCommand ? member : { Groups: [{ GroupName: "UNRELATED" }] });
    await expect(handler(event())).rejects.toThrow(/email sign-in link/);
    expect(links()).toHaveLength(0);
  });

  it("fails closed when checking group membership fails", async () => {
    send.mockImplementation(async command => {
      if (command instanceof AdminGetUserCommand) return member;
      throw new Error("Cognito unavailable");
    });
    await expect(handler(event())).rejects.toThrow("Cognito unavailable");
    expect(links()).toHaveLength(0);
  });

  it("does not confirm or provision a fallback profile when linking fails", async () => {
    const request = event();
    send.mockImplementation(async command => {
      if (command instanceof AdminGetUserCommand) return member;
      if (command instanceof AdminListGroupsForUserCommand) return { Groups: [{ GroupName: "STAFF" }] };
      throw new Error("Link failed");
    });
    await expect(handler(request)).rejects.toThrow("Link failed");
    expect(request.response.autoConfirmUser).toBe(false);
    expect(send).toHaveBeenCalledTimes(4);
  });
});
