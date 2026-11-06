import type { ReactNode } from 'react';
import './CommissionPanel.css';

/** One disclosure style across the entire commission workspace. Native details
 * retains keyboard support and each form's existing open/closed behavior. */
export default function CommissionPanel({
  title, hint, children, danger = false, open,
}: {
  title: ReactNode;
  hint?: string;
  children: ReactNode;
  danger?: boolean;
  open?: boolean;
}) {
  return (
    <details className={'commission-panel' + (danger ? ' commission-panel--danger' : '')} open={open}>
      <summary><span>{title}</span>{hint && <small>{hint}</small>}</summary>
      <div className="commission-panel-body">{children}</div>
    </details>
  );
}
