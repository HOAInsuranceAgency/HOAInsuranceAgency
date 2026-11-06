import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mock=vi.hoisted(() => ({ observers: [] as {next(value:unknown):void;error(error:unknown):void}[], unsubscribe:vi.fn(), crm:vi.fn(), personal:vi.fn(), owner:vi.fn(), hub:vi.fn() }));
vi.mock('./client', () => ({ client:{subscriptions:{ onCrmChange:mock.crm, onPersonalChange:mock.personal, onOwnerChange:mock.owner }} }));
vi.mock('aws-amplify/utils', () => ({ Hub:{listen: () => mock.hub} }));
vi.mock('./activeRole', () => ({activeRoleHeaders:async () => ({'x-crm-role':'STAFF'})}));
import { LiveUpdatesProvider } from './LiveUpdatesProvider';
import { liveUpdates } from './liveUpdates';
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); mock.observers=[]; mock.crm.mockReset(); mock.personal.mockReset(); mock.owner.mockReset(); mock.unsubscribe.mockClear(); });
function setup() { for (const operation of [mock.crm,mock.personal,mock.owner]) operation.mockImplementation(() => ({subscribe:(observer: typeof mock.observers[number]) => {mock.observers.push(observer);return {unsubscribe:mock.unsubscribe};}})); }
describe('live transport', () => {
  it('connects authorized channels, captures role headers, and tears them down across role changes', async () => {
    setup(); const view=render(<LiveUpdatesProvider userId="a" role="STAFF">child</LiveUpdatesProvider>);
    await act(async () => {}); expect(mock.crm).toHaveBeenCalledWith({headers:{'x-crm-role':'STAFF'}}); expect(mock.personal).toHaveBeenCalledTimes(1); expect(mock.owner).not.toHaveBeenCalled();
    view.rerender(<LiveUpdatesProvider userId="a" role="OWNER">child</LiveUpdatesProvider>); await act(async () => {});
    expect(mock.unsubscribe).toHaveBeenCalledTimes(2); expect(mock.owner).toHaveBeenCalledTimes(1);
    view.unmount(); expect(mock.unsubscribe).toHaveBeenCalledTimes(5); expect(liveUpdates.getSnapshot().active).toBe(false);
  });
  it('forwards revocation immediately and retries terminated subscriptions without a refresh button', async () => {
    vi.useFakeTimers(); setup(); render(<LiveUpdatesProvider userId="a" role="STAFF">child</LiveUpdatesProvider>); await act(async () => {});
    const denied=vi.fn(); const unregister=liveUpdates.register(() => {}, () => ({onDenied:denied}));
    const error=new Error('Unauthorized'); act(() => mock.observers[0].error(error)); expect(denied).toHaveBeenCalledWith(error); expect(mock.unsubscribe).toHaveBeenCalledTimes(2);
    await act(async () => {await vi.advanceTimersByTimeAsync(30_000);}); expect(mock.crm).toHaveBeenCalledTimes(2); unregister();
  });
  it('fences input events before custom draft effects can run and ignores disposed callbacks', async () => {
    setup(); const view=render(<LiveUpdatesProvider userId="a" role="STAFF">child</LiveUpdatesProvider>); await act(async () => {});
    const fence=liveUpdates.getSnapshot(); document.dispatchEvent(new Event('input')); expect(liveUpdates.canPublish(fence)).toBe(false);
    const invalidate=vi.spyOn(liveUpdates,'invalidate'); const old=mock.observers[0]; view.unmount(); old.next({revision:'opaque'}); expect(invalidate).not.toHaveBeenCalled();
  });
});
