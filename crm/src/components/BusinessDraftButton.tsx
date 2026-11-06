import { Button } from "./ui/Button";
import { useState } from "react";
import type { BusinessDeliveryKind } from "../../../shared/frontBusinessDelivery";
import BusinessDeliveryComposer from "./BusinessDeliveryComposer";

export interface BusinessDraftButtonProps {
  accountId: string;
  conversationId?: string;
  kind?: BusinessDeliveryKind;
  recordId?: string;
  label?: string;
  disabled?: boolean;
}

/** The same server-backed handoff works in the CRM and Front's sidebar. */
export default function BusinessDraftButton(props: BusinessDraftButtonProps) {
  return <BusinessDraftButtonContent key={`${props.accountId}:${props.conversationId ?? ""}:${props.kind ?? ""}:${props.recordId ?? ""}`} {...props} />;
}

function BusinessDraftButtonContent({ label = "Prepare email in Front", disabled, ...selection }: BusinessDraftButtonProps) {
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="secondary" type="button"  disabled={disabled} onClick={() => setOpen(true)}>{label}</Button>
    {open && <BusinessDeliveryComposer {...selection} onClose={() => setOpen(false)} />}
  </>;
}
