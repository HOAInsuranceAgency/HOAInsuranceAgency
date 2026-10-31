import type { DynamoDBRecord } from "aws-lambda";

const DESTINATION_APP = "d1nuh9rw1hcuxo";
const TABLE_ARN = /^arn:aws:dynamodb:us-east-1:917680434255:table\/[^/]+$/;
const WORKERS = new Set(["activityLog", "communicationWorker", "honeycombWorker", "honeycombSubmissionWorker"]);

/** True means an entire owned probe batch was handled before business code.
 * Unexpected records throw as a whole batch: never acknowledge copied work.
 * The infrastructure must retain failed batches and all other writers must stay
 * fenced throughout the short probe window. This function performs no AWS calls.
 */
export function holdMigrationStream(event: unknown, worker: string): boolean {
  const app = process.env.HOA_MIGRATION_APP_ID;
  const enabled = process.env.HOA_MIGRATION_WORKERS_ENABLED;
  const probing = process.env.HOA_MIGRATION_STREAM_PROBE_ENABLED;
  const reject = (message: string): never => {
    console.error("HOA_MIGRATION_STREAM_HOLD_REJECTED", JSON.stringify({ worker, functionName: process.env.AWS_LAMBDA_FUNCTION_NAME }));
    throw new Error(message);
  };
  if (app !== DESTINATION_APP) {
    if (enabled !== undefined || probing !== undefined) throw new Error("Migration execution controls have a foreign backend binding");
    return false;
  }
  if (![undefined, "true", "false"].includes(enabled) || ![undefined, "true", "false"].includes(probing)) {
    throw new Error("Invalid migration execution controls");
  }
  if (enabled === "true") {
    if (probing === "true" || process.env.HOA_MIGRATION_PREVIEW === "true") throw new Error("Unsafe overlapping migration execution modes");
    return false;
  }
  if (probing !== "true" || process.env.HOA_MIGRATION_PREVIEW !== "false" || !WORKERS.has(worker)) {
    throw new Error("Migration business execution is held");
  }
  const token = process.env.HOA_MIGRATION_STREAM_PROBE_TOKEN ?? "";
  const expires = Date.parse(process.env.HOA_MIGRATION_STREAM_PROBE_EXPIRES_AT ?? "");
  if (!/^[a-f0-9]{64}$/.test(token) || !Number.isFinite(expires) || Date.now() >= expires || expires - Date.now() > 4 * 3600_000) {
    throw new Error("Migration stream probe window is invalid or expired");
  }
  let scopes: string[][];
  try { scopes = JSON.parse(process.env.HOA_MIGRATION_STREAM_PROBE_SCOPES ?? ""); }
  catch { throw new Error("Migration stream probe scope is missing"); }
  if (!Array.isArray(scopes) || !scopes.length || scopes.some(scope => !Array.isArray(scope) || scope.length !== 3
    || scope.some(value => typeof value !== "string") || !/^[A-Za-z0-9_.-]{3,255}$/.test(scope[0])
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/.test(scope[1]) || !["id", "accountId"].includes(scope[2]))
    || new Set(scopes.map(scope => scope[0])).size !== scopes.length) {
    throw new Error("Migration stream probe scope is invalid");
  }
  const tables = Object.fromEntries(scopes.map(([name, , key]) => [`arn:aws:dynamodb:us-east-1:917680434255:table/${name}`, key]));
  const streams = scopes.map(([name, stamp]) => `arn:aws:dynamodb:us-east-1:917680434255:table/${name}/stream/${stamp}`);
  if (!event || typeof event !== "object" || !Array.isArray((event as { Records?: unknown }).Records)) {
    throw new Error("Scheduled or direct business work is held during stream probing");
  }
  const records = (event as { Records: DynamoDBRecord[] }).Records;
  const marker = `hoa-migration-probe:${token}`;
  const sameScalar = (value: unknown, expected: string) => !!value && typeof value === "object"
    && Object.keys(value).length === 1 && (value as { S?: string }).S === expected;
  const isImage = (image: unknown, key: string) => !!image && typeof image === "object" && !Array.isArray(image)
    && Object.keys(image).length === 2
    && sameScalar((image as Record<string, unknown>)[key], marker)
    && sameScalar((image as Record<string, unknown>)._hoaMigrationStreamProbe, token);
  // Validate every record before emitting any success proof for a mixed batch.
  for (const record of records) {
    const arn = record?.eventSourceARN ?? "", streamOffset = arn.indexOf("/stream/");
    const table = streamOffset > 0 ? arn.slice(0, streamOffset) : "", key = tables[table];
    const keys = record?.dynamodb?.Keys;
    const common = record?.eventSource === "aws:dynamodb" && !!key && TABLE_ARN.test(table) && streams.includes(arn)
      && /^\d{4}-\d{2}-\d{2}T/.test(arn.slice(streamOffset + 8))
      && typeof record.eventID === "string" && !!record.eventID
      && /^\d+$/.test(record.dynamodb?.SequenceNumber ?? "")
      && Number.isFinite(record.dynamodb?.ApproximateCreationDateTime)
      && !!keys && Object.keys(keys).length === 1 && sameScalar(keys[key], marker);
    const image = record?.eventName === "INSERT"
      ? isImage(record.dynamodb?.NewImage, key) && record.dynamodb?.OldImage === undefined
      : record?.eventName === "REMOVE" && record.dynamodb?.NewImage === undefined
        && (record.dynamodb?.OldImage === undefined || isImage(record.dynamodb.OldImage, key));
    if (!common || !image) reject("Unexpected stream record while migration writers are held; batch retained for review");
  }
  for (const record of records) {
    console.info("HOA_MIGRATION_STREAM_PROBE", JSON.stringify({
      worker, functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION,
      token, streamArn: record.eventSourceARN, eventID: record.eventID,
      eventName: record.eventName, sequenceNumber: record.dynamodb!.SequenceNumber,
      recordCreatedAt: record.dynamodb!.ApproximateCreationDateTime,
    }));
  }
  return true;
}
