/** Fictional, data-only model records for tests and local previews.
 * Nothing in this directory may be imported by production entry points. */
import type { Account, Carrier, Contact, Policy, Quote } from '../src/lib/client';

/** Persisted fields exclude Amplify's lazy relationship functions. */
export type ModelData<T> = {
  [K in keyof T as NonNullable<T[K]> extends (...args: never[]) => unknown ? never : K]: T[K];
};
export const FIXTURE_INSTANT = '2026-09-14T13:00:00Z';

// UI props use Amplify's model type, but fixture rows are data snapshots, not
// SDK instances. This is the sole assertion at that boundary: required scalar
// fields are checked below; no relationship or API method is synthesized.
function model<T>(data: ModelData<T>): T { return structuredClone(data) as T; }

export function account(overrides: Partial<ModelData<Account>> = {}): Account {
  return model<Account>({ id: 'fictional-account', name: 'Fictional association', type: 'ASSOCIATION', stage: 'LEAD',
    createdAt: FIXTURE_INSTANT, updatedAt: FIXTURE_INSTANT, ...overrides });
}
export function quote(overrides: Partial<ModelData<Quote>> = {}): Quote {
  return model<Quote>({ id: 'fictional-quote', accountId: 'fictional-account', status: 'DRAFT',
    createdAt: FIXTURE_INSTANT, updatedAt: FIXTURE_INSTANT, ...overrides });
}
export function carrier(overrides: Partial<ModelData<Carrier>> = {}): Carrier {
  return model<Carrier>({ id: 'fictional-carrier', name: 'Fictional carrier', appointed: false,
    createdAt: FIXTURE_INSTANT, updatedAt: FIXTURE_INSTANT, ...overrides });
}
export function contact(overrides: Partial<ModelData<Contact>> = {}): Contact {
  return model<Contact>({ id: 'fictional-contact', accountId: 'fictional-account', name: 'Fictional contact',
    email: 'contact@example.test', createdAt: FIXTURE_INSTANT, updatedAt: FIXTURE_INSTANT, ...overrides });
}
export function policy(overrides: Partial<ModelData<Policy>> = {}): Policy {
  return model<Policy>({ id: 'fictional-policy', accountId: 'fictional-account', status: 'ACTIVE',
    createdAt: FIXTURE_INSTANT, updatedAt: FIXTURE_INSTANT, ...overrides });
}
