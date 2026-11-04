import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { DRAFT_FIELDS, LeadDraftScope, MAX_DRAFT_CHARS, useNewLeadDraft } from './newLeadDraft';

type Fields = Parameters<typeof useNewLeadDraft>[0];
const requestId = '12345678-1234-4234-8234-123456789012';
const empty = () => Object.fromEntries(DRAFT_FIELDS.map(field => [field, ''])) as Fields;
const wrapper = ({ children }: { children: ReactNode }) => <LeadDraftScope userId="one" role="ADMIN">{children}</LeadDraftScope>;
function mount(fields: Fields, attachmentCount = 0) {
  return renderHook(props => useNewLeadDraft(props.fields, requestId, props.attachmentCount, true), {
    wrapper, initialProps: { fields, attachmentCount },
  });
}
const storedKey = () => Object.keys(sessionStorage).find(key => key.startsWith('hoa-crm:new-lead-draft:'))!;

beforeEach(() => {
  sessionStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-03T17:00:00Z'));
});
afterEach(() => vi.useRealTimers());

it('recovers a field at the 2000-character boundary and preserves that valid snapshot when a later value exceeds it', async () => {
  const fields = { ...empty(), name: 'x'.repeat(2000) };
  const first = mount(fields);
  await waitFor(() => expect(first.result.current.backedUp).toBe(true));
  const key = storedKey(), valid = sessionStorage.getItem(key);
  first.rerender({ fields: { ...fields, name: 'x'.repeat(2001) }, attachmentCount: 0 });
  await waitFor(() => expect(first.result.current.unavailable).toBe(true));
  expect(first.result.current.backedUp).toBe(false);
  expect(sessionStorage.getItem(key)).toBe(valid);
  first.unmount();
  const recovered = mount(empty());
  expect(recovered.result.current.available?.fields).toEqual(fields);
});

it('uses the same 40000-character serialized bound for writing and recovering escaped field values', async () => {
  const fields = Object.fromEntries(DRAFT_FIELDS.map(field => [field, 'a'.repeat(2000)])) as Fields;
  const snapshot = () => ({ version: 1, savedAt: Date.now(), requestId, fields, attachmentCount: 0, attempted: false });
  let extra = MAX_DRAFT_CHARS - JSON.stringify(snapshot()).length;
  for (const field of DRAFT_FIELDS) {
    const count = Math.min(extra, 2000);
    fields[field] = '\\'.repeat(count) + 'a'.repeat(2000 - count);
    extra -= count;
  }
  expect(extra).toBe(0);
  expect(JSON.stringify(snapshot())).toHaveLength(40000);
  const first = mount(fields);
  await waitFor(() => expect(first.result.current.backedUp).toBe(true));
  const key = storedKey(), saved = sessionStorage.getItem(key)!;
  expect(saved).toHaveLength(40000);
  const overflow = { ...fields }, field = DRAFT_FIELDS.find(field => fields[field].includes('a'))!;
  overflow[field] = overflow[field].replace('a', '\\');
  first.rerender({ fields: overflow, attachmentCount: 0 });
  await waitFor(() => expect(first.result.current.unavailable).toBe(true));
  expect(first.result.current.backedUp).toBe(false);
  expect(sessionStorage.getItem(key)).toBe(saved);
  first.unmount();
  expect(mount(empty()).result.current.available?.fields).toEqual(fields);
});

it('accepts 1000 attachment references but refuses 1001 without losing the previous recovery snapshot', async () => {
  const first = mount({ ...empty(), name: 'Harbor' }, 1000);
  await waitFor(() => expect(first.result.current.backedUp).toBe(true));
  const key = storedKey(), valid = sessionStorage.getItem(key);
  first.rerender({ fields: { ...empty(), name: 'Harbor' }, attachmentCount: 1001 });
  await waitFor(() => expect(first.result.current.unavailable).toBe(true));
  expect(sessionStorage.getItem(key)).toBe(valid);
  first.unmount();
  expect(mount(empty()).result.current.available?.attachmentCount).toBe(1000);
});
