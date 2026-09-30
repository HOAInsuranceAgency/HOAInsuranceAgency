/** Browser-only fixture store. No credentials, API client, or real writes. */
export { listAllPages } from '../../src/lib/pagination';
const params = new URLSearchParams(window.location.search);
export const useIsAdmin = () => params.get('role') === 'admin';
export const friendlyError = (error: unknown, fallback = 'Please try again.') =>
  error instanceof Error && error.message ? error.message : fallback;

type Opinion = { id: string; jurisdiction: string; effectiveAt: string; reviewBy: string; notes: string | null; occurredAt: string };
const today = new Date().toISOString().slice(0, 10);
const reviewBy = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
const opinions: Opinion[] = params.get('scenario') === 'current'
  ? ['OH', 'UT', 'VA'].map(jurisdiction => ({
    id: `fictional-${jurisdiction}`, jurisdiction, effectiveAt: today, reviewBy,
    notes: 'Fictional preview opinion.', occurredAt: new Date().toISOString(),
  })) : [];

export const client = { models: { PfCounselOpinion: {
  async listPfCounselOpinionByJurisdictionAndEffectiveAt(input: { jurisdiction: string }) {
    if (params.get('scenario') === 'error') throw new Error("Couldn't check all states. Please try again.");
    return { data: opinions.filter(opinion => opinion.jurisdiction === input.jurisdiction), nextToken: null };
  },
  async create(input: Omit<Opinion, 'id'>) {
    const data = { ...input, id: `fictional-${crypto.randomUUID()}` };
    opinions.push(data);
    return { data };
  },
} } };
