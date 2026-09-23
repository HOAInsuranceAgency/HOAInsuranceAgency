import { useLayoutEffect, useRef, type InputHTMLAttributes } from "react";

/** Group the integer portion without rounding decimals or changing the stored value. */
export function formatNumberInput(value: string): string {
  const [integer, fraction] = value.split(".");
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction === undefined ? "" : `.${fraction}`);
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
};

/** Display thousands separators while keeping form state and submissions comma-free. */
export default function NumberField({ value, onChange, inputMode = "decimal", ...props }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const cursor = useRef<number | null>(null);
  const display = formatNumberInput(value);

  useLayoutEffect(() => {
    if (cursor.current === null || !input.current) return;
    // Restore the position relative to digits, including edits next to inserted commas.
    let position = 0;
    let characters = 0;
    while (position < display.length && characters < cursor.current) {
      if (display[position] !== ",") characters++;
      position++;
    }
    input.current.setSelectionRange(position, position);
    cursor.current = null;
  });

  return <input
    {...props}
    ref={input}
    type="text"
    inputMode={inputMode}
    value={display}
    onChange={(event) => {
      const entered = event.currentTarget.value;
      const normalized = entered.replace(/,/g, "");
      // Retain incomplete decimal/sign edits, but do not turn invalid pasted text into a price.
      if (!/^-?\d*(?:\.\d*)?$/.test(normalized)) return;
      cursor.current = entered.slice(0, event.currentTarget.selectionStart ?? entered.length).replace(/,/g, "").length;
      onChange(normalized);
    }}
  />;
}
