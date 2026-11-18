import { useUnsavedChanges } from './editProtection';
import { useLiveUpdateBlock } from './useLiveUpdates';
export { useEditProtection } from './editProtection';
export function useCommissionUnsavedChanges(...args: Parameters<typeof useUnsavedChanges>) {
  useLiveUpdateBlock(args[0] || !!args[1]?.busy);
  return useUnsavedChanges(...args);
}
