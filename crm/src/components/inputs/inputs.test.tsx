import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// The components import `fmtNum` and `normalizePhone` from ./lib/client, which
// calls generateClient() at module scope. Stubbing the client rather than the
// module keeps client.ts's real formatters — which is the point, since these
// components are supposed to be reusing them.
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: {} }),
}));

import {
  DateInput,
  FeinInput,
  IntegerInput,
  MoneyInput,
  PercentInput,
  PhoneInput,
  YearInput,
  groupDigits,
  parseDecimal,
  parseDigits,
  type FormattedInputProps,
} from ".";

/**
 * The formatted inputs, tested through the contract that matters: what the
 * field *shows* and what the form *stores* are two different strings, and the
 * write boundary only ever sees the second one.
 *
 * Rendered inside a controlled harness because that is how every real caller
 * uses them — a component that formats on blur but is fed a stale `value`
 * would pass a shallower test and fail in a form.
 */
function Harness({
  Component,
  initial = "",
  onChange,
}: {
  Component: (p: FormattedInputProps) => JSX.Element;
  initial?: string;
  onChange?: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <Component
        value={value}
        onChange={(v) => {
          onChange?.(v);
          setValue(v);
        }}
      />
      {/* What a save would write. */}
      <output data-testid="stored">{value}</output>
    </>
  );
}

const stored = () => screen.getByTestId("stored").textContent;
const field = () => screen.getByRole("textbox");

describe("parse helpers", () => {
  it("parseDecimal keeps digits and the first decimal point", () => {
    expect(parseDecimal("4200000")).toBe("4200000");
    expect(parseDecimal("$4,200,000.50")).toBe("4200000.50");
    expect(parseDecimal("1.2.3")).toBe("1.23");
    expect(parseDecimal("12a3")).toBe("123");
  });

  it("parseDecimal drops the characters that would change the magnitude", () => {
    // `Number("1e9")` is a billion, and `-` has no meaning in any field these
    // components edit.
    expect(parseDecimal("1e9")).toBe("19");
    expect(parseDecimal("-500")).toBe("500");
  });

  it("parseDigits keeps digits only", () => {
    expect(parseDigits("1,234")).toBe("1234");
    expect(parseDigits("12.5")).toBe("125");
  });

  it("groupDigits leaves a typed fraction exactly as typed", () => {
    // Not `fmtNum(Number(raw))`: toLocaleString rounds at three fraction
    // digits, so that would show 1,234.568 for a value that saves as 1234.5678.
    expect(groupDigits("1234.5678")).toBe("1,234.5678");
    expect(groupDigits("1234.50")).toBe("1,234.50");
    expect(groupDigits("1234.")).toBe("1,234.");
  });

  it("groupDigits maps empty to empty, not to an em dash", () => {
    expect(groupDigits("")).toBe("");
    expect(groupDigits("   ")).toBe("");
  });
});

describe("MoneyInput", () => {
  it("stores the raw digits and shows them grouped once focus leaves", async () => {
    const user = userEvent.setup();
    render(<Harness Component={MoneyInput} />);

    await user.type(field(), "4200000");
    // While focused: no separators to fight the caret.
    expect(field()).toHaveValue("4200000");

    await user.tab();
    expect(field()).toHaveValue("4,200,000");
    // The bit that matters — `num()` still sees a number.
    expect(stored()).toBe("4200000");
    expect(Number(stored())).toBe(4200000);
  });

  it("shows the raw digits again when the field is focused", async () => {
    const user = userEvent.setup();
    render(<Harness Component={MoneyInput} initial="4200000" />);
    expect(field()).toHaveValue("4,200,000");

    await user.click(field());
    expect(field()).toHaveValue("4200000");
  });

  it("selects the value on focus, so click-and-retype is one gesture", async () => {
    const user = userEvent.setup();
    render(<Harness Component={MoneyInput} initial="4200000" />);

    await user.click(field());
    await user.keyboard("500");
    expect(stored()).toBe("500");
  });

  it("refuses everything that isn't a number", async () => {
    const user = userEvent.setup();
    render(<Harness Component={MoneyInput} />);

    await user.type(field(), "12a3");
    expect(stored()).toBe("123");
  });

  it("does not round or reformat cents the user typed", async () => {
    const user = userEvent.setup();
    render(<Harness Component={MoneyInput} />);

    await user.type(field(), "1234.50");
    await user.tab();
    expect(field()).toHaveValue("1,234.50");
    expect(stored()).toBe("1234.50");
  });
});

describe("PercentInput", () => {
  it("appends a percent sign that never reaches the value", async () => {
    const user = userEvent.setup();
    render(<Harness Component={PercentInput} />);

    await user.type(field(), "80");
    await user.tab();
    expect(field()).toHaveValue("80%");
    expect(stored()).toBe("80");
  });

  it("shows nothing at all for a blank field", () => {
    render(<Harness Component={PercentInput} />);
    expect(field()).toHaveValue("");
  });
});

describe("IntegerInput", () => {
  it("groups thousands and ignores a decimal point", async () => {
    const user = userEvent.setup();
    render(<Harness Component={IntegerInput} />);

    await user.type(field(), "12.5");
    expect(stored()).toBe("125");

    await user.clear(field());
    await user.type(field(), "11000");
    await user.tab();
    expect(field()).toHaveValue("11,000");
    expect(stored()).toBe("11000");
  });
});

describe("YearInput", () => {
  it("shows a year without a thousands separator", async () => {
    const user = userEvent.setup();
    render(<Harness Component={YearInput} />);

    await user.type(field(), "1985");
    await user.tab();
    expect(field()).toHaveValue("1985");
    expect(stored()).toBe("1985");
  });

  it("differs from IntegerInput on exactly that point", async () => {
    const user = userEvent.setup();
    render(<Harness Component={IntegerInput} />);
    await user.type(field(), "1985");
    await user.tab();
    expect(field()).toHaveValue("1,985");
  });
});

describe("PhoneInput", () => {
  const phone = () => screen.getByRole("textbox");

  it("stores the formatted number for a plain 10-digit entry", async () => {
    const user = userEvent.setup();
    render(<Harness Component={PhoneInput} />);

    await user.type(phone(), "5551234567");
    await user.tab();
    // The column is freeform text, so the formatted string *is* the value.
    expect(stored()).toBe("(555) 123-4567");
    expect(phone()).toHaveValue("(555) 123-4567");
  });

  it("leaves an extension and an international number alone", async () => {
    const user = userEvent.setup();
    render(<Harness Component={PhoneInput} />);

    await user.type(phone(), "555-123-4567 x212");
    await user.tab();
    expect(stored()).toBe("555-123-4567 x212");

    await user.clear(phone());
    await user.type(phone(), "+44 20 7123 4567");
    await user.tab();
    expect(stored()).toBe("+44 20 7123 4567");
  });

  it("leaves a 7-digit local number alone", async () => {
    const user = userEvent.setup();
    render(<Harness Component={PhoneInput} />);

    await user.type(phone(), "123-4567");
    await user.tab();
    expect(stored()).toBe("123-4567");
  });

  it("does not fire onChange when a field is merely tabbed through", async () => {
    // It would run the form's `onEdit`, mark it dirty, and clear a "Saved."
    // confirmation that nothing had invalidated.
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness Component={PhoneInput} initial="(555) 123-4567" onChange={onChange} />
    );

    await user.click(phone());
    await user.tab();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("FeinInput", () => {
  const fein = () => screen.getByRole("textbox");

  it("stores the hyphenated number for nine digits", async () => {
    const user = userEvent.setup();
    render(<Harness Component={FeinInput} />);

    await user.type(fein(), "045551234");
    await user.tab();
    // The column is text and the hyphen is how the number is printed on a W-9
    // and typed into a carrier portal, so the hyphen *is* the value.
    expect(stored()).toBe("04-5551234");
  });

  it("accepts a number that already has its hyphen", async () => {
    const user = userEvent.setup();
    render(<Harness Component={FeinInput} />);

    await user.type(fein(), "04-5551234");
    await user.tab();
    expect(stored()).toBe("04-5551234");
  });

  it("leaves anything that is not nine digits exactly as typed", async () => {
    // A part-entered number must not be reshaped mid-thought, and a foreign
    // or malformed identifier somebody has a reason for is not ours to fix.
    const user = userEvent.setup();
    render(<Harness Component={FeinInput} />);

    await user.type(fein(), "0455");
    await user.tab();
    expect(stored()).toBe("0455");
  });

  it("does not fire onChange when a field is merely tabbed through", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness Component={FeinInput} initial="04-5551234" onChange={onChange} />);

    await user.click(fein());
    await user.tab();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("DateInput", () => {
  it("passes an ISO day straight through", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness Component={DateInput} />);
    const input = container.querySelector("input[type=date]")!;

    await user.type(input, "2026-03-01");
    expect(stored()).toBe("2026-03-01");
  });
});
