import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';

/** Routing, role providers, state and fictional notices stay in each scenario. */
export function mountPreview(content: ReactNode) {
  const element = document.getElementById('root');
  if (!element) throw new Error('The fictional preview needs its root element.');
  const root = createRoot(element);
  root.render(content);
  return root;
}
