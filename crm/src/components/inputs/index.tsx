import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { fmtNum, normalizePhone } from "../../lib/client";

/**
 * The six editable field types, formatted.
 *
 * `client.ts` has had `fmtNum` / `fmtMoney` / `fmtDate` since the beginning,
 * and every one of them is **display only**. Every editable numeric in the app
 * is a bare `<input type="number">`, so a $4.2M total insured value is typed
 * and read back as `4200000` — sixteen unseparated characters that a producer
 * has to count with a finger to check. These components close that gap: the
 * field shows `4,200,000` and the form still holds `"4200000"`.
 *
 * ## The contract
 *
 * `value` is the **raw** string the form state holds and `onChange` hands back
 * the same kind of string, so `num(form.totalInsuredValue)` at the write
 * boundary is unchanged and unaware any of this happened. Formatting exists
 * between the state and the pixels and nowhere else.
 *
 * All six take exactly the same props, which is the point — swapping
 * `IntegerInput` for `MoneyInput` in a form is a one-word edit, and none of
 * them can be given a prop the others would ignore.
 *
 * ## Formatting happens on blur
 *
 * While the field has focus it shows the raw digits; the separators appear
 * when focus leaves. An on-keystroke mask has to re-place the caret after
 * every insertion — type `1234567`, and a mask that inserts a comma after
 * `1,234` moves the caret out from under the next keystroke unless it
 * recomputes the offset, which is the bug every hand-rolled money input has.
 * Nothing here touches the caret, because while you are typing there is
 * nothing in the field but what you typed.
 *
 * Focus selects the current contents. The text genuinely changes on focus
 * (`4,200,000` → `4200000`), so a caret placed by the click would land a
 * character or two off from where it was aimed; selecting is both the honest
 * answer to "where should the caret go" and what makes click-and-retype one
 * gesture. `DateInput` is exempt — it never reformats, and `select()` throws
 * on a date input.
 *
 * ## What `parse` replaces
 *
 * These are `type="text"` (a `type="number"` input cannot render `4,200,000`),
 * so the browser no longer sanitizes the field's contents for us.
 * `formCodec.ts:42-48` notes that `num` can only ever see numeric text
 * *because* every numeric field is `type="number"`, and calls relying on that
 * "relying on the markup of 19 call sites staying correct forever". `parse`
 * makes it explicit instead of incidental: what reaches form state is digits
 * (plus one decimal point where fractions are meaningful), whatever was typed,
 * pasted or dictated. Losing the spinner and the scroll-wheel-eats-your-value
 * behaviour of `type="number"` is a bonus.
 */

export interface FormattedInputProps {
  /** Raw value as the form holds it — digits, not the formatted rendering. */
  value: string;
  /** Called with the raw value. Never called with a formatted string. */
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /**
   * Passed straight through, for the add-a-row toolbars that submit on Enter
   * (`BuildingsCard`). Shared by all six so it doesn't break the swap-in-one-
   * word property.
   */
  onKeyDown?: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
}

/**
 * Digits and at most one decimal point, in the order typed. The first `.`
 * survives and later ones are dropped, so holding the key down can't produce
 * `1..5`.
 *
 * No sign and no exponent, deliberately: nothing these components edit can be
 * negative (money, a percentage, a count, a year), and `Number("1e9")` is a
 * billion — a stray `e` between two digits would otherwise write a number
 * three orders of magnitude off the one on screen.
 */
export function parseDecimal(typed: string): string {
  let seenDot = false;
  let out = "";
  for (const ch of typed) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (ch === "." && !seenDot) {
      seenDot = true;
      out += ch;
    }
  }
  return out;
}

/** Digits only — for the fields where a fraction is meaningless. */
export function parseDigits(typed: string): string {
  return typed.replace(/\D/g, "");
}

/**
 * Thousands separators on the integer part, with any typed fraction appended
 * **verbatim**.
 *
 * The fraction is not run through `fmtNum` because `toLocaleString` rounds at
 * three fraction digits: a stored `1234.5678` would render `1,234.568`, and a
 * field that shows a different number from the one it will save is worse than
 * one that shows no separators at all. Passing the fraction through also keeps
 * a half-typed `1234.` and a deliberate `1234.50` intact.
 *
 * Empty in, empty out — `fmtNum`'s `"—"` is right for a table cell and wrong
 * for an input the user is about to type into.
 */
export function groupDigits(raw: string): string {
  const t = raw.trim();
  if (t === "") return "";
  const dot = t.indexOf(".");
  const head = dot === -1 ? t : t.slice(0, dot);
  const tail = dot === -1 ? "" : t.slice(dot);
  return (head === "" ? "" : fmtNum(Number(head))) + tail;
}

interface BaseProps extends FormattedInputProps {
  /** Raw → what the field shows once focus leaves. */
  format: (raw: string) => string;
  /** What was typed → what form state holds. */
  parse: (typed: string) => string;
  /**
   * Write `format(value)` back through `onChange` on blur, making the
   * formatted string the stored one. Only `PhoneInput` does this: a phone
   * column holds text, so `(555) 123-4567` *is* the value. A money column
   * holds a number, so committing `4,200,000` would store `null`.
   */
  commitOnBlur?: boolean;
  inputMode: "numeric" | "decimal" | "tel";
  type: "text" | "tel";
}

function FormattedInput({
  value,
  onChange,
  disabled,
  placeholder,
  onKeyDown,
  format,
  parse,
  commitOnBlur = false,
  inputMode,
  type,
}: BaseProps) {
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  // Selecting inside `onFocus` doesn't hold: the focus also swaps the field's
  // text from formatted to raw, and React writing a new `value` collapses the
  // selection to the end. The effect runs after that write, so it is selecting
  // the text the user will actually be editing.
  useEffect(() => {
    if (focused) ref.current?.select();
  }, [focused]);

  return (
    <input
      ref={ref}
      type={type}
      inputMode={inputMode}
      disabled={disabled}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
      value={focused ? value : format(value)}
      onChange={(e) => onChange(parse(e.target.value))}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        // Guarded on inequality so that tabbing through an untouched field
        // can't fire `onChange` — which would call the form's `onEdit`, mark
        // it dirty and clear a "Saved." confirmation nobody had invalidated.
        if (commitOnBlur) {
          const next = format(value);
          if (next !== value) onChange(next);
        }
      }}
    />
  );
}

/** `4200000` → `4,200,000`. Cents only if the user typed them. Store with `num()`. */
export function MoneyInput(props: FormattedInputProps) {
  return (
    <FormattedInput
      {...props}
      format={groupDigits}
      parse={parseDecimal}
      inputMode="decimal"
      type="text"
    />
  );
}

/** `80` → `80%`. Store with `num()` — the `%` never reaches the value. */
export function PercentInput(props: FormattedInputProps) {
  return (
    <FormattedInput
      {...props}
      format={(raw) => (raw.trim() === "" ? "" : `${groupDigits(raw)}%`)}
      parse={parseDecimal}
      inputMode="decimal"
      type="text"
    />
  );
}

/** `1234` → `1,234`, whole numbers only. Store with `num()`. */
export function IntegerInput(props: FormattedInputProps) {
  return (
    <FormattedInput
      {...props}
      format={groupDigits}
      parse={parseDigits}
      inputMode="numeric"
      type="text"
    />
  );
}

/**
 * `1985` stays `1985`. A year is a label, not a quantity — `1,985` is what
 * `IntegerInput` would make of it, and this component exists so that reaching
 * for the wrong one is a visible mistake rather than a silent one.
 */
export function YearInput(props: FormattedInputProps) {
  return (
    <FormattedInput
      {...props}
      format={(raw) => raw}
      parse={parseDigits}
      inputMode="numeric"
      type="text"
    />
  );
}

/**
 * `5551234567` → `(555) 123-4567`, and an extension or an international number
 * through untouched. See `normalizePhone` for which is which and why.
 *
 * The one component that stores what it displays: the column is freeform text
 * (`a.phone()` accepts only E.164, which this agency's numbers are not), so
 * the formatted string is the value. Typing is never interfered with —
 * `parse` is identity, because a mask that reshaped input on the way in is
 * exactly what would eat the `x` of `x212`. Store with `str()`.
 */
export function PhoneInput(props: FormattedInputProps) {
  return (
    <FormattedInput
      {...props}
      format={normalizePhone}
      parse={(typed) => typed}
      commitOnBlur
      inputMode="tel"
      type="tel"
    />
  );
}

/**
 * The native day picker, unchanged — the browser already renders an ISO day in
 * the reader's locale and hands back `YYYY-MM-DD`, which is what `a.date()`
 * stores. It takes the same props as the other five so a form's fields read
 * alike and none of them is the odd one out. Store with `str()`.
 */
export function DateInput({
  value,
  onChange,
  disabled,
  placeholder,
  onKeyDown,
}: FormattedInputProps) {
  return (
    <input
      type="date"
      disabled={disabled}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * A Yes/No pair of radios, with "not answered" as a real third state.
 *
 * The one input here that is not a text field, and it exists for the same
 * reason the rest do: the obvious control is wrong. A checkbox has two states
 * and an application question has three — yes, no, and nobody has asked — and
 * on a form that goes to a carrier the difference between "No" and blank is
 * the difference between an answer and a silence.
 *
 * `value` is `""` / `"yes"` / `"no"`, which is what `bool` and `boolValue` in
 * `formCodec` consume and produce. Clicking the selected option again clears
 * it back to unanswered; there is otherwise no way back to blank once either
 * radio has been picked.
 */
export function YesNoRadio({
  value,
  onChange,
  disabled,
  name,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Radio group name — must be unique on the page. */
  name: string;
}) {
  return (
    <div className="chip-row" role="radiogroup" aria-label={name}>
      {[
        ["yes", "Yes"],
        ["no", "No"],
      ].map(([v, label]) => (
        <label
          key={v}
          className="small"
          style={{ display: "flex", gap: 4, alignItems: "center" }}
        >
          <input
            type="radio"
            name={name}
            value={v}
            checked={value === v}
            disabled={disabled}
            // `onClick` rather than `onChange`: React fires no change event
            // when the already-checked radio is clicked, which is exactly the
            // gesture that has to clear it.
            onClick={() => onChange(value === v ? "" : v)}
            onChange={() => {}}
          />
          {label}
        </label>
      ))}
    </div>
  );
}
