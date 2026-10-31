import type { CfnResource } from "aws-cdk-lib";

const DESTINATIONS = ["LambdaFunctionConfigurations", "QueueConfigurations", "TopicConfigurations"];

/** Keep the provider's required object while replacing every delivery list. */
export function disableBucketNotifications(resource: CfnResource) {
  // CDK deep-merges object overrides. An empty object does not replace the old
  // destinations, while deleting every child drops NotificationConfiguration
  // entirely. The installed provider requires that property even on Delete.
  for (const key of DESTINATIONS) resource.addPropertyOverride(`NotificationConfiguration.${key}`, []);
  resource.addPropertyDeletionOverride("NotificationConfiguration.EventBridgeConfiguration");
}

export function hasNoBucketNotifications(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value).every(([key, entries]) => DESTINATIONS.includes(key) && Array.isArray(entries) && entries.length === 0);
}
