import { useCommissionPreference } from '../lib/commissionWorkflow';
import type { ReactNode } from 'react';
import './CommissionPanel.css';

/** One disclosure style across the entire commission workspace. Native details
 * retains keyboard support and each form's existing open/closed behavior. */
export default function CommissionPanel({
  title, hint, children, danger = false, open, remember, id,
}: {
  title: ReactNode;
  hint?: string;
  children: ReactNode;
  danger?: boolean;
  open?: boolean;
  remember?: string;
  id?: string;
}) {
  const [savedOpen, setSavedOpen] = useCommissionPreference(remember ?? "unused-panel", !!open);
  return (
    <details id={id} className={'commission-panel' + (danger ? ' commission-panel--danger' : '')} open={remember ? savedOpen : open} onToggle={remember ? e => setSavedOpen(e.currentTarget.open) : undefined}>
      <summary><span>{title}</span>{hint && <small>{hint}</small>}</summary>
      <div className="commission-panel-body">{children}</div>
    </details>
  );
}
