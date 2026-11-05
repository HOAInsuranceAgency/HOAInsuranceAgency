import { decodeAwsJson, isRecord, type ApiRecord } from '../../../shared/apiResponse';

/** Lambda-only input decoding. Policy metadata is also loaded at synth time
 * and must not acquire runtime shared-module dependencies. Invalid non-record
 * inputs retain the existing empty-object behavior; malformed JSON throws. */
export function object(value: unknown): ApiRecord {
  const parsed = decodeAwsJson(value);
  return isRecord(parsed) ? parsed : {};
}
