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
  const email = /[A-Z0-9.!#$%&'*+/=?^`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(original);
  const phone = /(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/.test(original);
  const license = /\b(?:licen[sc]e|lic\.?)(?:\s+(?:no\.?|number))?\s*[:#]?\s*[A-Z0-9-]*\d[A-Z0-9-]*\b/i.test(original);
  if (!email || !phone || !license) throw new Error("The California email needs a text signature with the salesperson's email, phone, and license number in Front; image-only details cannot be retained.");
  let text = customerAgencyCopy(original.replaceAll(identity.disclosure, ""), "CA").trim();
  if (!text.includes(producerName)) text = producerName + "\n" + text;
  if (!/Condo Insurance Agency/i.test(text)) text += "\n" + identity.displayName;
  const escape = (value: string) => value.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  return { text, html: '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1A1A1A">' + escape(text).replace(/\n/g, "<br>") + "</div>" };
}
