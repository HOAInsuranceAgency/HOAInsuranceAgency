import { captureHandledFailure } from "../monitoring";
import { brokerFeeDisclosure, signBrokerFeeDisclosure } from './agreements';
import { accountFees, getFee } from './store';
import { AccountAccess } from '../crm-access/access';
import { assertUserSession } from '../crm-access/user-status';
import { id, object, type Identity } from '../crm-access/policy';
import { assertPreviewRead } from '../migration-readonly';
interface Event { source?: string; fieldName?: string; info?: { fieldName?: string }; arguments?: Record<string, unknown>; identity?: Identity; request?: { headers?: Record<string, unknown> }; }
export const handler = async (event: Event) => {
  const field = event.fieldName ?? event.info?.fieldName;
  assertPreviewRead(field === 'brokerFeeDisclosure' || field === 'brokerFeeAction' && object(event.arguments?.input).op === 'status');
  if (event.source === 'aws.events') return { ok: true, ...await (await import('./payments')).reconcilePendingPayments() };
  try {
    const args = event.arguments ?? {};
    if (field === 'brokerFeeDisclosure') return await brokerFeeDisclosure(String(args.token ?? ''));
    if (field === 'signBrokerFeeDisclosure') {
      const forwarded = Object.entries(event.request?.headers ?? {}).find(([name]) => name.toLowerCase() === 'x-forwarded-for')?.[1];
      const source = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : undefined;
      const ip = source && /^[0-9a-f:.]{3,80}$/i.test(source) ? source : undefined;
      return await signBrokerFeeDisclosure(String(args.token ?? ''), { signerName: args.signerName, signerEmail: args.signerEmail, signerRole: args.signerRole, consent: args.consent }, ip);
    }
    await assertUserSession(event.identity);
    const access = new AccountAccess(event.identity, undefined, event.request), input = object(args.input);
    if (field !== 'brokerFeeAction') throw new Error('Unknown broker fee operation.');
    if (input.op === 'confirmInvoicePayment') return await (await import('./manualPayment')).confirmInvoicePayment(event, input);
    if (input.op === 'saveJurisdiction') return await (await import('./settings')).saveJurisdiction(event, input);
    if (input.op !== 'status') throw new Error('Unknown broker fee operation.');
    const accountId = id(input.accountId); await access.requireRecord('Account', accountId);
    let fees;
    if (input.quoteIds !== undefined) {
      if (!Array.isArray(input.quoteIds) || input.quoteIds.length > 100 || input.quoteIds.some(value => !id(value))) throw new Error('Choose valid quote records.');
      fees = (await Promise.all([...new Set(input.quoteIds.map(id))].map(getFee))).filter(fee => fee && fee.accountId === accountId);
    } else fees = await accountFees(accountId);
    return { ok: true, fees };
  } catch (error) {
    // Generic Error/Unauthorized are expected validation/access responses.
    // Report named service/runtime failures, excluding normal write conflicts.
    if (error instanceof Error && !['Error', 'Unauthorized', 'ConditionalCheckFailedException', 'TransactionCanceledException'].includes(error.name)) captureHandledFailure(error);
    const denied = error instanceof Error && error.name === 'Unauthorized';
    const message = denied ? 'Unauthorized: this broker fee request is no longer available to your account.'
      : error instanceof Error && error.name === 'Error' ? error.message : 'This broker fee request could not be completed. Please retry.';
    return { ok: false, error: message, ...(denied ? { errorType: 'Unauthorized' } : {}) };
  }
};
