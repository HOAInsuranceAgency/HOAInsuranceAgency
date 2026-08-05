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
import ChildRowsCard from "./ChildRowsCard";
import { SaveStatus, useSaveStatus } from "./SaveStatus";
import { PhoneInput } from "./inputs";

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

const BLANK: ContactForm = { name: "", type: "", email: "", phone: "", notes: "" };

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
          await client.models.Contact.update({ id, isPrimary: true })
        );
        const demoted = await Promise.all(
          demote.map(async (c) =>
            unwrap(await client.models.Contact.update({ id: c.id, isPrimary: false }))
          )
        );
        const byId = new Map([promoted, ...demoted].map((c) => [c.id, c]));
        child.setRows((rows) => rows.map((c) => byId.get(c.id) ?? c));
      },
      {
        savedMessage: `${target.name} is now the primary contact.`,
        errorMessage: "Couldn't change the primary contact.",
      }
    );
  }

  return (
    <>
      <ChildRowsCard
        title="Contacts"
        child={child}
        addLabel="+ Add contact"
        emptyMessage="No contacts yet."
        summary={`— ${child.rows.length} total`}
        defaultSort="name"
        columns={[
          {
            key: "primary",
            label: "Primary",
            cell: (c) => (
              <input
                type="radio"
                name={`primary-contact-${accountId}`}
                checked={c.isPrimary === true}
                disabled={primaryStatus.busy}
                onChange={() => makePrimary(c.id)}
                aria-label={`Make ${c.name} the primary contact`}
              />
            ),
          },
          { key: "name", label: "Name", sort: (c) => c.name, cell: (c) => c.name },
          {
            key: "type",
            label: "Role",
            sort: (c) => (c.type ? CONTACT_TYPE_LABELS[c.type] : null),
            cell: (c) => (c.type ? CONTACT_TYPE_LABELS[c.type] ?? c.type : "—"),
          },
          {
            key: "email",
            label: "Email",
            sort: (c) => c.email,
            cell: (c) => c.email ?? "—",
          },
          {
            key: "phone",
            label: "Phone",
            sort: (c) => c.phone,
            cell: (c) => fmtPhone(c.phone),
          },
        ]}
        editTitle={(c) => `Editing ${c.name}`}
        removeMessage={(c) => `Remove ${c.name}?`}
        addFields={<ContactFields form={child.addForm} onEnter={child.add} />}
        editFields={<ContactFields form={child.editForm} />}
      />
      <SaveStatus {...primaryStatus.status} />
    </>
  );
}

function toUpdate(form: ContactForm) {
  return {
    name: str(form.name),
    type: str(form.type) as Contact["type"],
    email: str(form.email),
    phone: str(form.phone),
    notes: str(form.notes),
    // Recomputed on every write, not just the create: correcting a typo'd
    // email moves the person, and a key left pointing at the old address
    // would let the next extraction create a second row for them.
    extractionSourceKey: contactKey(form),
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

/** The same five fields in the add toolbar and the edit form. */
function ContactFields({
  form,
  onEnter,
}: {
  form: FormState<ContactForm>;
  onEnter?: () => void;
}) {
  const enter = onEnter
    ? (e: { key: string }) => {
        if (e.key === "Enter") onEnter();
      }
    : undefined;
  return (
    <>
      <div className="field">
        <label>Name</label>
        <input
          placeholder="Pat Alvarez"
          value={form.form.name}
          onChange={(e) => form.setF("name", e.target.value)}
          onKeyDown={enter}
        />
      </div>
      <div className="field">
        <label>Role</label>
        <select
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
        <label>Email</label>
        <input
          type="email"
          value={form.form.email}
          onChange={(e) => form.setF("email", e.target.value)}
          onKeyDown={enter}
        />
      </div>
      <div className="field">
        <label>Phone</label>
        <PhoneInput
          value={form.form.phone}
          onChange={(v) => form.setF("phone", v)}
          onKeyDown={enter}
        />
      </div>
      <div className="field" style={{ flex: "1 1 220px" }}>
        <label>Notes</label>
        <input
          placeholder="Best reached mornings"
          value={form.form.notes}
          onChange={(e) => form.setF("notes", e.target.value)}
          onKeyDown={enter}
        />
      </div>
    </>
  );
}
