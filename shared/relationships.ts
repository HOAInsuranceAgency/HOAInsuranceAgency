export const DIRECTORY_READS = new Set([
  'relationshipSearch',
  'relationshipProfiles',
  'relationshipPortfolio',
  'relationshipAffiliations',
  'relationshipLegacyCandidates',
]);
import { validCalendarDate } from './renewalPolicy';
import { agencyDay } from './leadActionGuidance';

export const RELATIONSHIP_ROLES = ['MANAGER', 'OWNER', 'REFERRER', 'INSURED'] as const;
export type RelationshipRole = (typeof RELATIONSHIP_ROLES)[number];
export const RELATIONSHIP_LABELS: Record<RelationshipRole, string> = {
  MANAGER: 'Management',
  OWNER: 'Owner / landlord',
  REFERRER: 'Original referrer',
  INSURED: 'Own insurance account',
};
export interface DatedRelationship {
  validFrom?: string | null;
  validUntil?: string | null;
}
export function relationshipCurrent(value: DatedRelationship, day = agencyDay(new Date().toISOString())) {
  return (!value.validFrom || value.validFrom <= day) && (!value.validUntil || value.validUntil > day);
}
export function relationshipDates(from: unknown, until: unknown) {
  const validFrom = from == null || from === '' ? null : from;
  const validUntil = until == null || until === '' ? null : until;
  if (
    (validFrom !== null && (typeof validFrom !== 'string' || !validCalendarDate(validFrom))) ||
    (validUntil !== null && (typeof validUntil !== 'string' || !validCalendarDate(validUntil)))
  )
    throw new Error('Choose valid calendar dates.');
  if (validFrom && validUntil && validFrom >= validUntil)
    throw new Error('The end date must be after the start date.');
  return { validFrom: validFrom as string | null, validUntil: validUntil as string | null };
}
export interface PartyRecord {
  id: string;
  kind: 'PERSON' | 'ORGANIZATION';
  name: string;
  category?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  notes?: string | null;
  ownerId: string;
  archived?: boolean | null;
  revision: number;
  updatedAt?: string;
}
export interface AccountRelationshipRecord extends DatedRelationship {
  id: string;
  accountId: string;
  partyId: string;
  role: RelationshipRole;
  notes?: string | null;
  revision: number;
  contactIds?: (string | null)[] | null;
}
export interface AffiliationRecord extends DatedRelationship {
  id: string;
  personId: string;
  organizationId: string;
  title?: string | null;
  revision: number;
}
export function directoryText(value: unknown, max: number, required = false): string | null {
  if (value != null && typeof value !== 'string') throw new Error('Enter text in this field.');
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > max || (required && !text))
    throw new Error(
      required ? `Enter a value of 1 to ${max} characters.` : `Keep this field to ${max} characters.`,
    );
  return text || null;
}
