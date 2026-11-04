import { acquisitionLabel, websiteFormLabel } from './leadSource';
import type { AccountListItem, AccountListSort, AccountListStage } from './accountList';

/** Fixed-width IEEE-754 ordering preserves fractions and negative numbers
 * without guessing a maximum premium or losing cents to decimal padding. */
export function accountListNumberKey(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Account list sort value must be finite');
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Object.is(value, -0) ? 0 : value, false);
  const bytes = Array.from({ length: 8 }, (_, i) => view.getUint8(i));
  const negative = (bytes[0] & 128) !== 0;
  for (let i = 0; i < bytes.length; i++) bytes[i] = negative ? bytes[i] ^ 255 : i === 0 ? bytes[i] ^ 128 : bytes[i];
  return bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function accountListSortKey(value: string | number | null | undefined, accountId: string) {
  const missing = value == null || value === '';
  const normalized = missing ? '' : typeof value === 'number' ? accountListNumberKey(value)
    : value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  // DynamoDB sort keys are limited to 1024 bytes. Fail rather than silently
  // truncate values and change the order of indistinguishable prefixes.
  // NUL-NUL terminates below every encoded input character, so 'Willow'
  // sorts before 'Willow Bay'. Escape literal NUL to NUL-SOH to keep the
  // terminator unambiguous without changing the order of valid strings.
  const sk = `${normalized.replace(/\u0000/g, '\u0000\u0001')}\u0000\u0000${accountId}`;
  if (new TextEncoder().encode(sk).byteLength > 1024) throw new Error('Account list sort key is too long');
  return { sk, missing };
}
export function accountListSortValue(item: AccountListItem, sort: AccountListSort, stage: AccountListStage, salespersonName?: string) {
  const account = item.account;
  switch (sort) {
    case 'name': return account.name;
    case 'type': return account.type;
    case 'contact': return item.contact?.name;
    case 'city': return account.city;
    case 'state': return account.state;
    case 'salesperson': return salespersonName ?? (item.commercial.salespersonId ? 'Unavailable teammate' : 'Unassigned');
    case 'source': return acquisitionLabel(account.leadSource, account.source);
    case 'form': return websiteFormLabel(account.source);
    case 'estimate': return item.commercial.plan.estimatedCents;
    case 'pending': return item.forecast.cents;
    case 'units': return account.unitCount;
    case 'tiv': return account.totalInsuredValue;
    case 'entered': return account.createdAt;
    case 'renewal': return stage === 'LEAD' ? account.currentPolicyExpiration : item.renewalDate;
    case 'followUp': return account.stage === 'LEAD' ? item.commercial.snooze?.followUpOn : null;
  }
}
