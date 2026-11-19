import { createContext } from 'react';
export const FinancialStale = createContext(false);
export const CommissionAccessContext = createContext<(error: unknown) => void>(() => {});
