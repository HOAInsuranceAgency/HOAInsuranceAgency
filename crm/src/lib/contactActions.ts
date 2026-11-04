/** Build explicit, user-initiated contact links without guessing malformed data. */
export function phoneActions(value: string | null | undefined) {
  const raw = value?.trim();
  if (!raw) return null;
  const match = /^(.*?)(?:\s*(?:ext(?:ension)?\.?|x|#)\s*(\d{1,8}))?$/i.exec(raw);
  if (!match || !/^[+\d\s().-]+$/.test(match[1])) return null;
  const base = match[1].trim(), digits = base.replace(/\D/g, "");
  const number = /^\+[1-9]\d{7,14}$/.test(base.replace(/[\s().-]/g, ""))
    ? `+${digits}`
    : !base.includes("+") && digits.length === 10 ? `+1${digits}`
      : !base.includes("+") && digits.length === 11 && digits.startsWith("1") ? `+${digits}` : null;
  if (!number) return null;
  const extension = match[2];
  return {
    tel: `tel:${number}${extension ? `;ext=${extension}` : ""}`,
    // Dialpad's launch URL has no documented extension parameter. Keep the
    // extension in the telephone link instead of silently dialing another number.
    dialpad: extension ? null : `https://dialpad.com/launch?phone=${encodeURIComponent(number)}`,
  };
}

export function emailAction(value: string | null | undefined) {
  const email = value?.trim();
  if (!email || /[\u0000-\u0020\u007f]/.test(email) || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return null;
  return `mailto:${encodeURIComponent(email).replace(/%40/g, "@")}`;
}
