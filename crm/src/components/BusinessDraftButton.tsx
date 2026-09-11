import { useEffect, useRef, useState } from "react";
import { communicationRequest as request } from "../lib/communications";

type Draft = { channelId: string; originalMessageId: string; recipient: string; subject: string; body: string; attachments: { filename: string; url: string; contentType: string }[] };
export default function BusinessDraftButton({ accountId, conversationId, kind, recordId, label }: { accountId: string; conversationId: string; kind: "QUOTE" | "CERTIFICATE" | "DOCUMENT"; recordId: string; label: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const live = useRef(true); useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  return <><button className="secondary" disabled={busy} onClick={async () => {
    setBusy(true); setError("");
    try {
      const { draft } = await request<{ draft: Draft }>("prepareBusinessDraft", { accountId, conversationId, kind, recordId }, true);
      const files = await Promise.all(draft.attachments.map(async a => { const r = await fetch(a.url); if (!r.ok) throw new Error("Could not load the document for delivery"); return new File([await r.blob()], a.filename, { type: a.contentType }); }));
      if (!live.current) return;
      // The account page also imports this component. Initialize Front's bridge
      // only inside its sidebar when someone actually prepares a draft.
      const { default: Front } = await import("@frontapp/plugin-sdk");
      if (!live.current) return;
      await Front.createDraft({ channelId: draft.channelId as Parameters<typeof Front.createDraft>[0]["channelId"], replyOptions: { type: "reply", originalMessageId: draft.originalMessageId as NonNullable<Parameters<typeof Front.createDraft>[0]["replyOptions"]>["originalMessageId"] }, to: [draft.recipient], cc: [], bcc: [], subject: draft.subject, content: { type: "html", body: draft.body }, attachments: files });
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : "Could not prepare the Front draft"); } finally { if (live.current) setBusy(false); }
  }}>{busy ? "Preparing…" : label}</button>{error && <p className="error-text" role="alert">{error}</p>}</>;
}
