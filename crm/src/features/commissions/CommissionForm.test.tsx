import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { Input } from '../../components/ui/Input';
import { useAsyncResource } from '../../lib/useAsyncResource';
import { invalidateLiveUpdates } from '../../test/liveUpdates';
import { ActionForm } from './CommissionForm';

const read = vi.fn(), save = vi.fn();
beforeEach(() => { vi.resetAllMocks(); read.mockResolvedValue({ name: 'Current' }); save.mockResolvedValue({ok:true}); });
function Harness() {
  const resource=useAsyncResource<{name:string}>(read,[],{live:{topics:['OWNER']}});
  const [value,setValue]=useState(''),[requestId,setRequestId]=useState('first');
  const draft={value,requestId};
  return <><p>{resource.data?.name}</p><ActionForm title="Reviewed commission" draft={draft}
    submit={()=>save(draft)} onDone={async()=>{
      const next=crypto.randomUUID();setRequestId(next);await resource.refetch();
      return {savedDraft:{...draft,requestId:next}};
    }}><label>Evidence<Input value={value} onChange={e=>setValue(e.target.value)} /></label></ActionForm></>;
}
it('releases live reads after a saved form rotates its request ID, but preserves a later failed draft',async()=>{
  render(<Harness/>);await screen.findByText('Current');
  fireEvent.change(screen.getByLabelText('Evidence'),{target:{value:'Reviewed source'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));await screen.findByText('Saved.');
  expect(read).toHaveBeenCalledTimes(2);
  read.mockResolvedValue({name:'Updated'});await invalidateLiveUpdates(['OWNER']);
  expect(await screen.findByText('Updated')).toBeVisible();
  expect(read).toHaveBeenCalledTimes(3);
  fireEvent.change(screen.getByLabelText('Evidence'),{target:{value:'Unsubmitted change'}});
  save.mockRejectedValueOnce(new Error('Save unavailable'));
  fireEvent.click(screen.getByRole('button',{name:'Save'}));await screen.findByRole('alert');
  await invalidateLiveUpdates(['OWNER']);
  expect(read).toHaveBeenCalledTimes(3);
  expect(screen.getByLabelText('Evidence')).toHaveValue('Unsubmitted change');
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[1][0].requestId).not.toBe(save.mock.calls[0][0].requestId);
});
it('retains an edit queued during saving after the submitted draft succeeds',async()=>{
  let finish!:(value:unknown)=>void;save.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  render(<Harness/>);await screen.findByText('Current');
  fireEvent.change(screen.getByLabelText('Evidence'),{target:{value:'Reviewed source'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  expect(screen.getByLabelText('Evidence')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Evidence'),{target:{value:'Queued edit'}});
  await act(async()=>finish({ok:true}));await screen.findByText('Saved.');
  await invalidateLiveUpdates(['OWNER']);
  expect(read).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText('Evidence')).toHaveValue('Queued edit');
  expect(save).toHaveBeenCalledTimes(1);
});
