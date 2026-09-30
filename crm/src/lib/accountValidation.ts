// Shared by CRM forms and local previews without initializing the live client.
// Returns a list of human-readable problems; empty = valid. All fields
// optional — only filled-in values are checked.
export function validateAccountFields(f: {
  contactEmail?: string;
  zip?: string;
  unitCount?: string;
  totalInsuredValue?: string;
}): string[] {
  const problems: string[] = [];
  const email = f.contactEmail?.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    problems.push("Contact email doesn't look like a valid address.");
  }
  const zip = f.zip?.trim();
  if (zip && !/^\d{5}(-\d{4})?$/.test(zip)) {
    problems.push("ZIP should be 5 digits (or ZIP+4).");
  }
  if (f.unitCount) {
    const n = Number(f.unitCount);
    if (!Number.isInteger(n) || n < 0 || n > 100000)
      problems.push("Unit count should be a whole number of at least 0.");
  }
  // `yearBuilt` is not checked here any more: it is a property of a building
  // and `BuildingsCard` validates it with `validateYear`, which is where the
  // +5 bound and its reasoning now live.
  if (f.totalInsuredValue) {
    const n = Number(f.totalInsuredValue);
    if (!Number.isFinite(n) || n < 0)
      problems.push("Total insured value can't be negative.");
  }
  return problems;
}
