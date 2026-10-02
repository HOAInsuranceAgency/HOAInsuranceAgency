import { validCalendarDate } from './renewalPolicy';

/** A producer-selected follow-up date, separate from retired task scheduling. */
export interface LeadSnooze {
  accountId: string;
  version: number;
  followUpOn: string | null;
  note: string;
  updatedAt?: string;
  updatedBy?: string;
}

export function emptyLeadSnooze(accountId: string): LeadSnooze {
  return { accountId, version: 0, followUpOn: null, note: '' };
}

export function leadSnoozeStatus(snooze: LeadSnooze | undefined, today: string): 'ACTIVE' | 'SNOOZED' | 'DUE' {
  if (!snooze?.followUpOn) return 'ACTIVE';
  return snooze.followUpOn > today ? 'SNOOZED' : 'DUE';
}

export function validateLeadSnooze(followUpOn: unknown, note: unknown, today: string) {
  if (followUpOn !== null && (typeof followUpOn !== 'string' || !validCalendarDate(followUpOn) || followUpOn <= today)) {
    throw new Error('Choose a follow-up date after today.');
  }
  if (typeof note !== 'string' || note.trim().length > 1000) throw new Error('Keep the follow-up note to 1,000 characters or fewer.');
  return { followUpOn, note: followUpOn === null ? '' : note.trim() } as Pick<LeadSnooze, 'followUpOn' | 'note'>;
}
