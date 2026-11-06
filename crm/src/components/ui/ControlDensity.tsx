import { createContext, useContext, type ReactNode } from 'react';

export type ControlSize = 'standard' | 'compact';
const ControlSizeContext = createContext<ControlSize>('standard');

/** Dense surfaces choose the same compact recipe for every nested control. */
export function ControlSizeProvider({ size, children }: { size: ControlSize; children: ReactNode }) {
  return <ControlSizeContext.Provider value={size}>{children}</ControlSizeContext.Provider>;
}
export function useControlSize(explicit?: ControlSize): ControlSize {
  const inherited = useContext(ControlSizeContext);
  return explicit ?? inherited;
}
