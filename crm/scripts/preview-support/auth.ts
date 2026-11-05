import { createContext, useContext } from 'react';
/** Preview-only contexts preserve the real UI's deny-by-default behavior.
 * A scenario which exposes privileged controls must explicitly replace auth. */
export const AdminContext = createContext(false);
export const OwnerContext = createContext(false);
export const useIsAdmin = () => useContext(AdminContext);
export const useIsOwner = () => useContext(OwnerContext);
export async function fetchUserGroups(): Promise<string[]> { throw new Error('This local preview has no signed-in session.'); }
