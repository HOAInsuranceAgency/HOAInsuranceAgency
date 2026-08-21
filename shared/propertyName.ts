/**
 * Does a submitted association name look like an actual association?
 *
 * The web form requires the field, and a required field teaches people to type
 * *something*: "test", "n/a", "my hoa", the first four keys of the home row.
 * Everything downstream then repeats that something as if it were the
 * association — the auto-reply's subject line being the most public place.
 * "test insurance review" in an inbox reads as exactly what it is.
 *
 * Lives in `shared/` for the same reason `leadUpload.ts` does: the CRM needs
 * the rule at send time, and the website can use the same rule to nudge the
 * visitor while they can still fix it.
 *
 * The bar is deliberately low. A false alarm makes the reply say "your
 * association" where it could have used the name, which reads fine; a miss
 * puts "asdf" in a subject line. Only flag what is clearly not a name; when
 * in doubt, pass it.
 */

/** Words that mean "I typed something to get past the field", wherever they appear. */
const PLACEHOLDER_WORDS = new Set([
  "test",
  "testing",
  "tester",
  "asdf",
  "qwerty",
  "dummy",
  "placeholder",
  "sample",
  "fake",
  "demo",
  "example",
  "foo",
  "foobar",
  "blah",
  "tbd",
  "todo",
  "unknown",
  "idk",
  "lorem",
  "ipsum",
]);

/** The same habit, but only a problem when they are the entire answer. */
const PLACEHOLDER_ANSWERS = new Set([
  "n a",
  "na",
  "none",
  "no",
  "yes",
  "ok",
  "null",
  "nil",
  "tba",
  "xxx",
  "zzz",
  "abc",
  "abcd",
  "xyz",
  "not sure",
  "dont know",
  "don t know",
]);

/**
 * Words that describe what an association *is* rather than which one it is.
 * "Maple Court Condominium Trust" keeps "maple court" once these are removed;
 * "my condo association" keeps nothing, which is the tell.
 */
const GENERIC_WORDS = new Set([
  "the",
  "a",
  "an",
  "my",
  "our",
  "your",
  "of",
  "at",
  "in",
  "on",
  "and",
  "hoa",
  "hoas",
  "coa",
  "condo",
  "condos",
  "condominium",
  "condominiums",
  "association",
  "associations",
  "assn",
  "assoc",
  "apartment",
  "apartments",
  "apt",
  "apts",
  "building",
  "buildings",
  "complex",
  "community",
  "communities",
  "property",
  "properties",
  "townhome",
  "townhomes",
  "townhouse",
  "townhouses",
  "home",
  "homes",
  "homeowner",
  "homeowners",
  "owner",
  "owners",
  "co",
  "op",
  "coop",
  "inc",
  "llc",
  "corp",
  "corporation",
  "company",
  "trust",
  "board",
  "insurance",
  "policy",
  "master",
]);

/**
 * A name whose last word is one of these was cut off mid-phrase: "Villas at",
 * "The Cottages on". Deliberately excludes "la" — "Shangri-La" ends with it
 * legitimately once the hyphen is normalised away.
 */
const TRAILING_CONNECTORS = new Set([
  "at",
  "of",
  "the",
  "a",
  "an",
  "and",
  "on",
  "in",
  "for",
  "by",
  "near",
  "de",
  "del",
]);

const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

/** One key held down, a run along a keyboard row, or a word with no vowel in it. */
function keyboardMash(word: string): boolean {
  // Accents folded out so "Côté" is judged on "cote", which has vowels.
  const flat = word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (/^(.)\1+$/.test(flat)) return true;
  const reversed = [...flat].reverse().join("");
  if (
    flat.length >= 3 &&
    KEYBOARD_ROWS.some((row) => row.includes(flat) || row.includes(reversed))
  ) {
    return true;
  }
  return flat.length >= 4 && /^[a-z]+$/.test(flat) && !/[aeiouy]/.test(flat);
}

/**
 * Why this cannot be an association's name, or null if it can.
 *
 * The reason is a clause that finishes a sentence like "the name does not look
 * real (…)": it is read by producers on the LeadReply row and by the reply
 * model in its prompt, never by the lead.
 */
export function propertyNameProblem(raw: string | null | undefined): string | null {
  const name = raw?.trim().replace(/\s+/g, " ") ?? "";
  if (!name) return "it is empty";

  // An inbox or address-bar paste answers a different question.
  if (/\S@\S/.test(name) || /https?:\/\/|www\./i.test(name) || /\.(com|net|org)\b/i.test(name)) {
    return "it looks like an email or web address";
  }

  const letters = name.replace(/[^\p{L}]/gu, "").toLowerCase();
  if (!letters) return "it has no letters in it";
  if (letters.length < 3) return "it is too short to be a name";

  const squished = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const words = squished.split(" ");

  if (PLACEHOLDER_ANSWERS.has(squished) || words.some((w) => PLACEHOLDER_WORDS.has(w))) {
    return "it is a placeholder, not a name";
  }

  // "my hoa", "condo association": a category, not a name. Bare numbers do not
  // rescue one either — "building 7" still names no association.
  const distinctive = words.filter((w) => !GENERIC_WORDS.has(w) && !/^\p{N}+$/u.test(w));
  if (distinctive.length === 0) {
    return "it is generic words with no actual name in them";
  }

  if (distinctive.every(keyboardMash)) {
    return "it looks like keyboard mash";
  }

  if (TRAILING_CONNECTORS.has(words[words.length - 1])) {
    return "it stops mid-phrase";
  }

  return null;
}
