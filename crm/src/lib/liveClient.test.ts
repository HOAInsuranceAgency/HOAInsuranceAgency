import { afterEach, describe, expect, it, vi } from 'vitest';
const api=vi.hoisted(() => ({ create:vi.fn(), update:vi.fn(), remove:vi.fn(), status:vi.fn(), file:vi.fn(), command:vi.fn(), list:vi.fn() }));
vi.mock('aws-amplify/auth', () => ({getCurrentUser:async () => ({userId:'actor'})}));
vi.mock('aws-amplify/data', () => ({ generateClient:() => ({models:{Account:{create:api.create,update:api.update,delete:api.remove},Carrier:{update:api.update,list:api.list}},mutations:{brokerFeeAction:api.status,crmFile:api.file,commissionAction:api.command}}) }));
import {client} from './client';
import {liveUpdates} from './liveUpdates';
afterEach(() => {vi.restoreAllMocks(); for (const fn of Object.values(api)) fn.mockReset();});
describe('live client write boundaries', () => {
  it('stamps attributed writes, blocks through settlement, and invalidates only after completion', async () => {
    let complete!: () => void; api.create.mockImplementation(() => new Promise<void>(resolve => {complete=resolve;}));
    const invalidate=vi.spyOn(liveUpdates,'invalidate');
    const pending=client.models.Account.create({name:'Fictional HOA',type:'ASSOCIATION',stage:'LEAD'}); await vi.waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(liveUpdates.getSnapshot().writes).toBe(1); expect(invalidate).not.toHaveBeenCalled();
    expect(api.create).toHaveBeenCalledWith({name:'Fictional HOA',type:'ASSOCIATION',stage:'LEAD',lastWriteBy:'actor'}); complete(); await pending;
    expect(liveUpdates.getSnapshot().writes).toBe(0); expect(invalidate).toHaveBeenCalledTimes(1);
  });
  it('preserves delete/update payloads and releases barriers after rejected commands', async () => {
    api.remove.mockResolvedValue({data:null}); api.update.mockResolvedValue({data:null}); api.command.mockRejectedValue(new Error('uncertain'));
    await client.models.Account.delete({id:'a'}); expect(api.remove).toHaveBeenCalledWith({id:'a'});
    await client.models.Carrier.update({id:'c',name:'Example'}); expect(api.update).toHaveBeenCalledWith({id:'c',name:'Example'});
    await expect(client.mutations.commissionAction({operation:'pay',input:'{}'})).rejects.toThrow('uncertain'); expect(liveUpdates.getSnapshot().writes).toBe(0);
  });
  it('legacy status/file reads do not invalidate or fence themselves; unknown operations remain writes', async () => {
    const invalidate=vi.spyOn(liveUpdates,'invalidate'); const fence=liveUpdates.getSnapshot();
    api.status.mockResolvedValue({data:'{}'}); api.file.mockResolvedValue({data:'{}'});
    await client.mutations.brokerFeeAction({input:JSON.stringify({op:'status'})}); await client.mutations.crmFile({operation:'read',path:'documents/a'}); await client.mutations.crmFile({operation:'list',path:'documents/a'});
    expect(liveUpdates.canPublish(fence)).toBe(true); expect(invalidate).not.toHaveBeenCalled();
    await client.mutations.brokerFeeAction({input:JSON.stringify({op:'futureOperation'})}); expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
