import { LEAD_SOURCES, LEAD_SOURCE_LABELS } from "../../../shared/leadSource";
import { PROPERTY_TYPES, PROPERTY_TYPE_LABELS, normalizePropertyType } from "../../../shared/propertyType";
import { communicationRequest, type TeamEligibility } from "../lib/communications";
import { ResponsibilitySelect } from "../components/LeadWorkflowPanel";
import { isAssignableSalesperson } from "../../../shared/salespersonOwnership";
import { useAsyncResource } from "../lib/useAsyncResource";
import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
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
import { str } from "../lib/formCodec";
import { contactKey } from "../lib/extractionKeys";
import {
  ACCOUNT_TYPE_OPTIONS,
  CONTACT_TYPE_OPTIONS,
  DEFAULT_ACCOUNT_TYPE,
  type AccountType,
} from "../lib/enums";
import "./NewLead.css";

export default function NewLead() {
  const navigate = useNavigate();
  const formRef = useRef<HTMLFormElement>(null);
  const requestId = useRef(crypto.randomUUID());
  const savingNow = useRef(false);
  const created = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [salespersonId, setSalesperson] = useState("");
  const members = useAsyncResource(() => communicationRequest<{ team: TeamEligibility[]; actorId?: string }>("team"), [], { initialData: { team: [] } });
  useEffect(() => {
    const self = members.data.team.find(t => t.userId === members.data.actorId && isAssignableSalesperson(t));
    if (self) setSalesperson(s => s || self.userId);
  }, [members.data]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  // Set once the lead exists — pressing Create again would duplicate it.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const { form, setF, patch } = useFormState({
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

  function focusField(id: string) {
    const field = formRef.current?.querySelector<HTMLElement>(`#${id}`);
    const section = field?.closest('details');
    if (section) section.open = true;
    field?.focus();
  }

  async function save() {
    if (savingNow.current || created.current) return;
    if (!form.name.trim()) {
      setError("Name is required.");
      focusField('new-lead-name');
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
    let data: { id: string } | null = null;
    let errors: { message: string }[] = [];
    try {
      data = await communicationRequest<{ id: string }>("createLead", {
        requestId: requestId.current, salespersonId: salespersonId || undefined,
        fields: {
      stage: "LEAD",
      type: form.type as AccountType,
      propertyType: normalizePropertyType(form.propertyType) ?? undefined,
      name: form.name.trim(),
      address: form.address.trim() || undefined,
      city: form.city.trim() || undefined,
      state: form.state || undefined,
      zip: form.zip.trim() || undefined,
      unitCount: form.unitCount ? Number(form.unitCount) : undefined,
      totalInsuredValue: form.totalInsuredValue
        ? Number(form.totalInsuredValue)
        : undefined,
      currentAgent: form.currentAgent.trim() || undefined,
      currentPolicyExpiration: form.currentPolicyExpiration || undefined,
      leadSource: form.leadSource,
      notes: form.notes.trim() || undefined,
    },
      }, true);
    } catch (e) { errors = [{ message: e instanceof Error ? e.message : "Could not create lead" }]; }
    if (errors?.length || !data) {
      savingNow.current = false;
      setSaving(false);
      setError(friendlyError(errors?.[0]?.message, "Failed to create lead."));
      return;
    }
    created.current = data.id;

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

    // Upload any staged documents to the new account so OCR + AI extraction
    // are ready when they land on the Documents tab.
    const failedUploads: string[] = [];
    for (const file of stagedFiles) {
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
        if (!doc) {
          failedUploads.push(file.name);
          continue;
        }
        const path = `documents/ACCOUNT/${data.id}/${doc.id}/${file.name}`;
        const updated = await client.models.Document.update({ id: doc.id, s3Key: path });
        if (updated.errors?.length) throw new Error(updated.errors[0].message);
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
    setSaving(false);
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
    if (afterCreate.length) {
      setCreatedId(data.id);
      setError(`The lead was created, but ${afterCreate.join(" Also, ")}`);
      return;
    }
    // Land on Documents so OCR completes and AI extraction is the next step.
    navigate(`/accounts/${data.id}?tab=documents`);
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
      <button type="button" className="new-lead-back" disabled={saving} onClick={() => navigate('/leads')}>
        <span aria-hidden="true">←</span> Leads
      </button>
      <header className="new-lead-heading">
        <h1>New lead</h1>
        <p>Add the basics now. You can fill in the rest later.</p>
      </header>

      <form ref={formRef} className="card new-lead-form" aria-label="New lead" noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset className="new-lead-fields" disabled={saving || !!createdId} aria-label="Lead information">
          <div className="new-lead-essentials">
            <section className="new-lead-section" aria-labelledby="new-lead-details-heading">
              <h2 id="new-lead-details-heading">Lead details</h2>
              <div className="new-lead-grid">
                <div className="field full">
                  <label htmlFor="new-lead-name">Name (association / insured) *</label>
                  <input id="new-lead-name" required placeholder={isPersonal ? "Insured's full name" : "Association or business name"} value={form.name} onChange={e => setF("name", e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="new-lead-account-type">Account type</label>
                  <select id="new-lead-account-type" value={form.type} onChange={e => setF("type", e.target.value)}>
                    {ACCOUNT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="new-lead-property-type">Property type</label>
                  <select id="new-lead-property-type" value={form.propertyType} onChange={e => setF("propertyType", e.target.value)}>
                    <option value="">Choose if confirmed</option>
                    {PROPERTY_TYPES.map(value => <option key={value} value={value}>{PROPERTY_TYPE_LABELS[value]}</option>)}
                  </select>
                  {isPersonal && <span className="new-lead-hint">Personal (HO-6) accounts use Individual unit owner unless you choose another property type.</span>}
                </div>
                <div className="field">
                  <label htmlFor="new-lead-source">Lead source *</label>
                  <select id="new-lead-source" required value={form.leadSource} onChange={e => setF("leadSource", e.target.value)}>
                    <option value="">Choose a source</option>
                    {LEAD_SOURCES.map(value => <option key={value} value={value}>{LEAD_SOURCE_LABELS[value]}</option>)}
                  </select>
                </div>
                <ResponsibilitySelect label="Salesperson" value={salespersonId} team={members.data.team} onChange={setSalesperson} disabled={saving || members.loading} />
              </div>
              {members.error && <p className="error-text small" role="alert">{members.error} <button type="button" className="link" onClick={() => void members.refetch()}>Retry</button></p>}
            </section>

            <section className="new-lead-section new-lead-contact" aria-labelledby="new-lead-contact-heading">
              <div className="new-lead-section-heading"><h2 id="new-lead-contact-heading">Primary contact</h2><span className="new-lead-optional">Optional</span></div>
              <div className="new-lead-grid">
                <div className="field">
                  <label htmlFor="new-lead-contact-name">Contact name</label>
                  <input id="new-lead-contact-name" autoComplete="name" placeholder="Full name" value={form.contactName} onChange={e => setF("contactName", e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="new-lead-contact-role">Contact role</label>
                  <select id="new-lead-contact-role" value={form.contactType} onChange={e => setF("contactType", e.target.value)}>
                    <option value="">Choose a role</option>
                    {CONTACT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="field full">
                  <label htmlFor="new-lead-contact-email">Contact email</label>
                  <input id="new-lead-contact-email" type="email" autoComplete="email" placeholder="name@example.com" value={form.contactEmail} onChange={e => setF("contactEmail", e.target.value)} />
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
                <label className="field new-lead-address-field" onKeyDown={event => {
                  // Enter selects a Places suggestion; it must not create the lead.
                  if (event.key === 'Enter') event.preventDefault();
                }}>
                  <span>Street address</span>
                  <AddressAutocomplete value={form.address} onChange={value => setF("address", value)} onPlace={place => patch(current => ({ address: place.address || current.address, city: place.city || current.city, state: place.state || current.state, zip: place.zip || current.zip }))} />
                </label>
                <div className="field">
                  <label htmlFor="new-lead-city">City</label>
                  <input id="new-lead-city" autoComplete="address-level2" value={form.city} onChange={e => setF("city", e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="new-lead-state">State</label>
                  <select id="new-lead-state" autoComplete="address-level1" value={form.state} onChange={e => setF("state", e.target.value)}>
                    <option value="">—</option>{US_STATES.map(state => <option key={state}>{state}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="new-lead-zip">ZIP</label>
                  <input id="new-lead-zip" autoComplete="postal-code" inputMode="numeric" value={form.zip} onChange={e => setF("zip", e.target.value)} />
                </div>
              </div>
              <div className="new-lead-grid new-lead-coverage-grid">
                {!isPersonal && <div className="field"><label htmlFor="new-lead-unit-count">Unit count</label><IntegerInput id="new-lead-unit-count" value={form.unitCount} onChange={value => setF("unitCount", value)} /></div>}
                <div className="field"><label htmlFor="new-lead-tiv">Total insured value ($)</label><MoneyInput id="new-lead-tiv" value={form.totalInsuredValue} onChange={value => setF("totalInsuredValue", value)} /></div>
                <div className="field"><label htmlFor="new-lead-current-agent">Current agent / broker</label><input id="new-lead-current-agent" placeholder="Agency name" value={form.currentAgent} onChange={e => setF("currentAgent", e.target.value)} /></div>
                <div className="field"><label htmlFor="new-lead-expiration">Current policy expiration</label><DateInput id="new-lead-expiration" value={form.currentPolicyExpiration} onChange={value => setF("currentPolicyExpiration", value)} /></div>
              </div>
            </div>
          </details>

          <details className="new-lead-disclosure">
            <summary><span className="new-lead-disclosure-copy"><span className="new-lead-disclosure-title">Notes & documents</span><span className="new-lead-hint">{extrasSummary || "Background notes and supporting files"}</span></span><span className="new-lead-optional">Optional</span></summary>
            <div className="new-lead-disclosure-body new-lead-extras">
              <div className="field"><label htmlFor="new-lead-notes">Notes</label><textarea id="new-lead-notes" rows={3} placeholder="Anything the team should know…" value={form.notes} onChange={e => setF("notes", e.target.value)} /></div>
              <div className="new-lead-documents">
                <div className="new-lead-document-heading"><h3>Documents</h3><FileButton label="Add documents…" multiple disabled={saving || !!createdId} onFiles={files => files && setStagedFiles(current => [...current, ...files])} /></div>
                <p className="new-lead-hint">Add policies, budgets or association documents. You can extract their details after creating the lead.</p>
                {stagedFiles.length > 0 && <ul className="new-lead-file-list" aria-label="Attached documents">
                  {stagedFiles.map((file, index) => <li key={index}><span className="new-lead-file-name">{file.name}</span><span className="new-lead-hint">{Math.max(1, Math.round(file.size / 1024))} KB</span><button type="button" className="link" aria-label={`Remove ${file.name}`} onClick={() => setStagedFiles(current => current.filter((_, position) => position !== index))}>Remove</button></li>)}
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
            <button type="button" className="primary" onClick={() => navigate(`/accounts/${createdId}?tab=documents`)}>
              Go to the lead
            </button>
          ) : (
            <><button type="button" className="secondary" disabled={saving} onClick={() => navigate('/leads')}>Cancel</button><button type="submit" className="primary" disabled={saving}>
              {saving
                ? stagedFiles.length
                  ? "Creating & uploading…"
                  : "Creating…"
                : stagedFiles.length
                  ? `Create lead & upload ${stagedFiles.length} document${stagedFiles.length > 1 ? "s" : ""}`
                  : "Create lead"}
            </button></>
          )}
          </div>
        </footer>
      </form>
    </div>
  );
}
