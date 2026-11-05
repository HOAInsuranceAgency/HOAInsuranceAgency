import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { expect, it } from 'vitest';
import {
  accountPath, accountManagementPath, accountSearch, accountTabLocation,
  carrierPath, relationshipPath, relationshipsPath, crmSearchPath, newLeadPath, withAccountTab,
} from '../../../shared/crmRoutes';

it('keeps existing ordinary CRM path and query spellings', () => {
  expect(accountPath('a')).toBe('/accounts/a');
  expect(accountPath('a', { tab: 'quotes', hash: 'carrier-work' })).toBe('/accounts/a?tab=quotes#carrier-work');
  expect(accountManagementPath('a')).toBe('/accounts/a?management=1');
  expect(accountManagementPath('a', 'party')).toBe('/accounts/a?management=1&partyId=party');
  expect(accountSearch({ tab: 'submissions', estimate: 'estimate' })).toBe('?tab=submissions&estimate=estimate');
  expect(carrierPath('c')).toBe('/carriers/c');
  expect(relationshipPath('p')).toBe('/relationships/p');
  expect(relationshipsPath()).toBe('/relationships');
  expect(relationshipsPath('')).toBe('/relationships?q=');
  expect(newLeadPath()).toBe('/leads/new');
  expect(newLeadPath('p')).toBe('/leads/new?relatedParty=p');
});

it.each(['a/b', 'space & question?#', 'literal%2Fid', 'café 中文'])('encodes a raw ID once without changing its value: %s', id => {
  for (const build of [accountPath, carrierPath, relationshipPath]) {
    const path = build(id);
    expect(path.split('/')).toHaveLength(3);
    expect(decodeURIComponent(path.split('/')[2])).toBe(id);
    expect(path).not.toContain('?');
    expect(path).not.toContain('#');
  }
});

it.each(['', ' ', '.', '..', null, undefined])('refuses missing or reserved record IDs instead of linking to another route: %j', id => {
  for (const build of [accountPath, carrierPath, relationshipPath]) expect(() => build(id as string)).toThrow();
});

it('round-trips special query values through the receiving URLSearchParams readers', () => {
  const value = 'manager/a + b?x=1&#雪%2F';
  for (const [path, key] of [[accountManagementPath('a', value), 'partyId'], [newLeadPath(value), 'relatedParty'], [crmSearchPath(value), 'q'], [relationshipsPath(value), 'q'], [accountSearch({ tab: 'submissions', estimate: value }), 'estimate']]) {
    expect(new URLSearchParams(path.slice(path.indexOf('?'))).get(key)).toBe(value);
  }
  expect(crmSearchPath('two words')).toBe('/search?q=two%20words');
});

it('clones existing query state, preserves unrelated/repeated values, and clears the old anchor for tab clicks', () => {
  const previous = new URLSearchParams('management=1&partyId=p%2F%2B&q=two+words&tag=one&tag=two&tab=overview');
  const before = previous.toString();
  const next = accountTabLocation(previous, 'invoices');
  expect(next).toEqual({ search: '?management=1&partyId=p%2F%2B&q=two+words&tag=one&tag=two&tab=invoices', hash: '' });
  expect(previous.toString()).toBe(before);
  expect(new URLSearchParams(next.search).getAll('tag')).toEqual(['one', 'two']);
  expect(accountTabLocation('?request=req%2F1&tab=activity&tab=quotes', 'certificates').search).toBe('?request=req%2F1&tab=certificates');
});

it('keeps a trusted absolute CRM href origin, deployment prefix, query values, and fragment when opening a tab', () => {
  const href = 'https://crm.example.test/app/accounts/a%2Fb?submission=s%2F1&tag=one&tag=two#contacts';
  expect(withAccountTab(href, 'documents')).toBe(href.replace('#contacts', '&tab=documents#contacts'));
  expect(withAccountTab('/accounts/a?tab=overview#contacts', 'quotes')).toBe('/accounts/a?tab=quotes#contacts');
  expect(withAccountTab('https://crm.example.test/accounts/a', 'quotes')).toBe('https://crm.example.test/accounts/a?tab=quotes');
  expect(() => withAccountTab('', 'quotes')).toThrow('account link');
});

function AccountRouteProbe() {
  const { id } = useParams(), location = useLocation();
  return <output>{JSON.stringify({ id, tab: new URLSearchParams(location.search).get('tab'), hash: location.hash })}</output>;
}
it('matches the existing router pattern with the same decoded model ID and deep-link state', () => {
  render(<MemoryRouter initialEntries={[accountPath('a/b ?#', { tab: 'documents', hash: 'contacts' })]}><Routes><Route path="/accounts/:id" element={<AccountRouteProbe />} /></Routes></MemoryRouter>);
  expect(JSON.parse(screen.getByRole('status').textContent!)).toEqual({ id: 'a/b ?#', tab: 'documents', hash: '#contacts' });
});

function typedRouteContracts() {
  // @ts-expect-error account tab syntax is finite, not an arbitrary feature name
  accountPath('a', { tab: 'payroll' });
  // @ts-expect-error callers provide a known anchor without another hash prefix
  accountPath('a', { hash: '#contacts' });
  // @ts-expect-error an ID is required for a record route
  carrierPath();
}
it('checks typed link options through the normal TypeScript build', () => expect(typedRouteContracts).toBeTypeOf('function'));
