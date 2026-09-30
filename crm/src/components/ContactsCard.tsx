import { useId } from "react";
import {
  EMAIL_RE,
  client,
  fmtPhone,
  unwrap,
  type Contact,
} from "../lib/client";
import { inputValue, str } from "../lib/formCodec";
import { contactKey } from "../lib/extractionKeys";
import { useChildRows } from "../lib/useChildRows";
import type { FormState } from "../lib/useFormState";
import { CONTACT_TYPE_LABELS, CONTACT_TYPE_OPTIONS } from "../lib/enums";
import { SortTh, useSort } from "../lib/useSort";
import ConfirmButton from "./ConfirmButton";
import Modal from "./Modal";
import { SaveStatus, useSaveStatus } from "./SaveStatus";
import { PhoneInput } from "./inputs";
import "./ContactsCard.css";

/**
 * The people at an association.
 *
 * Replaces six Account columns — `contactFirstName`, `contactLastName`,
 * `contactEmail`, `contactPhone`, `inspectionContactName`,
 * `inspectionContactPhone` — which between them could hold exactly two people
 * and, apart from the inspection pair, said nothing about who either of them
 * was. A managed association routinely has five: a manager, a board president,
 * a trustee, someone in accounting, and whoever meets the inspector.
 *
 * ## Why `isPrimary` is a table column and not a form field
 *
 * Exactly one contact per account is primary — it is the phone number the
 * ACORD insured block and the COI carry, and "which of five" has to have an
 * answer. Setting it therefore clears it everywhere else, which is a write
 * across rows the add/edit forms do not own.
 *
 * Keeping it out of the forms is what makes that tractable. The radio lives in
 * the table, where the thing it selects between is visible, and it has its own
 * save status because it is its own write. The forms never touch the flag, so
 * neither create nor edit can leave two contacts primary.
 *
 * The one case that needs no cross-row write is the first contact: it is the
 * only one, so it *is* the primary, and `toCreate` says so directly.
 */

interface ContactForm {
  name: string;
  type: string;
  email: string;
  phone: string;
  notes: string;
}

const BLANK: ContactForm = {
  name: "",
  type: "",
  email: "",
  phone: "",
  notes: "",
};

export default function ContactsCard({ accountId }: { accountId: string }) {
  const child = useChildRows<Contact, ContactForm>(client.models.Contact, {
    accountId,
    noun: "contact",
    initialForm: BLANK,
    toForm: (c) => ({
      name: inputValue(c.name),
      type: inputValue(c.type),
      email: inputValue(c.email),
      phone: inputValue(c.phone),
      notes: inputValue(c.notes),
    }),
    toCreate,
    toUpdate,
    validate,
    describe: (form) => form.name.trim() || "Contact",
    describeRow: (c) => c.name,
  });

  // A hoisted declaration with an explicit return type, so that reading
  // `child.rows` inside it does not make the hook's own type circular —
  // `child`'s type depends on the options object this belongs to.
  function toCreate(form: ContactForm): Record<string, unknown> {
    return {
      ...toUpdate(form),
      // The first contact on an account is the primary one by arithmetic, not
      // by choice — there is nothing else for the ACORD block to use.
      isPrimary: child.rows.length === 0,
      // On the create and NOT on the update. This used to be recomputed on
      // every write, on the reasoning that correcting a typo'd email moves the
      // person and a key pointing at the old address would let the next
      // extraction file a second row for them. That was right when the stored
      // key was the only thing matching compared — and it is wrong now.
      //
      // Matching derives a row's current identity itself (see
      // `contactAliases`), so the correction is covered either way. What only
      // the stored key can say is what the row was called *before* the edit,
      // and recomputing it throws that away — which is how a loss whose amount
      // was filled in afterwards stopped answering to the key it was created
      // under and came back from an extraction as a new loss.
      extractionSourceKey: contactKey(form),
    };
  }

  // Its own status because it is its own write, and one that touches rows the
  // add and edit forms never see.
  const primaryStatus = useSaveStatus({ autoClearMs: 4000 });

  async function makePrimary(id: string) {
    const target = child.rows.find((c) => c.id === id);
    if (!target || target.isPrimary) return;
    const demote = child.rows.filter((c) => c.isPrimary && c.id !== id);
    await primaryStatus.run(
      async () => {
        // The promotion first: if the batch fails half-way, an account with
        // two primaries is recoverable and one with none is a blank field on
        // a carrier submission.
        const promoted = unwrap(
          await client.models.Contact.update({ id, isPrimary: true }),
        );
        const demoted = await Promise.all(
          demote.map(async (c) =>
            unwrap(
              await client.models.Contact.update({
                id: c.id,
                isPrimary: false,
              }),
            ),
          ),
        );
        const byId = new Map([promoted, ...demoted].map((c) => [c.id, c]));
        child.setRows((rows) => rows.map((c) => byId.get(c.id) ?? c));
      },
      {
        savedMessage: `${target.name} is now the primary contact.`,
        errorMessage: "Couldn't change the primary contact.",
      },
    );
  }

  const { sorted, sortKey, dir, toggle } = useSort<Contact>(
    child.rows,
    {
      name: (c) => c.name,
      type: (c) => (c.type ? CONTACT_TYPE_LABELS[c.type] : null),
      email: (c) => c.email,
      phone: (c) => c.phone,
    },
    "name",
  );
  const editingContact = child.rows.find((c) => c.id === child.editingId);

  return (
    <section className="card contacts-card" aria-label="Contacts">
      <div className="contacts-heading">
        <h2>
          Contacts
          {child.loaded && !child.error ? (
            <span className="contacts-count">{child.rows.length}</span>
          ) : null}
        </h2>
        <p>Select a primary contact for applications and certificates.</p>
      </div>

      {!child.loaded ? (
        <p className="contacts-state" role="status">
          Loading contacts…
        </p>
      ) : child.error ? (
        <p className="contacts-state error-text" role="alert">
          {child.error}
        </p>
      ) : (
        <>
          <details className="contacts-add">
            <summary>Add contact</summary>
            <div className="contacts-add-body">
              <div className="contacts-fields">
                <ContactFields form={child.addForm} onEnter={child.add} />
              </div>
              <div className="contacts-form-actions">
                <button
                  className="primary"
                  disabled={child.addStatus.busy}
                  onClick={child.add}
                >
                  {child.addStatus.busy ? "Adding…" : "Save contact"}
                </button>
              </div>
            </div>
          </details>
          <div className="contacts-feedback">
            <SaveStatus {...child.addStatus.status} />
            <SaveStatus {...child.delStatus.status} />
            {child.editingId === null ? (
              <SaveStatus {...child.editStatus.status} />
            ) : null}
            <SaveStatus {...primaryStatus.status} />
          </div>

          {child.rows.length === 0 ? (
            <div className="contacts-state contacts-empty">
              <strong>No contacts yet.</strong>
              <p>
                Add the people involved with this account. The first contact
                becomes primary.
              </p>
            </div>
          ) : (
            <div className="table-wrap contacts-table-wrap">
              <table className="contacts-table" aria-label="Account contacts">
                <colgroup>
                  <col className="contacts-primary-col" />
                  <col className="contacts-name-col" />
                  <col className="contacts-role-col" />
                  <col className="contacts-email-col" />
                  <col className="contacts-phone-col" />
                  <col className="contacts-actions-col" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Primary</th>
                    {[
                      { key: "name", label: "Name" },
                      { key: "type", label: "Role" },
                      { key: "email", label: "Email" },
                      { key: "phone", label: "Phone" },
                    ].map((column) => (
                      <SortTh
                        key={column.key}
                        label={column.label}
                        colKey={column.key}
                        sortKey={sortKey}
                        dir={dir}
                        onToggle={toggle}
                      />
                    ))}
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((contact) => (
                    <tr key={contact.id}>
                      <td className="contacts-primary">
                        <input
                          type="radio"
                          name={`primary-contact-${accountId}`}
                          checked={contact.isPrimary === true}
                          disabled={primaryStatus.busy}
                          onChange={() => makePrimary(contact.id)}
                          aria-label={`Make ${contact.name} the primary contact`}
                        />
                      </td>
                      <td>
                        <span className="contacts-name">{contact.name}</span>
                      </td>
                      <td>
                        {contact.type
                          ? (CONTACT_TYPE_LABELS[contact.type] ?? contact.type)
                          : "—"}
                      </td>
                      <td>{contact.email ?? "—"}</td>
                      <td className="contacts-phone">
                        {fmtPhone(contact.phone)}
                      </td>
                      <td>
                        <div className="contacts-row-actions">
                          <button
                            className="secondary"
                            aria-label={`Edit ${contact.name}`}
                            onClick={() => child.startEdit(contact)}
                          >
                            Edit
                          </button>
                          <ConfirmButton
                            label="Remove"
                            busyLabel="Removing…"
                            message={`Remove ${contact.name}?`}
                            onConfirm={() => child.remove(contact.id)}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {editingContact ? (
            <Modal
              title={`Editing ${editingContact.name}`}
              onClose={child.cancelEdit}
              className="modal-form contacts-editor"
            >
              <div className="contacts-fields">
                <ContactFields form={child.editForm} />
              </div>
              <div className="contacts-form-actions">
                <button
                  className="primary"
                  disabled={child.editStatus.busy}
                  onClick={child.saveEdit}
                >
                  {child.editStatus.busy ? "Saving…" : "Save"}
                </button>
                <button className="secondary" onClick={child.cancelEdit}>
                  Cancel
                </button>
              </div>
              <SaveStatus {...child.editStatus.status} />
            </Modal>
          ) : null}
        </>
      )}
    </section>
  );
}

function toUpdate(form: ContactForm) {
  return {
    name: str(form.name),
    type: str(form.type) as Contact["type"],
    email: str(form.email),
    phone: str(form.phone),
    notes: str(form.notes),
  };
}

function validate(form: ContactForm): string[] {
  const problems: string[] = [];
  // The one required column on the model. Everything else about a contact can
  // legitimately be unknown when the row is created.
  if (!form.name.trim()) problems.push("Contact name is required.");
  const email = form.email.trim();
  // a.email() rejects a malformed address outright, so an unchecked one comes
  // back as a raw GraphQL variable error rather than something actionable.
  if (email && !EMAIL_RE.test(email)) {
    problems.push("Contact email doesn't look like a valid address.");
  }
  return problems;
}

/** The same five fields in the add disclosure and the edit dialog. */
function ContactFields({
  form,
  onEnter,
}: {
  form: FormState<ContactForm>;
  onEnter?: () => void;
}) {
  const id = useId();
  const enter = onEnter
    ? (e: { key: string }) => {
        if (e.key === "Enter") onEnter();
      }
    : undefined;
  return (
    <>
      <div className="field">
        <label htmlFor={`${id}-name`}>Name</label>
        <input
          id={`${id}-name`}
          placeholder="Pat Alvarez"
          value={form.form.name}
          onChange={(e) => form.setF("name", e.target.value)}
          onKeyDown={enter}
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-type`}>Role</label>
        <select
          id={`${id}-type`}
          value={form.form.type}
          onChange={(e) => form.setF("type", e.target.value)}
        >
          <option value="">—</option>
          {CONTACT_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-email`}>Email</label>
        <input
          id={`${id}-email`}
          type="email"
          value={form.form.email}
          onChange={(e) => form.setF("email", e.target.value)}
          onKeyDown={enter}
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-phone`}>Phone</label>
        <PhoneInput
          id={`${id}-phone`}
          value={form.form.phone}
          onChange={(v) => form.setF("phone", v)}
          onKeyDown={enter}
        />
      </div>
      <div className="field contacts-notes-field">
        <label htmlFor={`${id}-notes`}>Notes</label>
        <input
          id={`${id}-notes`}
          placeholder="Best reached mornings"
          value={form.form.notes}
          onChange={(e) => form.setF("notes", e.target.value)}
          onKeyDown={enter}
        />
      </div>
    </>
  );
}
