import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { decimal, type CommissionPlan, type CommissionPlanDefinition } from '../../../shared/commissions';
import type { TeamEligibility } from '../lib/communications';
import { commissionAction } from '../lib/commissions';
import { isAuthorizationError } from '../lib/authorizationError';
import { useUnsavedChanges } from '../lib/editProtection';

type Actions = { refresh: () => Promise<void>; denied: (error: unknown) => void };
function Form({ children, label, save, refresh, denied }: Actions & { children: ReactNode; label: string; save: () => Promise<unknown> }) {
  const lock = useRef(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await save(); await refresh(); } catch (error) { setError(error instanceof Error ? error.message : 'Could not save commission settings.'); if (isAuthorizationError(error)) denied(error); }
    finally { lock.current = false; setBusy(false); }
  }
  return <form className="commission-setting-form" onSubmit={e => void submit(e)}><fieldset disabled={busy}><div className="commission-form-body">{children}</div><div className="form-actions"><button className="primary" type="submit">{busy ? 'Saving...' : label}</button></div></fieldset>{error && <p className="error-text" role="alert">{error}</p>}</form>;
}
function Input({ label, value, set, type = 'text', required = true }: { label: string; value: string; set: (value: string) => void; type?: string; required?: boolean }) {
  return <label className="field">{label}<input type={type} required={required} value={value} onChange={e => set(e.target.value)} /></label>;
}
export default function CommissionPlanSettings({ definitions, plans, team, ...actions }: Actions & { definitions: CommissionPlanDefinition[]; plans: CommissionPlan[]; team: TeamEligibility[] }) {
  const [definition, setDefinition] = useState(''), [producer, setProducer] = useState('');
  const chosen = definitions.find(d => d.id === definition), assigned = plans.find(p => p.producerId === producer);
  return <section className="commission-plan-settings" aria-label="Commission plans and assignments">
    <section className="card commission-setting-section">
    <h2>Commission plans</h2><p className="muted">Create a plan once, then assign it to producers. Saving new plan rates does not change existing assignments or earned commissions. Assign the new version with its own effective date when terms change.</p>
    <label className="field">Plan to configure<select value={definition} onChange={e => setDefinition(e.target.value)}><option value="">Create a new plan</option>{definitions.map(d => <option key={d.id} value={d.id}>{d.name} - version {d.version}{d.archived ? ' (archived)' : ''}</option>)}</select></label>
    <DefinitionForm key={`${definition}:${chosen?.version ?? 0}`} definition={chosen} {...actions} selected={setDefinition} />
    </section>
    <section className="card commission-setting-section">
    <h2 id="commission-plan-assignments">Producer plan assignments</h2><p className="muted">Only one plan may cover a producer on any date. End the previous assignment before starting another. New business uses its bind date; renewals use the policy effective date.</p>
    <p className="small muted">Missing an employee? <a href="/settings?tab=team">Manage team members</a>, then use Refresh team & carriers above. Each employee needs a CRM profile before appearing here.</p>
    <label className="field">Producer<select value={producer} onChange={e => setProducer(e.target.value)}><option value="">Choose a producer.</option>{team.map(t => <option key={t.userId} value={t.userId}>{t.name}</option>)}</select></label>
    {producer && <AssignmentForm key={`${producer}:${assigned?.version ?? 0}`} plan={assigned} producerId={producer} name={team.find(t => t.userId === producer)?.name ?? producer} definitions={definitions} {...actions} />}
    {!producer && <div className="commission-empty">Choose a producer to review or add dated plan assignments.</div>}
    </section>
  </section>;
}
function DefinitionForm({ definition: d, selected, ...actions }: Actions & { definition?: CommissionPlanDefinition; selected: (id: string) => void }) {
  const [id] = useState(() => d?.id ?? crypto.randomUUID());
  const initial = { name: d?.name ?? '', newRate: d ? String(d.newBps / 100) : '', renewalRate: d ? String(d.renewalBps / 100) : '', agreement: d?.agreement ?? '', gim: !!d?.gim, gimNew: d?.gim ? String(d.gim.newBps / 100) : '', gimRenewal: d?.gim ? String(d.gim.renewalBps / 100) : '', gimAgreement: d?.gim?.agreement ?? '', archived: d?.archived ?? false };
  const [draft, setDraft] = useState(initial), [saved, setSaved] = useState(false);
  const update = (patch: Partial<typeof draft>) => { setSaved(false); setDraft(v => ({ ...v, ...patch })); };
  useUnsavedChanges(!saved && JSON.stringify(initial) !== JSON.stringify(draft));
  return <Form {...actions} label="Save commission plan" save={async () => {
    const result = await commissionAction<{ id: string }>('saveCommissionPlan', { id, version: d?.version ?? 0, name: draft.name, newBps: decimal(draft.newRate), renewalBps: decimal(draft.renewalRate), agreement: draft.agreement, archived: draft.archived, ...(draft.gim ? { gim: { newBps: decimal(draft.gimNew), renewalBps: decimal(draft.gimRenewal), agreement: draft.gimAgreement } } : {}) });
    setSaved(true); selected(result.id);
  }}>
    <Input label="Plan name" value={draft.name} set={name => update({ name })} />
    <div className="form-grid"><Input label="Plan new business %" value={draft.newRate} set={newRate => update({ newRate })} /><Input label="Plan renewal %" value={draft.renewalRate} set={renewalRate => update({ renewalRate })} /></div>
    <Input label="Plan document reference" value={draft.agreement} set={agreement => update({ agreement })} />
    <label className="commission-check"><input type="checkbox" checked={draft.gim} onChange={e => update({ gim: e.target.checked })} /> Include GIM house-account rates</label>
    {draft.gim && <div className="form-grid"><Input label="Plan GIM new business %" value={draft.gimNew} set={gimNew => update({ gimNew })} /><Input label="Plan GIM renewal %" value={draft.gimRenewal} set={gimRenewal => update({ gimRenewal })} /><Input label="GIM plan document reference" value={draft.gimAgreement} set={gimAgreement => update({ gimAgreement })} /></div>}
    <p className="small muted">Rates apply to agency commission received. Explicit 0% is allowed; blank is not zero. A plan without GIM rates cannot be used to bind a GIM account.</p>
    {d && <label className="commission-check"><input type="checkbox" checked={draft.archived} onChange={e => update({ archived: e.target.checked })} /> Archive plan for new assignments (existing assignments remain valid)</label>}
  </Form>;
}
function AssignmentForm({ plan, producerId, name, definitions, ...actions }: Actions & { plan?: CommissionPlan; producerId: string; name: string; definitions: CommissionPlanDefinition[] }) {
  const blank = () => ({ id: crypto.randomUUID() as string, planId: '', planVersion: 0, from: '', to: '', agreement: '', accountBoundFrom: '', receiptsFrom: '', notes: '' });
  const [initial] = useState(() => plan?.terms.map((t, i) => ({ id: t.assignment?.id ?? `legacy:${i}`, planId: t.assignment?.planId ?? '', planVersion: t.assignment?.planVersion ?? 0, from: t.from, to: t.to ?? '', agreement: t.agreement, accountBoundFrom: t.accountBoundFrom ?? plan.accountBoundFrom ?? '', receiptsFrom: t.receiptsFrom ?? plan.receiptsFrom ?? '', notes: t.assignment?.notes ?? '' })) ?? [blank()]);
  const [rows, setRows] = useState(initial), [saved, setSaved] = useState(false);
  useUnsavedChanges(!saved && JSON.stringify(rows) !== JSON.stringify(initial));
  const update = (index: number, patch: Partial<typeof rows[number]>) => { setSaved(false); setRows(all => all.map((r, i) => i === index ? { ...r, ...patch } : r)); };
  return <Form {...actions} label="Save producer assignments" save={async () => { await commissionAction('savePlanAssignments', { producerId, name, version: plan?.version ?? 0, assignments: rows }); setSaved(true); }}>
    {rows.map((row, i) => {
      const prior = plan?.terms.find((t, index) => (t.assignment?.id ?? `legacy:${index}`) === row.id);
      const choices = definitions.filter(d => !d.archived).map(d => ({ key: `${d.id}:${d.version}`, id: d.id, version: d.version, name: `${d.name} - v${d.version} (${d.newBps / 100}% new / ${d.renewalBps / 100}% renewal)` }));
      if (prior?.assignment && !choices.some(c => c.id === prior.assignment!.planId && c.version === prior.assignment!.planVersion)) choices.push({ key: `${prior.assignment.planId}:${prior.assignment.planVersion}`, id: prior.assignment.planId, version: prior.assignment.planVersion, name: `${prior.assignment.planName} - v${prior.assignment.planVersion} (assigned version)` });
      return <section className="commission-period" key={row.id}><h3>Assignment {i + 1}</h3>
        <label className="field">Commission plan {i + 1}<select required={!prior || !!prior.assignment} value={row.planId ? `${row.planId}:${row.planVersion}` : ''} onChange={e => { const option = choices.find(c => c.key === e.target.value); update(i, { planId: option?.id ?? '', planVersion: option?.version ?? 0 }); }}><option value="">{prior && !prior.assignment ? `Existing individual agreement (${prior.newBps / 100}% / ${prior.renewalBps / 100}%)` : 'Choose a plan'}</option>{choices.map(c => <option key={c.key} value={c.key}>{c.name}</option>)}</select></label>
        <div className="form-grid"><Input label={`Assignment starts ${i + 1}`} type="date" value={row.from} set={from => update(i, { from })} /><Input label={`Assignment ends ${i + 1} (optional)`} type="date" required={false} value={row.to} set={to => update(i, { to })} /></div>
        <Input label={`Employee agreement reference ${i + 1}`} value={row.agreement} set={agreement => update(i, { agreement })} />
        <div className="form-grid"><Input label={`Account first-bind cutoff ${i + 1} (optional)`} type="date" required={false} value={row.accountBoundFrom} set={accountBoundFrom => update(i, { accountBoundFrom })} /><Input label={`Receipt eligibility begins ${i + 1} (optional)`} type="date" required={false} value={row.receiptsFrom} set={receiptsFrom => update(i, { receiptsFrom })} /></div>
        {!!row.planId && <Input label={`Assignment notes ${i + 1} (optional)`} required={false} value={row.notes} set={notes => update(i, { notes })} />}
        <button type="button" className="secondary" disabled={rows.length === 1} onClick={() => { setSaved(false); setRows(all => all.filter((_, j) => j !== i)); }}>Remove assignment {i + 1}</button>
      </section>;
    })}
    <button type="button" className="secondary" disabled={rows.length >= 100} onClick={() => { setSaved(false); setRows(all => [...all, blank()]); }}>Add dated assignment</button>
    <p className="small muted">Dates include both endpoints. A first-bind cutoff excludes accounts originally bound before that date, including later renewals. Settings are frozen with each policy and never rewrite prior earnings.</p>
  </Form>;
}
