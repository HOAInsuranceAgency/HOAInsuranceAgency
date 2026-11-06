import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { queueLiveChange } from './live-change-context';
import targets from '../migration-targets.json';

/** Notifications contain no source data and never participate in business success.
 * Reconnect/focus and periodic authorized reads recover a missed notification. */
type Channel = 'Crm' | 'Owner' | 'Personal';
const credentials = defaultProvider();
export async function publishLiveChange(channel: Channel, userId?: string): Promise<void> {
  const target = targets.branches[process.env.HOA_MIGRATION_BRANCH as keyof typeof targets.branches];
  const endpoint = process.env.CRM_LIVE_ENDPOINT ?? target?.graphqlUrl;
  if (!endpoint || process.env.HOA_MIGRATION_PREVIEW === 'true' || process.env.HOA_MIGRATION_BUSINESS_HELD === 'true') return;
  if (channel === 'Personal' && (!userId || userId.length > 128)) return;
  if (queueLiveChange(channel, userId)) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const url = new URL(endpoint);
    const field = `publish${channel}Change`;
    const body = JSON.stringify({
      query: channel === 'Personal'
        ? `mutation NotifyPersonal($userId:String!){${field}(userId:$userId){revision userId}}`
        : `mutation Notify${channel}{${field}{revision}}`,
      ...(channel === 'Personal' ? { variables: { userId } } : {}),
    });
    const signer = new SignatureV4({ credentials, region: process.env.AWS_REGION ?? 'us-east-1', service: 'appsync', sha256: Sha256 });
    // Bound credentials/signing as well as HTTP. A notification must not hold
    // an already committed payment open while an SDK provider retries.
    const work = (async () => {
      const request = await signer.sign({ method: 'POST', protocol: url.protocol, hostname: url.hostname,
        path: url.pathname, headers: { host: url.host, 'content-type': 'application/json' }, body });
      if (controller.signal.aborted) return;
      const response = await fetch(url, { method: 'POST', headers: request.headers, body, signal: controller.signal });
      if (!response.ok) throw new Error('Notification unavailable');
      const result = await response.json() as { errors?: unknown[] };
      if (result.errors?.length) throw new Error('Notification rejected');
    })();
    await Promise.race([work, new Promise<void>(resolve => {
      if (controller.signal.aborted) resolve();
      else controller.signal.addEventListener('abort', () => resolve(), { once: true });
    })]);
  } catch {
    // No payload, credentials, endpoint, provider errors, or customer data in logs.
    console.warn('Live notification unavailable; automatic refresh will recover.');
  } finally { clearTimeout(timeout); }
}
export const publishCrmChange = () => publishLiveChange('Crm');
export const publishOwnerChange = () => publishLiveChange('Owner');
export const publishPersonalChange = (userId: string) => publishLiveChange('Personal', userId);
