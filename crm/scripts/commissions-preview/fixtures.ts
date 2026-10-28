import { commissionPolicy, line, statement } from '../../src/test/commissionFixtures';
import { appendEntry, type CommissionOverview } from '../../../shared/commissions';
const base = commissionPolicy();
base.producerName = 'Avery Brooks';
base.carrierName = 'Harbor Mutual';
base.carrierTerms.name = 'Harbor Mutual';
let policy = appendEntry(base, line({ agencyCents: 200000 }), statement(), 'receipt-oct');
policy = appendEntry(
  policy,
  line({ lineRef: 'CANCEL-105', kind: 'REVERSAL', originalId: 'receipt-oct', agencyCents: -50000 }),
  statement(),
  'cancel-oct',
);
export const data: CommissionOverview = {
  plans: [
    {
      id: 'producer',
      producerId: 'producer',
      name: 'Avery Brooks',
      version: 1,
      terms: [
        {
          from: '2026-01-01',
          newBps: 1600,
          renewalBps: 800,
          agreement: 'Fictional signed agreement',
        },
      ],
    },
  ],
  carriers: [base.carrierTerms],
  policies: [policy],
  statements: [{ ...statement(), lines: [line()], totalCents: 100000 }],
  batches: [],
};
export const readCommissions = async () => structuredClone(data);
export const commissionAction = async () => {
  throw new Error('This preview uses fictional data and cannot save or download private files.');
};
export const useIsOwner = () => new URLSearchParams(location.search).get('role') !== 'producer';
export const communicationRequest = async () => ({
  team: [{ userId: 'producer', name: 'Avery Brooks' }],
});
export const fmtMoney = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
export const friendlyError = (e: unknown) => (e instanceof Error ? e.message : 'Preview error');
export const client = {
  models: {
    Carrier: { list: async () => ({ data: [{ id: 'c', name: 'Harbor Mutual' }] }) },
    Policy: { list: async () => ({ data: [] }) },
  },
};
export const listAllPages = async <T>(fetch: () => Promise<{ data: T[] }>) => (await fetch()).data;
