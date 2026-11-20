import { convert } from "html-to-text";
import { customerAgencyCopy, customerEmailIdentity } from "../../../../shared/customerEmailIdentity";

/** Keep verified Front contact/licensing text; omit opaque image wordmarks. */
export function californiaSignature(signatureHtml: string, producerName: string) {
  const identity = customerEmailIdentity("CA");
  const original = convert(signatureHtml, {
    wordwrap: false,
    selectors: [{ selector: "img", format: "skip" }, { selector: "a", options: { hideLinkHrefIfSameAsText: true } }],
  });
  // A mixed text/image signature can otherwise pass with just the producer's name.
  const email = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(original);
  const phone = /(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/.test(original);
  // A phone on the next line cannot stand in for an image-only license number.
  const license = /\b(?:licen[sc]e|lic\.?)(?:[ \t]+(?:no\.?|number))?[ \t]*[:#]?[ \t]*[A-Z0-9-]*\d[A-Z0-9-]*\b/i.test(original);
  if (!email || !phone || !license) throw new Error("The California email needs a text signature with the salesperson's email, phone, and license number in Front; image-only details cannot be retained.");
  let text = customerAgencyCopy(original.replaceAll(identity.disclosure, ""), "CA").trim();
  if (!text.includes(producerName)) text = producerName + "\n" + text;
  if (!/Condo Insurance Agency/i.test(text)) text += "\n" + identity.displayName;
  const escape = (value: string) => value.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  // Rebuild only safe visible destinations; never reuse Front's HTML or attributes.
  const destinations = /https?:\/\/[^\s<>"\[\]]+|tel:\+?[0-9][0-9(). -]*[0-9]|[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  let html = "", position = 0;
  for (const match of text.matchAll(destinations)) {
    const label = match[0];
    const at = label.lastIndexOf("@");
    const href = /^(?:https?:|tel:)/i.test(label) ? label : `mailto:${encodeURIComponent(label.slice(0, at))}@${label.slice(at + 1)}`;
    html += escape(text.slice(position, match.index)) + `<a href="${escape(href)}">${escape(label)}</a>`;
    position = match.index + label.length;
  }
  html += escape(text.slice(position));
  return { text, html: '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1A1A1A">' + html.replace(/\n/g, "<br>") + "</div>" };
}
