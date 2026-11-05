import { assertGraphqlErrors } from '../lib/apiResponse';
import { Button } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { loadPartyIds } from '../lib/relationships';
import PartyPicker from "../components/PartyPicker";
import { RELATIONSHIP_LABELS, RELATIONSHIP_ROLES, type RelationshipRole } from "../../../shared/relationships";
import { LEAD_SOURCES, LEAD_SOURCE_LABELS } from "../../../shared/leadSource";
import { PROPERTY_TYPES, PROPERTY_TYPE_LABELS, normalizePropertyType, accountPropertyType } from "../../../shared/propertyType";
import { communicationRequest } from "../lib/communications";
import { ResponsibilitySelect } from "../components/LeadWorkflowPanel";
import { isAssignableSalesperson } from "../../../shared/salespersonOwnership";
import { useAsyncResource } from "../lib/useAsyncResource";
import { useState, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { uploadData } from "../lib/scopedStorage";
import {
  client,
  friendlyError,
  US_STATES,
  validateAccountFields,
  type Contact,
} from "../lib/client";
import { AddressAutocomplete } from "../lib/googlePlaces";
import FileButton from "../components/FileButton";
import {
  DateInput,
  IntegerInput,
  MoneyInput,
  PhoneInput,
} from "../components/inputs";
import { useFormState } from "../lib/useFormState";
import { useEditProtection, useUnsavedChanges } from "../lib/editProtection";
import { useNewLeadDraft } from "../lib/newLeadDraft";
import { str } from "../lib/formCodec";
import { contactKey } from "../../../shared/extractionKeys";
import {
  ACCOUNT_TYPE_OPTIONS,
  CONTACT_TYPE_OPTIONS,
  DEFAULT_ACCOUNT_TYPE,
  type AccountType,
} from "../../../shared/enums";
import "./NewLead.css";

const PRIMARY_TEXT_LIMITS = [
  ["name", "Name", 200, "new-lead-name"],
  ["address", "Street address", 500, "new-lead-address"],
  ["city", "City", 500, "new-lead-city"],
  ["state", "State", 500, "new-lead-state"],
  ["zip", "ZIP", 500, "new-lead-zip"],
  ["currentAgent", "Current agent / broker", 500, "new-lead-current-agent"],
  ["currentPolicyExpiration", "Current policy expiration", 500, "new-lead-expiration"],
  ["notes", "Notes", 10000, "new-lead-notes"],
] as const;

export default function NewLead() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [relatedParty, setRelatedParty] = useState(searchParams.get('relatedParty') ?? '');
  const initialRelatedParty = useRef(relatedParty);
  const [relationshipRole, setRelationshipRole] = useState<RelationshipRole>('MANAGER');
  const formRef = useRef<HTMLFormElement>(null);
  const requestId = useRef<string>(crypto.randomUUID());
  const attempted = useRef(false);
  const savingNow = useRef(false);
  const created = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [salespersonId, setSalesperson] = useState("");
  const initialSalesperson = useRef("");
  const salespersonEdited = useRef(false);
  const members = useAsyncResource(() => communicationRequest("team"), [], { initialData: { team: [] } , live: true });
  useEffect(() => {
    const self = members.data.team.find(t => t.userId === members.data.actorId && isAssignableSalesperson(t));
    if (self && !salespersonEdited.current) { initialSalesperson.current = self.userId; setSalesperson(s => s || self.userId); }
  }, [members.data]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  // Set once the lead exists — pressing Create again would duplicate it.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [needsReview, setNeedsReview] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const { cancelPending } = useEditProtection();
  const [recovered, setRecovered] = useState(false);
  const { form, setF, patch, dirty, reset } = useFormState({
    type: DEFAULT_ACCOUNT_TYPE as string,
    propertyType: "",
    name: "",
    contactName: "",
    contactType: "",
    contactEmail: "",
    contactPhone: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    unitCount: "",
    totalInsuredValue: "",
    currentAgent: "",
    currentPolicyExpiration: "",
    leadSource: "",
    notes: "",
  });
  const extraDirty = relatedParty !== initialRelatedParty.current || relationshipRole !== "MANAGER" ||
    salespersonEdited.current && salespersonId !== initialSalesperson.current;
  const draft = useNewLeadDraft(form, requestId.current, stagedFiles.length, reconciling || (dirty || stagedFiles.length > 0) && !created.current);
  const { markClean, isLeaving } = useUnsavedChanges(saving || needsReview || (!created.current && (dirty || extraDirty || stagedFiles.length > 0)), {
    busy: saving,
    notice: needsReview ? error : undefined,
    continueLabel: reconciling ? "Discard these draft details and continue" : undefined,
    onReview: () => reviewCreatedLead(),
    onDiscard: () => {
      setNeedsReview(false);
      if (reconciling) { setReconciling(false); draft.clear(); }
      if (created.current) return;
      reset(); setStagedFiles([]); setRelatedParty(initialRelatedParty.current);
      setRelationshipRole("MANAGER"); setSalesperson(initialSalesperson.current);
      salespersonEdited.current = false; setRecovered(false); draft.clear();
    },
  });
  function reviewCreatedLead() {
    const id = created.current;
    if (!id) return;
    if (reconciling) {
      // Keep this tab's latest draft visible while the saved record is reviewed.
      cancelPending();
      window.open(`/accounts/${encodeURIComponent(id)}?tab=overview`, "_blank", "noopener,noreferrer");
      return;
    }
    cancelPending(); setNeedsReview(false); markClean();
    navigate(relatedParty && relationshipRole === 'MANAGER' ? `/accounts/${id}?management=1&partyId=${encodeURIComponent(relatedParty)}` : `/accounts/${id}?tab=documents`);
  }

  function focusField(id: string) {
    const field = formRef.current?.querySelector<HTMLElement>(`#${id}`);
    const input = field?.matches('input, select, textarea') ? field : field?.querySelector<HTMLElement>('input, select, textarea');
    const section = (input ?? field)?.closest('details');
    if (section) section.open = true;
    input?.focus();
  }

  async function save() {
    if (savingNow.current || created.current) return;
    if (!form.name.trim()) {
      setError("Name is required.");
      focusField('new-lead-name');
      return;
    }
    const tooLong = PRIMARY_TEXT_LIMITS.find(([key, , limit]) => form[key].trim().length > limit);
    if (tooLong) {
      const [, label, limit, id] = tooLong;
      setError(`${label} must be ${limit.toLocaleString("en-US")} characters or fewer.`);
      focusField(id);
      return;
    }
    const problems = validateAccountFields(form);
    if (problems.length) {
      setError(problems.join(" "));
      const invalid = ([
        ['contactEmail', 'new-lead-contact-email'], ['zip', 'new-lead-zip'],
        ['unitCount', 'new-lead-unit-count'], ['totalInsuredValue', 'new-lead-tiv'],
      ] as const).find(([key]) => validateAccountFields({ [key]: form[key] }).length > 0);
      if (invalid) focusField(invalid[1]);
      return;
    }
    if (!form.leadSource) { setError("Choose a lead source before creating the lead."); focusField('new-lead-source'); return; }
    savingNow.current = true;
    setSaving(true);
    setError("");
    if (relatedParty) { try { const selected = await loadPartyIds([relatedParty]); if (!selected.some(p => p.id === relatedParty && !p.archived)) throw new Error('Choose an active relationship.'); } catch { setError('Refresh and choose an active relationship before creating this lead.'); savingNow.current = false; setSaving(false); return; } }
    let data: { id: string } | null = null;
    let errors: { message: string }[] = [];
    const fields = {
      stage: "LEAD", type: form.type as AccountType,
      propertyType: normalizePropertyType(form.propertyType) ?? undefined,
      name: form.name.trim(), address: form.address.trim() || undefined, city: form.city.trim() || undefined,
      state: form.state || undefined, zip: form.zip.trim() || undefined,
      unitCount: form.unitCount ? Number(form.unitCount) : undefined,
      totalInsuredValue: form.totalInsuredValue ? Number(form.totalInsuredValue) : undefined,
      currentAgent: form.currentAgent.trim() || undefined, currentPolicyExpiration: form.currentPolicyExpiration || undefined,
      leadSource: form.leadSource, notes: form.notes.trim() || undefined,
    };
    const uncertainAttempt = attempted.current;
    attempted.current = true;
    draft.markAttempted();
    try {
      data = await communicationRequest("createLead", {
        requestId: requestId.current, salespersonId: salespersonId || undefined,
        fields,
      }, true);
    } catch (e) { errors = [{ message: e instanceof Error ? e.message : "Could not create lead" }]; }
    if (errors?.length || !data) {
      savingNow.current = false;
      setSaving(false);
      setError(friendlyError(errors?.[0]?.message, "Failed to create lead."));
      return;
    }
    if (!mounted.current) return;
    created.current = data.id;
    setReconciling(true);
    draft.rememberCreated(data.id);
    // A replay returns the original ID without applying later edits. Confirm
    // fresh fields before secondary writes; an uncertain attempt needs explicit
    // reconciliation even if the account happens to match its old draft.
    let confirmed = false;
    try {
      const [saved, context] = await Promise.all([
        client.models.Account.get({ id: data.id }),
        salespersonId ? communicationRequest("context", { accountId: data.id }) : Promise.resolve(null),
      ]);
      const expected = { ...fields, propertyType: accountPropertyType(fields) };
      const account = saved.data as Record<string, unknown> | null;
      const valuesMatch = account && !saved.errors?.length && Object.entries(expected).every(([key, value]) => {
        const actual = account[key];
        return value == null ? actual == null || actual === "" : actual === value;
      });
      confirmed = !!valuesMatch && (!salespersonId || context?.workflow?.salespersonId === salespersonId);
    } catch { /* An unconfirmed save must not clear or overwrite a later draft. */ }
    if (!mounted.current) return;
    if (uncertainAttempt || !confirmed) {
      savingNow.current = false;
      if (!mounted.current) return;
      setCreatedId(data.id); setNeedsReview(true); setSaving(false);
      setError("The lead exists, but these latest draft details have not been confirmed as saved. No contacts, relationships or files were added by this attempt. Review the saved lead in a separate tab and reconcile these details there. This tab keeps your recoverable basic details until you explicitly discard the draft; notes, financial values and files are not backed up.");
      return;
    }
    setReconciling(false);
    draft.clear();

    // The primary contact, as a row rather than four columns on the Account.
    // Not fatal, for the same reason it isn't in `lead-intake`: the lead
    // exists and its documents are about to upload, so failing the whole
    // creation over one contact row would lose more than it saved. The
    // producer is told, and the Contacts card is one click away.
    let contactFailed = false;
    if (form.contactName.trim() || form.contactEmail.trim() || form.contactPhone.trim()) {
      const contact = {
        name: str(form.contactName) ?? form.name.trim(),
        type: (str(form.contactType) ?? undefined) as Contact["type"],
        email: str(form.contactEmail),
        phone: str(form.contactPhone),
      };
      try {
        const { errors: contactErrors } = await client.models.Contact.create({
          accountId: data.id,
          ...contact,
          isPrimary: true,
          extractionSourceKey: contactKey(contact),
        });
        contactFailed = Boolean(contactErrors?.length);
      } catch { contactFailed = true; }
    }
    if (!mounted.current) return;

    let relationshipFailed = false;
    if (relatedParty && relationshipRole !== 'MANAGER') {
      try { await communicationRequest('relationshipLink', { accountId: data.id, partyId: relatedParty, role: relationshipRole, requestId: requestId.current }, true); }
      catch { relationshipFailed = true; }
    }
    if (!mounted.current) return;

    // Upload any staged documents to the new account so OCR + AI extraction
    // are ready when they land on the Documents tab.
    const failedUploads: string[] = [];
    for (const file of stagedFiles) {
      if (!mounted.current) return;
      try {
        const { data: doc } = await client.models.Document.create({
          entityType: "ACCOUNT",
          entityId: data.id,
          category: "OTHER",
          name: file.name,
          s3Key: "pending",
          contentType: file.type,
          sizeBytes: file.size,
          ocrStatus: "PENDING",
        });
        if (!mounted.current) return;
        if (!doc) {
          failedUploads.push(file.name);
          continue;
        }
        const path = `documents/ACCOUNT/${data.id}/${doc.id}/${file.name}`;
        const updated = await client.models.Document.update({ id: doc.id, s3Key: path });
        if (!mounted.current) return;
        assertGraphqlErrors(updated);
        await uploadData({
          path,
          data: file,
          options: { contentType: file.type || undefined },
        }).result;
      } catch {
        // A failed upload shouldn't block lead creation, but navigating away
        // without saying so loses the attachment silently.
        failedUploads.push(file.name);
      }
    }

    savingNow.current = false;
    if (!mounted.current) return;
    const afterCreate: string[] = [];
    if (failedUploads.length) {
      const many = failedUploads.length > 1;
      afterCreate.push(
        `${failedUploads.length} document${many ? "s" : ""} didn't upload: ` +
          `${failedUploads.join(", ")}. Open the lead and add ${many ? "them" : "it"} from the Documents tab.`
      );
    }
    if (contactFailed) {
      afterCreate.push(
        "the contact wasn't saved. Open the lead and add it from the Contacts card."
      );
    }
    if (relationshipFailed) afterCreate.push("the relationship wasn't linked. Open the lead and use Link relationship to retry.");
    if (afterCreate.length) {
      setCreatedId(data.id);
      setNeedsReview(true);
      setError(`The lead was created, but ${afterCreate.join(" Also, ")}`);
      setSaving(false);
      return;
    }
    setSaving(false);
    markClean();
    // Land on Documents so OCR completes and AI extraction is the next step.
    if (isLeaving()) return;
    navigate(relatedParty && relationshipRole === 'MANAGER'
      ? `/accounts/${data.id}?management=1&partyId=${encodeURIComponent(relatedParty)}`
      : `/accounts/${data.id}?tab=documents`);
  }

  const isPersonal = form.type === "PERSONAL";
  const propertySummary = [
    [form.city, form.state].filter(Boolean).join(", ") || (form.address ? "Address added" : ""),
    form.unitCount && !isPersonal ? `${form.unitCount} units` : "",
    form.currentPolicyExpiration ? "Renewal date added" : "",
  ].filter(Boolean).join(" · ");
  const extrasSummary = [
    form.notes.trim() ? "Notes added" : "",
    stagedFiles.length ? `${stagedFiles.length} document${stagedFiles.length > 1 ? "s" : ""}` : "",
  ].filter(Boolean).join(" · ");

  return (
    <div className="new-lead">
      <Button type="button" variant="link" className="new-lead-back" disabled={saving} onClick={() => navigate('/leads')}>
        <span aria-hidden="true">←</span> Leads
      </Button>
      <header className="new-lead-heading">
        <h1>New lead</h1>
        <p>Add the basics now. You can fill in the rest later.</p>
      </header>

      {draft.available && <section className="card" aria-label="Unfinished lead">
        <p>An unfinished lead was saved in this tab. Recover its basic details or discard it to start fresh.</p>
        <p className="muted small">Salesperson and relationship selections, notes, financial values and documents are not backed up. Review the selections, re-enter the missing details and reattach any files.</p>
        <div className="form-actions">
          <Button variant="secondary" type="button"  onClick={() => {
            const snapshot = draft.available!;
            requestId.current = snapshot.requestId;
            attempted.current = snapshot.attempted;
            patch(snapshot.fields); setRecovered(true);
            if (snapshot.existingId) {
              created.current = snapshot.existingId; setCreatedId(snapshot.existingId);
              setReconciling(true); setNeedsReview(true);
              setError("A lead already exists for this draft. These recovered basic details still need to be compared with the saved lead. Review it in a separate tab, reconcile any differences there, then explicitly discard this draft. Notes, financial values and files were not backed up.");
            }
            draft.recovered();
          }}>Recover lead details</Button>
          <Button variant="secondary" type="button"  onClick={draft.clear}>Discard saved draft</Button>
        </div>
      </section>}
      {recovered && <p role="status" className="muted small">Basic details recovered. Review salesperson and relationship selections, re-enter notes and financial values, and reattach documents before creating the lead.</p>}
      {draft.scoped && dirty && !draft.available && (!created.current || reconciling) && <p role="status" className="muted small">{draft.unavailable
        ? "Your latest details could not be backed up. Keep this tab open until you create or reconcile the lead. Any earlier backup contains only its last saved details."
        : draft.backedUp ? "Basic details are backed up in this tab. Salesperson and relationship selections, notes, financial values and files are not backed up." : "Backing up basic details in this tab…"}</p>}

      <form ref={formRef} className="card new-lead-form" aria-label="New lead" noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset className="new-lead-fields" disabled={saving || !!createdId || !!draft.available} aria-label="Lead information">
          <details className="new-lead-section" open={!!relatedParty}>
            <summary>Related person or organization {relatedParty ? '· Selected' : '(optional)'}</summary>
            <PartyPicker label="Relationship" value={relatedParty} onChange={setRelatedParty} emptyLabel="No relationship selected" />
            {relatedParty && <><label className="field">Role<Select value={relationshipRole} onChange={e => setRelationshipRole(e.target.value as RelationshipRole)}>{RELATIONSHIP_ROLES.map(r => <option key={r} value={r}>{RELATIONSHIP_LABELS[r]}</option>)}</Select></label>{relationshipRole === 'MANAGER' && <p className="muted small">After creating the lead, review the effective date and management contacts.</p>}</>}
          </details>
          <div className="new-lead-essentials">
            <section className="new-lead-section" aria-labelledby="new-lead-details-heading">
              <h2 id="new-lead-details-heading">Lead details</h2>
              <div className="new-lead-grid">
                <div className="field full">
                  <label htmlFor="new-lead-name">Name (association / insured) *</label>
                  <Input id="new-lead-name" required placeholder={isPersonal ? "Insured's full name" : "Association or business name"} value={form.name} onChange={e => setF("name", e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="new-lead-account-type">Account type</label>
                  <Select id="new-lead-account-type" value={form.type} onChange={e => setF("type", e.target.value)}>
                    {ACCOUNT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                </div>
                <div className="field">
                  <label htmlFor="new-lead-property-type">Property type</label>
                  <Select id="new-lead-property-type" value={form.propertyType} onChange={e => setF("propertyType", e.target.value)}>
                    <option value="">Choose if confirmed</option>
                    {PROPERTY_TYPES.map(value => <option key={value} value={value}>{PROPERTY_TYPE_LABELS[value]}</option>)}
                  </Select>
                  {isPersonal && <span className="new-lead-hint">Personal (HO-6) accounts use Individual unit owner unless you choose another property type.</span>}
                </div>
                <div className="field">
                  <label htmlFor="new-lead-source">Lead source *</label>
                  <Select id="new-lead-source" required value={form.leadSource} onChange={e => setF("leadSource", e.target.value)}>
                    <option value="">Choose a source</option>
                    {LEAD_SOURCES.map(value => <option key={value} value={value}>{LEAD_SOURCE_LABELS[value]}</option>)}
                  </Select>
                </div>
                <ResponsibilitySelect label="Salesperson" value={salespersonId} team={members.data.team} onChange={id => { salespersonEdited.current = true; setSalesperson(id); }} disabled={saving || members.loading} />
              </div>
              {members.error && <p className="error-text small" role="alert">{members.error} <Button variant="link" type="button"  onClick={() => void members.refetch()}>Retry</Button></p>}
            </section>

            <section className="new-lead-section new-lead-contact" aria-labelledby="new-lead-contact-heading">
              <div className="new-lead-section-heading"><h2 id="new-lead-contact-heading">Primary contact</h2><span className="new-lead-optional">Optional</span></div>
              <div className="new-lead-grid">
                <div className="field">
                  <label htmlFor="new-lead-contact-name">Contact name</label>
                  <Input id="new-lead-contact-name" autoComplete="name" placeholder="Full name" value={form.contactName} onChange={e => setF("contactName", e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="new-lead-contact-role">Contact role</label>
                  <Select id="new-lead-contact-role" value={form.contactType} onChange={e => setF("contactType", e.target.value)}>
                    <option value="">Choose a role</option>
                    {CONTACT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                </div>
                <div className="field full">
                  <label htmlFor="new-lead-contact-email">Contact email</label>
                  <Input id="new-lead-contact-email" type="email" autoComplete="email" placeholder="name@example.com" value={form.contactEmail} onChange={e => setF("contactEmail", e.target.value)} />
                </div>
                <div className="field full">
                  <label htmlFor="new-lead-contact-phone">Contact phone</label>
                  <PhoneInput id="new-lead-contact-phone" placeholder="(555) 123-4567" value={form.contactPhone} onChange={value => setF("contactPhone", value)} />
                </div>
              </div>
            </section>
          </div>

          <details className="new-lead-disclosure">
            <summary><span className="new-lead-disclosure-copy"><span className="new-lead-disclosure-title">Property & current coverage</span><span className="new-lead-hint">{propertySummary || "Address, units, insured value and renewal details"}</span></span><span className="new-lead-optional">Optional</span></summary>
            <div className="new-lead-disclosure-body">
              <div className="new-lead-grid new-lead-property-grid">
                <label id="new-lead-address" className="field new-lead-address-field" onKeyDown={event => {
                  // Enter selects a Places suggestion; it must not create the lead.
                  if (event.key === 'Enter') event.preventDefault();
                }}>
                  <span>Street address</span>
                  <AddressAutocomplete value={form.address} onChange={value => setF("address", value)} onPlace={place => patch(current => ({ address: place.address || current.address, city: place.city || current.city, state: place.state || current.state, zip: place.zip || current.zip }))} />
                </label>
                <div className="field">
                  <label htmlFor="new-lead-city">City</label>
                  <Input id="new-lead-city" autoComplete="address-level2" value={form.city} onChange={e => setF("city", e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="new-lead-state">State</label>
                  <Select id="new-lead-state" autoComplete="address-level1" value={form.state} onChange={e => setF("state", e.target.value)}>
                    <option value="">—</option>{US_STATES.map(state => <option key={state}>{state}</option>)}
                  </Select>
                </div>
                <div className="field">
                  <label htmlFor="new-lead-zip">ZIP</label>
                  <Input id="new-lead-zip" autoComplete="postal-code" inputMode="numeric" value={form.zip} onChange={e => setF("zip", e.target.value)} />
                </div>
              </div>
              <div className="new-lead-grid new-lead-coverage-grid">
                {!isPersonal && <div className="field"><label htmlFor="new-lead-unit-count">Unit count</label><IntegerInput id="new-lead-unit-count" value={form.unitCount} onChange={value => setF("unitCount", value)} /></div>}
                <div className="field"><label htmlFor="new-lead-tiv">Total insured value ($)</label><MoneyInput id="new-lead-tiv" value={form.totalInsuredValue} onChange={value => setF("totalInsuredValue", value)} /></div>
                <div className="field"><label htmlFor="new-lead-current-agent">Current agent / broker</label><Input id="new-lead-current-agent" placeholder="Agency name" value={form.currentAgent} onChange={e => setF("currentAgent", e.target.value)} /></div>
                <div className="field"><label htmlFor="new-lead-expiration">Current policy expiration</label><DateInput id="new-lead-expiration" value={form.currentPolicyExpiration} onChange={value => setF("currentPolicyExpiration", value)} /></div>
              </div>
            </div>
          </details>

          <details className="new-lead-disclosure">
            <summary><span className="new-lead-disclosure-copy"><span className="new-lead-disclosure-title">Notes & documents</span><span className="new-lead-hint">{extrasSummary || "Background notes and supporting files"}</span></span><span className="new-lead-optional">Optional</span></summary>
            <div className="new-lead-disclosure-body new-lead-extras">
              <div className="field"><label htmlFor="new-lead-notes">Notes</label><Textarea id="new-lead-notes" rows={3} placeholder="Anything the team should know…" value={form.notes} onChange={e => setF("notes", e.target.value)} /></div>
              <div className="new-lead-documents">
                <div className="new-lead-document-heading"><h3>Documents</h3><FileButton label="Add documents…" multiple disabled={saving || !!createdId} onFiles={files => files && setStagedFiles(current => [...current, ...files])} /></div>
                <p className="new-lead-hint">Add policies, budgets or association documents. You can extract their details after creating the lead.</p>
                {stagedFiles.length > 0 && <ul className="new-lead-file-list" aria-label="Attached documents">
                  {stagedFiles.map((file, index) => <li key={index}><span className="new-lead-file-name">{file.name}</span><span className="new-lead-hint">{Math.max(1, Math.round(file.size / 1024))} KB</span><Button variant="link" type="button"  aria-label={`Remove ${file.name}`} onClick={() => setStagedFiles(current => current.filter((_, position) => position !== index))}>Remove</Button></li>)}
                </ul>}
              </div>
            </div>
          </details>
        </fieldset>

        <footer className="new-lead-actions">
          {error && <p className="error-text new-lead-error" role="alert">{error}</p>}
          <span className="new-lead-hint">{createdId ? "Your lead is ready to open." : "Only name and lead source are required."}</span>
          <div className="new-lead-action-buttons">
          {createdId ? (
            <><Button variant="primary" type="button"  onClick={reviewCreatedLead}>{reconciling ? "Review saved lead in new tab" : "Go to the lead"}</Button>
            {reconciling && <Button variant="secondary" type="button"  onClick={() => {
              const id = created.current!;
              cancelPending(); setNeedsReview(false); setReconciling(false); draft.clear(); markClean();
              navigate(`/accounts/${encodeURIComponent(id)}?tab=overview`);
            }}>I reviewed the lead — discard this draft</Button>}</>
          ) : (
            <><Button variant="secondary" type="button"  disabled={saving} onClick={() => navigate('/leads')}>Cancel</Button><Button variant="primary" type="submit"  disabled={saving}>
              {saving
                ? stagedFiles.length
                  ? "Creating & uploading…"
                  : "Creating…"
                : stagedFiles.length
                  ? `Create lead & upload ${stagedFiles.length} document${stagedFiles.length > 1 ? "s" : ""}`
                  : "Create lead"}
            </Button></>
          )}
          </div>
        </footer>
      </form>
    </div>
  );
}
