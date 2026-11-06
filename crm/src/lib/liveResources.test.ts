import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAsyncResource } from './useAsyncResource';
import { useFormState } from './useFormState';
import { liveUpdates } from './liveUpdates';
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ models: {} }) }));
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
let stop: () => void;
const advance = async (ms = 100) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T00:00:00Z')); stop=liveUpdates.start('test:OWNER'); });
afterEach(() => { cleanup(); stop(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe('live resource safety', () => {
  it('replaces a snapshot in the background without a loading gate or losing it on transient errors', async () => {
    const pending=deferred<string>(); const read=vi.fn().mockResolvedValueOnce('first').mockImplementationOnce(() => pending.promise).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useAsyncResource(read, [], { initialData: '', live: true, clearDataOnError: () => true }));
    await advance(0); expect(result.current.data).toBe('first');
    liveUpdates.invalidate(); await advance(); expect(result.current.loading).toBe(false); expect(result.current.refreshing).toBe(true); expect(result.current.data).toBe('first');
    await act(async () => pending.resolve('second')); expect(result.current.data).toBe('second');
    liveUpdates.invalidate(); await advance(1000); expect(result.current.data).toBe('second'); expect(result.current.error).toBe(''); expect(result.current.refreshError).toContain('offline');
  });
  it('preserves a dirty editor from a late snapshot and retries after the edit is saved', async () => {
    const pending=deferred<{name:string}>(); const read=vi.fn().mockResolvedValueOnce({name:'first'}).mockImplementationOnce(() => pending.promise).mockResolvedValue({name:'confirmed'});
    const { result } = renderHook(() => { const resource=useAsyncResource(read, [], {initialData:{name:''},live:true}); const editor=useFormState(resource.data); return {resource,editor}; });
    await advance(0); expect(result.current.editor.form.name).toBe('first');
    liveUpdates.invalidate(); await advance(); act(() => result.current.editor.setF('name','draft'));
    await act(async () => pending.resolve({name:'late'})); expect(result.current.resource.data.name).toBe('first'); expect(result.current.editor.form.name).toBe('draft');
    act(() => result.current.editor.markSaved()); await advance(1000); expect(result.current.resource.data.name).toBe('confirmed'); expect(result.current.editor.form.name).toBe('confirmed');
  });
  it('local confirmed patches win over older reads', async () => {
    const pending=deferred<string>(); const read=vi.fn().mockResolvedValueOnce('first').mockImplementationOnce(() => pending.promise);
    const {result}=renderHook(() => useAsyncResource(read, [], { initialData:'',live:true })); await advance(0);
    liveUpdates.invalidate(); await advance(); act(() => result.current.setData('saved'));
    await act(async () => pending.resolve('old')); expect(result.current.data).toBe('saved'); expect(result.current.refreshing).toBe(false);
  });
  it('clears private data immediately on denial even when an editor lock supersedes the read', async () => {
    const pending=deferred<string>(); const read=vi.fn().mockResolvedValueOnce('private').mockImplementationOnce(() => pending.promise);
    const {result}=renderHook(() => useAsyncResource(read, [], {initialData:'',live:true})); await advance(0);
    liveUpdates.invalidate(); await advance(); const release=liveUpdates.acquireBlock();
    await act(async () => pending.reject(new Error('Unauthorized'))); expect(result.current.data).toBe(''); expect(result.current.error).toContain('permission'); release();
  });
  it('never polls opt-out or manual command-like fetchers', async () => {
    const command=vi.fn().mockResolvedValue('created'); const manual=vi.fn();
    renderHook(() => useAsyncResource(command, [])); renderHook(() => useAsyncResource(manual, [], {manual:true,live:true})); await advance(0);
    liveUpdates.invalidate(); await advance(120_000); expect(command).toHaveBeenCalledTimes(1); expect(manual).not.toHaveBeenCalled();
  });
  it('does not roll a successful save back to an older seed and preserves edits made during saving', () => {
    const {result,rerender}=renderHook(({name}) => useFormState({name}), {initialProps:{name:'original'}});
    act(() => result.current.setF('name','submitted')); const submitted=result.current.form;
    rerender({name:'old server response'}); act(() => result.current.setF('name','newer typing'));
    act(() => result.current.markSaved(submitted)); expect(result.current.form.name).toBe('newer typing'); expect(result.current.dirty).toBe(true);
    act(() => result.current.reset()); expect(result.current.form.name).toBe('submitted'); expect(result.current.dirty).toBe(false);
  });
});

it('cannot repopulate denied data from a late local save callback before authorized revalidation', async () => {
  const read=vi.fn().mockResolvedValue('private');
  const {result}=renderHook(() => useAsyncResource(read, [], {initialData:'',live:true})); await advance(0);
  act(() => result.current.invalidate(new Error('Unauthorized')));
  act(() => result.current.setData('late private save')); expect(result.current.data).toBe('');
  await act(async () => result.current.refetch()); act(() => result.current.setData('authorized update')); expect(result.current.data).toBe('authorized update');
});
it('compares rebuilt nested source charges by content without repeatedly reseeding a pristine form', () => {
  const {result,rerender}=renderHook(() => useFormState({charges:[{id:'x',amount:100}]}));
  rerender(); expect(result.current.form.charges).toEqual([{id:'x',amount:100}]); expect(result.current.dirty).toBe(false);
});

it('retains a confirmed newer row through index lag without resurrecting removed rows', async () => {
  const old={id:'a',version:1,name:'old'}, saved={id:'a',version:2,name:'saved'};
  const read=vi.fn().mockResolvedValue([old,{id:'removed',version:1,name:'gone'}]);
  const {result}=renderHook(() => useAsyncResource(read, [], {initialData:[] as typeof old[],live:true})); await advance(0);
  act(() => result.current.setData([saved,{id:'removed',version:1,name:'gone'}]));
  read.mockResolvedValueOnce([old]); liveUpdates.invalidate(); await advance(); expect(result.current.data).toEqual([saved]);
  read.mockResolvedValueOnce([{...saved,version:3,name:'new server'}]); liveUpdates.invalidate(); await advance(1000);
  expect(result.current.data).toEqual([{...saved,version:3,name:'new server'}]);
});
