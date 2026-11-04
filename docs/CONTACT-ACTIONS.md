# Contact actions

Account contacts and the Front sidebar offer clickable email/telephone values,
an **Open in Dialpad** link for supported phone numbers, and **Copy** buttons.
Email and telephone links use the teammate's configured default applications.
The Dialpad link uses its documented HTTPS launch URL without the automatic
dial suffix; the teammate reviews and places the call in Dialpad.

US numbers normalize to `+1`, and explicit international country codes remain
unchanged. Extensions are preserved in telephone links; Dialpad links are
omitted for extensions because its launch URL does not document that parameter.
Malformed values remain selectable and copyable instead of becoming broken
links. Clipboard failures ask the teammate to select and copy the text.

These actions do not send emails or initiate calls from the CRM backend. No new
provider credentials or permissions are needed. Existing Front/Dialpad logging
continues to depend on the agency's connected business channels.

Reference: [Dialpad click-to-call formats](https://help.dialpad.com/hc/en-us/articles/55183481633051-Enable-Click-to-Call-on-Third-Party-Apps).
