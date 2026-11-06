import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import type { Schema } from '../data/resource';

export type LambdaDataClient = ReturnType<typeof generateClient<Schema>>;

/** Create one lazy, successful-client cache per consumer module.
 * Keep concurrent cold attempts independent, matching the existing getters;
 * a failed attempt is retried only on the caller's next invocation.
 */
export function createDataClientGetter() {
  let client: LambdaDataClient | undefined;
  return async function getDataClient(): Promise<LambdaDataClient> {
    if (!client) {
      const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(process.env as never);
      Amplify.configure(resourceConfig, libraryOptions);
      client = generateClient<Schema>();
    }
    return client;
  };
}
