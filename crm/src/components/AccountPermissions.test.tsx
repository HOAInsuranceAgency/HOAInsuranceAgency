import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
const h = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/communications', () => ({ communicationRequest: h.request }));
vi.mock('../lib/client', () => ({ friendlyError: (e: unknown) => e instanceof Error ? e.message : 'Failed' }));
import { AccountPermissions, AccountEditBoundary, useAccountPermissions } from './AccountPermissions';
function Controls() {
  const p = useAccountPermissions();
  return <><AccountEditBoundary><button>Edit account</button></AccountEditBoundary><button disabled={!p.send}>Send proposal</button><button disabled={!p.invoice}>Create invoice</button><button disabled={!p.bind}>Bind</button></>;
}
beforeEach(() => { h.request.mockReset(); });
it('does not mount account controls until permissions load', () => {
  h.request.mockImplementation(() => new Promise(() => {}));
  render(<AccountPermissions accountId="b"><Controls /></AccountPermissions>);
  expect(screen.queryByRole('button', {name:'Edit account'})).not.toBeInTheDocument();
});
it('keeps each action independent from read and edit access', async () => {
  h.request.mockResolvedValue({assigned:false,level:'READ',edit:false,collaborate:false,send:false,invoice:true,bind:false});
  render(<AccountPermissions accountId="b"><Controls /></AccountPermissions>);
  expect(await screen.findByRole('button', {name:'Edit account'})).toBeDisabled();
  expect(screen.getByRole('button', {name:'Send proposal'})).toBeDisabled();
  expect(screen.getByRole('button', {name:'Create invoice'})).toBeEnabled();
  expect(screen.getByRole('button', {name:'Bind'})).toBeDisabled();
});
it('does not expose controls on a failed permission lookup', async () => {
  h.request.mockRejectedValue(new Error('Access is unavailable'));
  render(<AccountPermissions accountId="b"><Controls /></AccountPermissions>);
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', {name:'Create invoice'})).not.toBeInTheDocument();
});
