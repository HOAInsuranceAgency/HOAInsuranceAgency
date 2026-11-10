import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { decimal, type CommissionPlan, type CommissionPlanDefinition } from '../../../shared/commissions';
import type { TeamEligibility } from '../lib/communications';
import { commissionAction } from '../lib/commissions';
import { isAuthorizationError } from '../lib/authorizationError';
import CommissionPanel from './CommissionPanel';
import { useUnsavedChanges } from '../lib/editProtection';

type Actions = { refresh: () => Promise<void>; denied: (error: unknown) => void; dirty?: (dirty: boolean) => void };
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
const dateSpan = (from: string, to?: string) => from + (to ? ' – ' + to : ' onward');
const effectiveToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export default function CommissionPlanSettings({ definitions, plans, team, ...actions }: Actions & { definitions: CommissionPlanDefinition[]; plans: CommissionPlan[]; team: TeamEligibility[] }) {
  const [definition, setDefinition] = useState<string | null>(null), [producer, setProducer] = useState<string | null>(null);
  const [definitionDirty, setDefinitionDirty] = useState(false), [assignmentDirty, setAssignmentDirty] = useState(false);
  const chosen = definitions.find(d => d.id === definition), assigned = plans.find(p => p.producerId === producer);
  const editPlan = (id: string | null) => { if (id === definition) return; if (!definitionDirty || window.confirm('Discard the unsaved plan changes?')) { setDefinitionDirty(false); setDefinition(id); } };
  const editEmployee = (id: string | null) => { if (id === producer) return; if (!assignmentDirty || window.confirm('Discard the unsaved assignment changes?')) { setAssignmentDirty(false); setProducer(id); } };
  const people = [...team, ...plans.filter(p => !team.some(t => t.userId === p.producerId)).map(p => ({ userId: p.producerId, name: p.name }))];
  const now = effectiveToday();
  return <section className="commission-plan-settings" aria-label="Commission plans and assignments">
    <section className="card commission-setting-section">
      <div className="commission-section-heading"><div><h2>Commission plans</h2><p>Rates apply to agency commission received. Create a plan only when the rates differ.</p></div><button type="button" className="secondary" onClick={() => editPlan('')}>Add plan</button></div>
      {definitions.length ? <div className="commission-scroll"><table aria-label="Saved commission plans"><thead><tr><th>Plan</th><th>New / renewal</th><th>GIM new / renewal</th><th>Reference</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
        {definitions.map(d => <tr key={d.id}><td><strong>{d.name}</strong><span className="commission-row-note">Version {d.version}{d.archived ? ' · Archived' : ''}</span></td><td>{d.newBps / 100}% / {d.renewalBps / 100}%</td><td>{d.gim ? d.gim.newBps / 100 + '% / ' + d.gim.renewalBps / 100 + '%' : 'Not configured'}</td><td><Reference value={d.agreement} /></td><td><button className="secondary" type="button" aria-label={'Edit plan ' + d.name} onClick={() => editPlan(d.id)}>Edit</button></td></tr>)}
      </tbody></table></div> : <p className="commission-compact-empty">No plans saved. Add one before assigning an employee.</p>}
      {definition !== null && <div className="commission-inline-editor"><div className="commission-section-heading"><h3>{chosen ? 'Edit ' + chosen.name : 'New commission plan'}</h3><button type="button" className="secondary" onClick={() => editPlan(null)}>Close plan editor</button></div>
        <p className="small muted">Changes create a new plan version. Existing assignments keep their saved rates.</p>
        <DefinitionForm key={definition + ':' + (chosen?.version ?? 0)} definition={chosen} {...actions} dirty={setDefinitionDirty} selected={setDefinition} />
      </div>}
    </section>
    <section className="card commission-setting-section" id="commission-plan-assignments">
      <div className="commission-section-heading"><div><h2>Employee assignments</h2><p>Assign only employees who earn commission. Dates below show every saved assignment.</p></div><a className="commission-management-link" href="/settings?tab=team">Manage team</a></div>
      <div className="commission-scroll"><table aria-label="Saved employee assignments"><thead><tr><th>Employee</th><th>Plan / rates</th><th>Effective dates</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
        {people.map(person => {
          const record = plans.find(p => p.producerId === person.userId);
          return <tr key={person.userId}><td><strong>{person.name}</strong></td><td>{record?.terms.length ? record.terms.map((t, i) => <div className="commission-summary-period" key={t.assignment?.id ?? i}><strong>{t.assignment?.planName ?? 'Individual agreement'}</strong><span className="commission-row-note">{t.newBps / 100}% new · {t.renewalBps / 100}% renewal{t.gim ? ' · GIM ' + t.gim.newBps / 100 + '% / ' + t.gim.renewalBps / 100 + '%' : ''}</span><Reference value={t.agreement} /></div>) : <span className="muted">No plan assigned</span>}</td><td>{record?.terms.map((t, i) => <div className="commission-summary-period" key={i}><span>{dateSpan(t.from, t.to)}</span><span className="commission-row-note">{t.from > now ? 'Upcoming' : t.to && t.to < now ? 'Ended' : 'Current'}{(t.accountBoundFrom ?? record.accountBoundFrom) ? ' · First bind from ' + (t.accountBoundFrom ?? record.accountBoundFrom) : ''}{(t.receiptsFrom ?? record.receiptsFrom) ? ' · Receipts from ' + (t.receiptsFrom ?? record.receiptsFrom) : ''}</span></div>) ?? '—'}</td><td><button className="secondary" type="button" aria-label={(record ? 'Edit assignment for ' : 'Assign plan to ') + person.name} onClick={() => editEmployee(person.userId)}>{record ? 'Edit' : 'Assign plan'}</button></td></tr>;
        })}
      </tbody></table></div>
      {!people.length && <p className="commission-compact-empty">Add the employee in Team, then refresh this page.</p>}
      {producer !== null && <div className="commission-inline-editor"><div className="commission-section-heading"><h3>{people.find(t => t.userId === producer)?.name ?? producer} · assignments</h3><button className="secondary" type="button" onClick={() => editEmployee(null)}>Close assignment editor</button></div>
        <AssignmentForm key={producer + ':' + (assigned?.version ?? 0)} plan={assigned} producerId={producer} name={people.find(t => t.userId === producer)?.name ?? producer} definitions={definitions} {...actions} dirty={setAssignmentDirty} />
      </div>}
    </section>
  </section>;
}
function Reference({ value }: { value: string }) {
  return /^https?:\/\//i.test(value) ? <a href={value} target="_blank" rel="noreferrer">View agreement</a> : <span className="commission-row-note">{value}</span>;
}
function DefinitionForm({ definition: d, selected, ...actions }: Actions & { definition?: CommissionPlanDefinition; selected: (id: string) => void }) {
  const [id] = useState(() => d?.id ?? crypto.randomUUID());
  const initial = { name: d?.name ?? '', newRate: d ? String(d.newBps / 100) : '', renewalRate: d ? String(d.renewalBps / 100) : '', agreement: d?.agreement ?? '', gim: !!d?.gim, gimNew: d?.gim ? String(d.gim.newBps / 100) : '', gimRenewal: d?.gim ? String(d.gim.renewalBps / 100) : '', gimAgreement: d?.gim?.agreement ?? '', archived: d?.archived ?? false };
  const [draft, setDraft] = useState(initial), [saved, setSaved] = useState(false);
  const update = (patch: Partial<typeof draft>) => { setSaved(false); setDraft(v => ({ ...v, ...patch })); };
  const changed = !saved && JSON.stringify(initial) !== JSON.stringify(draft);
  useUnsavedChanges(changed);
  useEffect(() => { actions.dirty?.(changed); }, [changed, actions.dirty]);
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
  const changed = !saved && JSON.stringify(rows) !== JSON.stringify(initial);
  useUnsavedChanges(changed);
  useEffect(() => { actions.dirty?.(changed); }, [changed, actions.dirty]);
  const update = (index: number, patch: Partial<typeof rows[number]>) => { setSaved(false); setRows(all => all.map((r, i) => i === index ? { ...r, ...patch } : r)); };
  return <Form {...actions} label="Save producer assignments" save={async () => { await commissionAction('savePlanAssignments', { producerId, name, version: plan?.version ?? 0, assignments: rows }); setSaved(true); }}>
    {rows.map((row, i) => {
      const prior = plan?.terms.find((t, index) => (t.assignment?.id ?? `legacy:${index}`) === row.id);
      const choices = definitions.filter(d => !d.archived).map(d => ({ key: `${d.id}:${d.version}`, id: d.id, version: d.version, name: `${d.name} - v${d.version} (${d.newBps / 100}% new / ${d.renewalBps / 100}% renewal)` }));
      if (prior?.assignment && !choices.some(c => c.id === prior.assignment!.planId && c.version === prior.assignment!.planVersion)) choices.push({ key: `${prior.assignment.planId}:${prior.assignment.planVersion}`, id: prior.assignment.planId, version: prior.assignment.planVersion, name: `${prior.assignment.planName} - v${prior.assignment.planVersion} (assigned version)` });
      return <section className="commission-period" key={row.id}><h3>Assignment {i + 1}</h3>
        <label className="field">Commission plan {i + 1}<select required={!prior || !!prior.assignment} value={row.planId ? `${row.planId}:${row.planVersion}` : ''} onChange={e => { const option = choices.find(c => c.key === e.target.value); const next = definitions.find(d => d.id === option?.id); const old = definitions.find(d => d.id === row.planId); update(i, { planId: option?.id ?? '', planVersion: option?.version ?? 0, ...(!row.agreement || row.agreement === old?.agreement ? { agreement: next?.agreement ?? '' } : {}) }); }}><option value="">{prior && !prior.assignment ? `Existing individual agreement (${prior.newBps / 100}% / ${prior.renewalBps / 100}%)` : 'Choose a plan'}</option>{choices.map(c => <option key={c.key} value={c.key}>{c.name}</option>)}</select></label>
        <Input label={`Assignment starts ${i + 1}`} type="date" value={row.from} set={from => update(i, { from })} />
        <Input label={`Employee agreement reference ${i + 1}`} value={row.agreement} set={agreement => update(i, { agreement })} />
        <p className="small muted">The selected plan supplies its reference. Replace it above if the employee has a separate signed agreement.</p>
        <CommissionPanel title="Eligibility limits and end date (optional)" open={!!(row.to || row.accountBoundFrom || row.receiptsFrom || row.notes)}>
        <p className="small muted">Leave these blank unless the employee agreement limits eligible accounts or receipts.</p>
        <Input label={`Assignment ends ${i + 1} (optional)`} type="date" required={false} value={row.to} set={to => update(i, { to })} />
        <div className="form-grid"><Input label={`Account first-bind cutoff ${i + 1} (optional)`} type="date" required={false} value={row.accountBoundFrom} set={accountBoundFrom => update(i, { accountBoundFrom })} /><Input label={`Receipt eligibility begins ${i + 1} (optional)`} type="date" required={false} value={row.receiptsFrom} set={receiptsFrom => update(i, { receiptsFrom })} /></div>
        {!!row.planId && <Input label={`Assignment notes ${i + 1} (optional)`} required={false} value={row.notes} set={notes => update(i, { notes })} />}
        </CommissionPanel>
        <button type="button" className="secondary" disabled={rows.length === 1} onClick={() => { setSaved(false); setRows(all => all.filter((_, j) => j !== i)); }}>Remove assignment {i + 1}</button>
      </section>;
    })}
    <button type="button" className="secondary" disabled={rows.length >= 100} onClick={() => { setSaved(false); setRows(all => [...all, blank()]); }}>Add dated assignment</button>
    <p className="small muted">Dates include both endpoints. A first-bind cutoff excludes accounts originally bound before that date, including later renewals. Settings are frozen with each policy and never rewrite prior earnings.</p>
  </Form>;
}
