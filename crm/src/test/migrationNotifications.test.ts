import { describe, expect, it } from "vitest";
import { App, CfnResource, Stack } from "aws-cdk-lib";
import { disableBucketNotifications, hasNoBucketNotifications } from "../../amplify/migration-notifications";

describe("migration bucket notification provider contract", () => {
  it("replaces existing destinations while retaining the provider's required object", () => {
    const app = new App();
    const stack = new Stack(app, "NotificationContract");
    const resource = new CfnResource(stack, "Notifications", {
      type: "Custom::S3BucketNotifications",
      properties: {
        ServiceToken: "provider", BucketName: "documents", Managed: true,
        NotificationConfiguration: {
          LambdaFunctionConfigurations: [{ Events: ["s3:ObjectCreated:*"], LambdaFunctionArn: "worker" }],
          QueueConfigurations: [{ Events: ["s3:ObjectCreated:*"], QueueArn: "queue" }],
          TopicConfigurations: [{ Events: ["s3:ObjectCreated:*"], TopicArn: "topic" }],
          EventBridgeConfiguration: {},
        },
      },
    });
    disableBucketNotifications(resource);
    const props = app.synth().getStackArtifact(stack.artifactId).template.Resources.Notifications.Properties;
    expect(props).toEqual({
      ServiceToken: "provider", BucketName: "documents", Managed: true,
      NotificationConfiguration: { LambdaFunctionConfigurations: [], QueueConfigurations: [], TopicConfigurations: [] },
    });
    expect(hasNoBucketNotifications(props.NotificationConfiguration)).toBe(true);
  });

  it.each([undefined, null, [], { EventBridgeConfiguration: {} }, { LambdaFunctionConfigurations: [{}] }, { UnknownConfiguration: [] }])(
    "rejects a missing, malformed, or enabled configuration: %j", value => expect(hasNoBucketNotifications(value)).toBe(false),
  );
  it("accepts the provider's genuinely empty configuration", () => expect(hasNoBucketNotifications({})).toBe(true));
});
