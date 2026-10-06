import { useRef, useState } from 'react';
import { communicationRequest } from '../lib/communications';
import { useRowInteraction, type InteractionChange } from '../lib/useRefreshOnReturn';
import {
  formatCommission,
  parseEstimate,
  type CommercialPlan,
} from '../../../shared/quotePackages';

export function OpportunityEstimate({
  plan,
  onSaved,
  onInteractionChange,
}: {
  plan: CommercialPlan;
  onSaved: (plan: CommercialPlan) => void;
  onInteractionChange?: InteractionChange;
}) {
  const [editing, setEditing] = useState(false),
    [amount, setAmount] = useState(''),
    [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const pending = useRef(false);
  const [editingVersion, setEditingVersion] = useState(plan.version);
  useRowInteraction(`estimate:${plan.accountId}`, editing || saving, onInteractionChange);
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {!editing ? (
        <button
          className="link"
          aria-label="Edit estimated opportunity"
          onClick={() => {
            setEditingVersion(plan.version);
            setAmount(
              plan.estimatedCents == null
                ? ''
                : (plan.estimatedCents / 100).toFixed(2),
            );
            setEditing(true);
            setError('');
          }}
        >
          {plan.estimatedCents == null
            ? 'Add estimate'
            : formatCommission(plan.estimatedCents)}
        </button>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (pending.current) return;
            pending.current = true;
            setError('');
            setSaving(true);
            try {
              parseEstimate(amount);
              const result = await communicationRequest<{
                plan: CommercialPlan;
              }>(
                'saveCommercial',
                {
                  accountId: plan.accountId,
                  version: editingVersion,
                  action: 'ESTIMATE',
                  amount,
                },
                true,
              );
              onSaved(result.plan);
              setEditing(false);
            } catch (err) {
              setError(
                err instanceof Error ? err.message : 'Could not save estimate',
              );
            } finally {
              pending.current = false;
              setSaving(false);
            }
          }}
        >
          <label className="field">
            Agency commission ($)
            <input
              aria-label="Estimated agency commission"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={saving}
              style={{ minWidth: 130 }}
            />
          </label>
          <div className="form-actions">
            <button className="primary" disabled={saving}>
              Save
            </button>
            <button
              type="button"
              className="secondary"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="error-text small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
