import { convert } from "html-to-text";
import { customerAgencyCopy, customerEmailIdentity } from "../../../../shared/customerEmailIdentity";

/** Keep verified Front contact/licensing text; omit opaque image wordmarks. */
export function californiaSignature(signatureHtml: string, producerName: string) {
  const identity = customerEmailIdentity("CA");
  const original = convert(signatureHtml, {
    wordwrap: false,
    selectors: [{ selector: "img", format: "skip" }, { selector: "a", options: { ignoreHref: true } }],
  });
  if (!original.trim()) throw new Error("The California email needs a text signature with the salesperson's contact and license details in Front.");
  let text = customerAgencyCopy(original.replaceAll(identity.disclosure, ""), "CA").trim();
  if (!text.includes(producerName)) text = producerName + "\n" + text;
  if (!/Condo Insurance Agency/i.test(text)) text += "\n" + identity.displayName;
  const escape = (value: string) => value.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  return { text, html: '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1A1A1A">' + escape(text).replace(/\n/g, "<br>") + "</div>" };
}
