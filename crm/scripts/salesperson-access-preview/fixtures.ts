import { DEFAULT_SALESPERSON_ACCESS, parseSalespersonAccess } from '../../../shared/salespersonAccess';
let state = { policy: { ...DEFAULT_SALESPERSON_ACCESS }, version: 0, updatedAt: '' };
export function friendlyError(error: unknown, fallback = 'Could not complete this request.') { return error instanceof Error ? error.message : fallback; }
export async function communicationRequest(operation: string, input?: any) {
  if (operation === 'salespersonAccessSettings') return structuredClone(state);
  if (operation === 'saveSalespersonAccessSettings') {
    if (input.version !== state.version) throw new Error('Reload settings and try again.');
    state = {policy:parseSalespersonAccess(input.policy),version:state.version+1,updatedAt:new Date().toISOString()};
    return structuredClone(state);
  }
  throw new Error(`Unsupported preview operation: ${operation}`);
}
