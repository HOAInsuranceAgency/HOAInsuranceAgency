/** The internal Front intake email. The original snapshot remains unchanged. */
const escape = (value: string) => value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
const key = (value: string) => value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[^a-z0-9]/gi, "").toLowerCase();
const technical = (label: string) => label.startsWith("_") || /^(buildiumid|answersnapshot|submissionid|retryproof|uploadtoken|fingerprint|proofhash)$/.test(key(label));
const label = (value: string) => value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, ch => ch.toUpperCase());
function valueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join("\n");
  if (typeof value === "object") return Object.entries(value).filter(([k]) => !technical(k)).map(([k, v]) => {
    const text = valueText(v); return text ? `${label(k)}: ${text}` : "";
  }).filter(Boolean).join("\n");
  const text = String(value).trim();
  return ["", "—", "–", "-"].includes(text) ? "" : text;
}
function dateOnly(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value)
    ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date) : value;
}
function phoneDisplay(value: string): string {
  if (!/^[+\d\s().-]+$/.test(value)) return value;
  const digits = value.replace(/\D/g, "");
  const us = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : !value.startsWith("+") && digits.length === 10 ? digits : "";
  return us ? `(${us.slice(0, 3)}) ${us.slice(3, 6)}-${us.slice(6)}` : value;
}
const font = "Arial,Helvetica,sans-serif";
const richText = (value: string) => escape(value).replace(/\r?\n/g, "<br>");
type Detail = [string, string];

export interface IntakeBriefInput {
  snapshot: Record<string, unknown>;
  accountId: string;
  accountName: string;
  submissionId: string;
  receivedAt: string;
  environment: string;
  crmBaseUrl?: string;
}

export function renderIntakeBrief(input: IntakeBriefInput): { html: string; text: string } {
  const s = input.snapshot;
  const answers = s.answers && typeof s.answers === "object" && !Array.isArray(s.answers) ? s.answers as Record<string, unknown> : {};
  const used = new Set<string>();
  // Consume aliases together: each fact appears once, even in older snapshots
  // that contain both the normalized CRM fields and the original form answers.
  const take = (...names: string[]) => {
    const keys = names.map(key);
    for (const k of Object.keys(answers)) if (keys.includes(key(k))) used.add(k);
    for (const name of names) {
      const match = Object.keys(answers).find(k => key(k) === key(name));
      const text = valueText(match === undefined ? undefined : answers[match]);
      if (text) return text;
    }
    return "";
  };
  const field = (name: string, ...aliases: string[]) => {
    const answer = take(...aliases); return valueText(s[name]) || answer;
  };
  const source = valueText(s.source);
  const sourceAnswer = take("Source");
  const leadType = take("Lead Type");
  const isPersonal = s.type === "PERSONAL" || source.startsWith("website-ho6:");
  const request = source.startsWith("website-ho6:") ? "HO-6 quote request"
    : source === "website-contact" ? "Website enquiry"
    : source.startsWith("website-assessment:") ? "Insurance assessment"
    : source === "website-coverage-calculator" ? "Coverage calculator enquiry"
    : isPersonal ? "HO-6 quote request" : "Association quote request";
  const fullName = take("Full Name", "Contact Name");
  const first = field("contactFirstName", "First Name"), last = field("contactLastName", "Last Name");
  const contactName = [first, last].filter(Boolean).join(" ") || fullName;
  const email = field("contactEmail", "Email"), phone = field("contactPhone", "Phone");
  const role = take("Role");
  const association = take("Building / Association", "Association", "Association Name");
  const title = association || input.accountName || contactName || request;
  const addressAnswer = take("Property Address", "Building Address", "Address");
  const line2 = take("Address Line 2");
  const address = valueText(s.address);
  const city = field("city", "City"), state = field("state", "State"), zip = field("zip", "ZIP");
  const locality = [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const addressIncludesLocality = [city, state, zip].every(part => !part || address.toLowerCase().includes(part.toLowerCase()));
  const location = address ? [address, addressIncludesLocality ? "" : locality].filter(Boolean).join("\n") : addressAnswer || locality;
  const unit = field("unitNumber", "Unit Number"), units = field("unitCount", "Unit Count");
  const carrier = field("currentCarrier", "Current HO-6 Carrier", "Current Carriers", "Current Carrier");
  const renewal = field("currentPolicyExpiration", "Program Expiry", "Renewal Date");
  const coverages = take("Lines to Review", "Coverage Needs");
  const need = take("What They Need");
  const shown = take("Coverages Shown");
  const websiteAgent = take("Website Agent");
  const message = take("Message", "Notes");
  const notes = valueText(s.notes);
  // The website adds these structured facts to Account.notes as well. Keep
  // genuine free text, but don't repeat the same coverage/role block below it.
  const generatedNotes = [association && `Association: ${association}`, role && `Role: ${role}`, websiteAgent && `Assigned agent: ${websiteAgent}`,
    coverages && `Lines to review: ${coverages}`, need && `What they need: ${need}`, shown && `Coverages shown: ${shown.replace(/ \([^)]*\)/g, "")}`].filter(Boolean);
  const additionalNotes = notes.split(/\r?\n/).filter(line => !generatedNotes.includes(line.trim())).join("\n").trim();
  const note = message || additionalNotes;
  const property: Detail[] = [["Property address", location], ["Address line 2", !address.includes(line2) ? line2 : ""], ["Unit number", unit], ["Association size", units ? `${units} ${units === "1" ? "unit" : "units"}` : ""]];
  const coverage: Detail[] = [["Requested coverage", coverages], ["What they need", need], [isPersonal ? "Current HO-6 carrier" : "Current carrier", carrier], ["Policy expiration", dateOnly(renewal)], ["Coverages shown in calculator", shown]];
  const additional: Detail[] = Object.entries(answers).filter(([k]) => !used.has(k) && !technical(k)).map(([k, v]) => [label(k), valueText(v)]);
  if (websiteAgent) additional.push(["Website agent", websiteAgent]);
  // Preserve a useful source label without exposing route slugs or system keys.
  const sourceLabel = source.startsWith("website-ho6:") ? "Association page"
    : source === "website-quote" ? "Quote form" : source === "website-contact" ? "Contact form"
    : source.startsWith("website-assessment:") ? sourceAnswer || "Instant assessment"
    : source === "website-coverage-calculator" ? "Coverage calculator" : sourceAnswer || "Website form";
  if (leadType && !/^(HO-6 Unit Owner|ASSOCIATION|PERSONAL)$/i.test(leadType)) additional.push(["Lead type", leadType]);
  const received = new Date(input.receivedAt);
  const receivedLabel = Number.isFinite(received.getTime()) ? new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short",
  }).format(received) : "";
  let crmUrl = "";
  try {
    const base = new URL(input.crmBaseUrl || "");
    if (base.protocol === "https:" && !base.username && !base.password) {
      const url = new URL(`${base.pathname.replace(/\/$/, "")}/accounts/${encodeURIComponent(input.accountId)}`, base.origin);
      // A non-visible correlation reference survives Front's HTML conversion.
      // Ingestion still verifies the exact provider UID before trusting it.
      url.searchParams.set("submission", input.submissionId);
      crmUrl = url.href;
    }
  } catch { /* Missing configuration must not render a broken or unsafe link. */ }
  const section = (title: string, details: Detail[]) => {
    const rows = details.filter(([, v]) => v);
    if (!rows.length) return "";
    return `<tr><td style="padding:22px 24px 0"><h2 style="margin:0 0 10px;font:700 16px/1.4 ${font};color:#142a4c">${escape(title)}</h2>
<table width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;table-layout:fixed">${rows.map(([k, v]) => `<tr><th scope="row" width="36%" valign="top" style="padding:9px 12px 9px 0;border-top:1px solid #e5eaf0;text-align:left;font:400 13px/1.5 ${font};color:#526175;overflow-wrap:anywhere">${escape(k)}</th><td valign="top" style="padding:9px 0;border-top:1px solid #e5eaf0;font:400 15px/1.5 ${font};color:#172b45;overflow-wrap:anywhere;word-break:break-word">${richText(v)}</td></tr>`).join("")}</table></td></tr>`;
  };
  const contactLink = (value: string, href: string) => `<a href="${escape(href)}" style="color:#214e76;text-decoration:underline;overflow-wrap:anywhere;word-break:break-word">${escape(value)}</a>`;
  const emailHtml = /^[^\s@<>"?&#]+@[^\s@<>"?&#]+\.[^\s@<>"?&#]+$/.test(email) ? contactLink(email, `mailto:${email}`) : escape(email);
  const phoneHtml = /^[+\d\s().-]+$/.test(phone) ? contactLink(phoneDisplay(phone), `tel:${phone.replace(/[^+\d]/g, "")}`) : escape(phone);
  const contact = [emailHtml, phoneHtml].filter(Boolean).join("<br>");
  const staging = input.environment !== "main";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f5f8"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f8"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:#ffffff;border:1px solid #e1e7ee;border-radius:10px;overflow:hidden">
<tr><td style="padding:22px 24px;background:#142a4c;border-top:4px solid #c7a45c">
<p style="margin:0 0 20px;font:700 11px/1.4 ${font};letter-spacing:1.3px;color:#ead5a7">HOA INSURANCE AGENCY${staging ? " &nbsp; / &nbsp; STAGING TEST" : ""}</p>
<p style="margin:0 0 7px;font:400 13px/1.4 ${font};color:#d6e2ef">NEW WEBSITE LEAD &nbsp;·&nbsp; ${escape(request)}</p>
<h1 style="margin:0;font:700 26px/1.25 ${font};color:#ffffff;overflow-wrap:anywhere;word-break:break-word">${escape(title)}</h1>
${unit ? `<p style="margin:8px 0 0;font:400 15px/1.5 ${font};color:#e3ebf4">Unit ${escape(unit)}</p>` : ""}</td></tr>
${contactName || contact ? `<tr><td style="padding:20px 24px;background:#edf3f8;border-bottom:1px solid #dce5ee"><p style="margin:0 0 5px;font:700 11px/1.4 ${font};letter-spacing:1px;color:#526175">CONTACT</p>
${contactName ? `<p style="margin:0 0 3px;font:700 19px/1.4 ${font};color:#142a4c">${escape(contactName)}</p>` : ""}${role ? `<p style="margin:0 0 8px;font:400 14px/1.4 ${font};color:#526175">${escape(role)}</p>` : ""}
${contact ? `<p style="margin:0;font:400 15px/1.8 ${font}">${contact}</p>` : ""}</td></tr>` : ""}
${section("Property", property)}${section("Insurance request", coverage)}
${note ? `<tr><td style="padding:22px 24px 0"><h2 style="margin:0 0 10px;font:700 16px/1.4 ${font};color:#142a4c">${message ? "Message from the prospect" : "Submission notes"}</h2><div style="padding:15px 17px;background:#faf7ef;border-left:3px solid #c7a45c;font:400 15px/1.65 ${font};color:#28384c;overflow-wrap:anywhere;word-break:break-word">${richText(note)}</div></td></tr>` : ""}
${section("Additional details", additional)}
<tr><td style="padding:24px">${crmUrl ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#142a4c" style="border-radius:6px"><a href="${escape(crmUrl)}" style="display:inline-block;padding:13px 20px;border:1px solid #142a4c;border-radius:6px;font:700 14px/1.3 ${font};color:#ffffff;text-decoration:none">Open lead in CRM &rarr;</a></td></tr></table><p style="margin:10px 0 0;font:400 12px/1.5 ${font};color:#526175">View assignments, documents, and follow-up.</p>` : ""}
<p style="margin:22px 0 0;padding-top:14px;border-top:1px solid #e5eaf0;font:400 12px/1.6 ${font};color:#526175">${escape(sourceLabel)}${receivedLabel ? `<br>Received ${escape(receivedLabel)}` : ""}</p></td></tr>
</table></td></tr></table></body></html>`;
  const text = [staging ? "STAGING TEST" : "", request, title, unit && `Unit ${unit}`, "", contactName, role, email, phoneDisplay(phone), "",
    ...[...property, ...coverage, ...additional].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`), note && `\nMessage:\n${note}`,
    crmUrl && `\nOpen lead in CRM: ${crmUrl}`, "", sourceLabel, receivedLabel && `Received ${receivedLabel}`].join("\n");
  return { html, text };
}

/** Lookup hint only. The caller must verify the import operation's exact UID. */
export function intakeReferenceFromHtml(body: string | undefined, crmBaseUrl: string | undefined): string | undefined {
  if (!body || !crmBaseUrl) return;
  try {
    const base = new URL(crmBaseUrl);
    for (const match of body.matchAll(/href=["']([^"']+)["']/gi)) {
      const url = new URL(match[1].replace(/&amp;/g, "&"));
      if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/accounts/`)) continue;
      const id = url.searchParams.get("submission");
      if (id && /^[a-zA-Z0-9-]{1,100}$/.test(id)) return id;
    }
  } catch { return; }
}
