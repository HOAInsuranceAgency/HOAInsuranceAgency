import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { invalidateLiveUpdates } from '../test/liveUpdates';
const request = vi.hoisted(() => vi.fn());
vi.mock('../lib/communications', () => ({ communicationRequest: request }));
import { useLeadEligibilitySettings, type EligibilityRosterMember } from './LeadEligibilitySettings';

const roster = (count: number): EligibilityRosterMember[] => Array.from({ length: count }, (_, index) => ({
  userId: `member-${index}`, name: `Member ${index}`, email: `member-${index}@example.test`, enabled: true,
  groups: ['PRODUCER'], hasProfile: true,
}));
const settings = (id: string, version: number, frontId = 'tea_original') => ({ userId: id, name: id, version, frontId, enabled: true, salesperson: true });
beforeEach(() => { request.mockReset(); });

it('refreshes settings for every visible roster page rather than only the last loaded subset', async () => {
  let version = 1;
  request.mockImplementation(async (_operation, input) => ({ team: input.userIds.map((id: string) => ({ ...settings(id, version), receiveNewLeads: version === 1 })) }));
  const { result, rerender } = renderHook(({ members }) => useLeadEligibilitySettings(members), { initialProps: { members: roster(20) } });
  await waitFor(() => expect(result.current.resource.data.team).toHaveLength(20));
  rerender({ members: roster(21) });
  await waitFor(() => expect(result.current.resource.data.team).toHaveLength(21));
  expect(request.mock.calls[1][1].userIds).toEqual(['member-20']);
  version = 2;
  await invalidateLiveUpdates();
  expect(result.current.resource.data.team.every(row => row.version === 2 && row.receiveNewLeads === false)).toBe(true);
  expect(request.mock.calls.slice(2).map(call => call[1].userIds.length)).toEqual([20, 1]);
});

it('fences local settings maps as well as rendered data when a connection editor opens mid-read', async () => {
  let finish!: (value: unknown) => void;
  request.mockResolvedValueOnce({ team: [settings('member-0', 1)] })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ team: [settings('member-0', 2, 'tea_current')] });
  const { result } = renderHook(() => useLeadEligibilitySettings(roster(1)));
  await waitFor(() => expect(result.current.resource.data.team[0]?.version).toBe(1));
  await invalidateLiveUpdates();
  act(() => result.current.editMember(result.current.resource.data.team[0]));
  await act(async () => finish({ team: [settings('member-0', 9, 'tea_stale')] }));
  expect(result.current.resource.data.team[0].version).toBe(1);
  expect(result.current.editing?.frontId).toBe('tea_original');
  act(() => result.current.closeEditor());
  await waitFor(() => expect(result.current.resource.data.team[0]?.version).toBe(2));
  expect(result.current.resource.data.team[0].frontId).toBe('tea_current');
});

it('retains authorized settings on transient background failure and clears maps and an open editor on denial', async () => {
  let reject!: (error: Error) => void;
  request.mockResolvedValueOnce({ team: [settings('member-0', 1)] })
    .mockRejectedValueOnce(new Error('Temporary outage'))
    .mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }))
    .mockResolvedValue({ team: [] });
  const { result } = renderHook(() => useLeadEligibilitySettings(roster(1)));
  await waitFor(() => expect(result.current.resource.data.team[0]?.version).toBe(1));
  await invalidateLiveUpdates();
  expect(result.current.resource.data.team[0].frontId).toBe('tea_original');
  expect(result.current.resource.refreshError).toBe('Temporary outage');
  await invalidateLiveUpdates();
  act(() => result.current.editMember(result.current.resource.data.team[0]));
  await act(async () => reject(Object.assign(new Error('Access denied'), { name: 'Unauthorized' })));
  expect(result.current.editing).toBeNull();
  expect(result.current.resource.data.team).toEqual([]);
  expect(result.current.resource.error).toBe('Access denied');
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.resource.data.team).toHaveLength(1));
  expect(result.current.resource.data.team[0]).toMatchObject({ version: 0 });
  expect(result.current.resource.data.team[0].frontId).toBeUndefined();
});
