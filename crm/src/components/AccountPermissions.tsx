import { createContext, useContext, type ReactNode } from 'react';
import { communicationRequest } from '../lib/communications';
import { useAsyncResource } from '../lib/useAsyncResource';
import type { CommunicationResult } from '../lib/communicationContracts';
import { Button } from './ui/Button';

type Permissions = CommunicationResult<'accountPermissions'>;
// Components used outside an account retain their existing behavior. The
// account provider waits for the server before rendering any account controls.
const PermissionsContext = createContext<Permissions>({ assigned: true, level: 'OWN', edit: true, collaborate: true, send: true, invoice: true, bind: true });
export const useAccountPermissions = () => useContext(PermissionsContext);
export function AccountPermissions({ accountId, children }: { accountId: string; children: ReactNode }) {
  const resource = useAsyncResource(() => communicationRequest('accountPermissions', { accountId }), [accountId], { initialData: null, errorMessage: 'Could not verify your account permissions.', live: true, clearDataOnError: () => true });
  if (resource.error) return <p role="alert">{resource.error} <Button onClick={() => void resource.refetch()}>Retry access</Button></p>;
  if (!resource.data) return <p>Checking account access…</p>;
  const p = resource.data;
  return <PermissionsContext.Provider value={p}>
    {!p.assigned && <p className="card" role="status">This account is assigned to another salesperson or is unassigned. You have {p.level === 'READ' ? 'read-only' : p.level === 'COLLABORATE' ? 'collaboration' : 'editing'} access.
      {' '}Sending: {p.send ? 'allowed' : 'restricted'} · Invoicing: {p.invoice ? 'allowed' : 'restricted'} · Binding: {p.bind ? 'allowed' : 'restricted'}.</p>}
    {children}
  </PermissionsContext.Provider>;
}
export function AccountEditBoundary({ children, permission = 'edit' }: { children: ReactNode; permission?: 'edit' | 'assigned' }) {
  const access = useAccountPermissions();
  return <fieldset disabled={!access[permission]} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>{children}</fieldset>;
}
