/** Editable local input only: Google Places is never loaded by this preview. */
export function AddressAutocomplete({ value, onChange, placeholder, id, 'aria-label': ariaLabel }: {
  value: string; onChange: (value: string) => void;
  onPlace: (parts: { address: string; city: string; state: string; zip: string }) => void;
  placeholder?: string; id?: string; 'aria-label'?: string;
}) {
  return <input id={id} aria-label={ariaLabel} value={value} placeholder={placeholder ?? 'Start typing an address…'} onChange={event => onChange(event.target.value)} />;
}
