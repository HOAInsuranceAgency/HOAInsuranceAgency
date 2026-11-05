import { useState } from 'react';
import {
  decimal,
  type CommissionPlan
} from '../../../../shared/commissions';
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { commissionAction } from '../../lib/commissions';
import { ActionForm, Field } from './CommissionForm';

export function PlanEditor({
  producerId,
  name,
  plan,
  refresh,
}: {
  producerId: string;
  name: string;
  plan?: CommissionPlan;
  refresh: () => Promise<void>;
}) {
  const [accountBoundFrom, setAccountBoundFrom] = useState(plan?.accountBoundFrom ?? '');
  const [receiptsFrom, setReceiptsFrom] = useState(plan?.receiptsFrom ?? '');
  const [terms, setTerms] = useState(
    plan?.terms.map((t) => ({
      ...t,
      to: t.to ?? '',
      newRate: String(t.newBps / 100),
      renewalRate: String(t.renewalBps / 100),
      gimEnabled: !!t.gim,
      gimNewRate: t.gim ? String(t.gim.newBps / 100) : '',
      gimRenewalRate: t.gim ? String(t.gim.renewalBps / 100) : '',
      gimAgreement: t.gim?.agreement ?? '',
    })) ?? [
      {
        from: '',
        to: '',
        newRate: '',
        renewalRate: '',
        agreement: '',
        gimEnabled: false,
        gimNewRate: '',
        gimRenewalRate: '',
        gimAgreement: '',
      },
    ],
  );
  return (
    <ActionForm
      title={`${name} · commission agreement`}
      draft={{ accountBoundFrom, receiptsFrom, terms }}
      button="Save producer agreement"
      onDone={refresh}
      submit={() =>
        commissionAction('savePlan', {
          producerId,
          name,
          version: plan?.version ?? 0,
          ...(accountBoundFrom ? { accountBoundFrom } : {}),
          ...(receiptsFrom ? { receiptsFrom } : {}),
          terms: terms.map((t) => ({
            from: t.from,
            ...(t.to ? { to: t.to } : {}),
            newBps: decimal(t.newRate),
            renewalBps: decimal(t.renewalRate),
            agreement: t.agreement,
            ...(t.gimEnabled
              ? {
                gim: {
                  newBps: decimal(t.gimNewRate),
                  renewalBps: decimal(t.gimRenewalRate),
                  agreement: t.gimAgreement,
                },
              }
              : {}),
          })),
        })
      }
    >
      <div className="form-grid">
        <label className="field">
          Account first-bind cutoff (optional)
          <Input
            type="date"
            value={accountBoundFrom}
            onChange={(e) => setAccountBoundFrom(e.target.value)}
          />
        </label>
        <label className="field">
          Agency receipt eligibility begins (optional)
          <Input
            type="date"
            value={receiptsFrom}
            onChange={(e) => setReceiptsFrom(e.target.value)}
          />
        </label>
      </div>
      <p className="small muted">
        Accounts first bound before the cutoff earn no producer commission, including later
        renewals. The cutoff date itself is eligible. This rule uses the account’s original first
        bind, not the current policy’s bind or effective date. Blank means no cutoff for this
        producer.
      </p>
      {terms.map((t, i) => (
        <div key={i} className="commission-period">
          <div className="form-grid">
            <Field
              label={`Effective from ${i + 1}`}
              type="date"
              value={t.from}
              change={(v) => setTerms(terms.map((r, j) => (i === j ? { ...r, from: v } : r)))}
            />
            <label className="field">
              Through (optional)
              <Input
                type="date"
                value={t.to}
                onChange={(e) =>
                  setTerms(terms.map((r, j) => (i === j ? { ...r, to: e.target.value } : r)))
                }
              />
            </label>
            <Field
              label={`New business % ${i + 1}`}
              value={t.newRate}
              change={(v) => setTerms(terms.map((r, j) => (i === j ? { ...r, newRate: v } : r)))}
            />
            <Field
              label={`Renewal % ${i + 1}`}
              value={t.renewalRate}
              change={(v) =>
                setTerms(terms.map((r, j) => (i === j ? { ...r, renewalRate: v } : r)))
              }
            />
          </div>
          <Field
            label={`Agreement reference ${i + 1}`}
            value={t.agreement}
            change={(v) => setTerms(terms.map((r, j) => (i === j ? { ...r, agreement: v } : r)))}
          />
          <h3>GIM Property Management · house-account rates</h3>
          <label className="checkbox-field">
            <Input
              type="checkbox"
              checked={t.gimEnabled}
              onChange={(e) =>
                setTerms(
                  terms.map((r, j) => (i === j ? { ...r, gimEnabled: e.target.checked } : r)),
                )
              }
            />
            {`Configure GIM rates for period ${i + 1}`}
          </label>
          {t.gimEnabled ? (
            <>
              <div className="form-grid">
                <Field
                  label={`GIM new business % ${i + 1}`}
                  value={t.gimNewRate}
                  change={(v) =>
                    setTerms(terms.map((r, j) => (i === j ? { ...r, gimNewRate: v } : r)))
                  }
                />
                <Field
                  label={`GIM renewal % ${i + 1}`}
                  value={t.gimRenewalRate}
                  change={(v) =>
                    setTerms(terms.map((r, j) => (i === j ? { ...r, gimRenewalRate: v } : r)))
                  }
                />
              </div>
              <Field
                label={`GIM agreement reference ${i + 1}`}
                value={t.gimAgreement}
                change={(v) =>
                  setTerms(terms.map((r, j) => (i === j ? { ...r, gimAgreement: v } : r)))
                }
              />
              <p className="small muted">
                GIM rates use this period’s dates. Add a rate period when either schedule changes.
              </p>
            </>
          ) : (
            <p className="small muted">
              GIM terms pending. GIM policies cannot be bound under this period until both rates and
              the agreement reference are configured.
            </p>
          )}
          <Button variant="secondary"
            type="button"

            disabled={terms.length === 1}
            onClick={() => setTerms(terms.filter((_, j) => j !== i))}
          >
            Remove period
          </Button>
        </div>
      ))}
      <Button variant="secondary"
        type="button"

        onClick={() =>
          setTerms([
            ...terms,
            {
              from: '',
              to: '',
              newRate: '',
              renewalRate: '',
              agreement: '',
              gimEnabled: false,
              gimNewRate: '',
              gimRenewalRate: '',
              gimAgreement: '',
            },
          ])
        }
      >
        Add rate period
      </Button>
      <p className="small muted">
        Both rates are percentages of agency commission received. Explicit 0% means no commission;
        blank is not zero. Salary remains in private pay settings.
      </p>
    </ActionForm>
  );
}
