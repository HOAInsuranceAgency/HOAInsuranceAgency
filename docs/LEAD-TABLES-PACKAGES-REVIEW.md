# Lead tables and quote packages

Prepared September 15, 2026. Implemented locally; not deployed.

Open **LEAD-TABLES-PACKAGES-PREVIEW.html** in a browser for the fictional review workspace. The preview uses the actual table and package components with sample data. It cannot send messages, bind coverage, or change real records. Reloading resets the sample changes. Its examples use September 2026 dates.

## What changes for the team

- **Leads:** salesperson, deal champion, website form, estimated opportunity, and pending commission are visible in the table. Filter by either assigned person. The dashboard lead work list also includes these fields; the follow-up action list shows both assigned people alongside its existing last-contact time.
- **Leads and Clients:** City and State have separate sortable columns. Table downloads include the displayed fields and current filters.
- **Website form:** shows Quote form, Contact form, Coverage calculator, Instant assessment, or Association / HO-6 form. This is separate from Google Ad Website versus Organic Website. Existing records use their saved form source; missing historical information stays “Not recorded.”
- **Estimated opportunity:** a manual estimate of the agency's commission. Click the amount or “Add estimate,” enter dollars, and Save. Cancel leaves the saved value unchanged. Blank means no estimate; zero is a valid estimate. Cents are preserved.
- **Pending commission:** comes from complete, reviewed quote packages. A package may be one bundled quote or several whole quotes. The estimate remains separate and is never overwritten by the quote calculation.

## How packages work

In the account's Quotes screen, add a package option, choose the coverages needed, and select the whole quotes that form that option. Review their terms and carrier requirements together. The system checks recorded coverage lines, carrier and policy dates, offer status, expiry, and commission information. The champion still determines whether limits, exclusions, layers, and carrier requirements are compatible.

All options for one account use the same coverage needs. A bundled quote is counted once and is never split. Quotes in an option must have matching policy terms. Draft or incomplete options can be saved but do not enter the pending forecast.

Before a client chooses, pending commission is the **lowest commission among complete, reviewed options**. For example:

| Option | Contents | Agency commission |
|---|---|---:|
| Bundled | Property and D&O in one quote | $1,500 |
| Separate | Property $1,100 plus D&O $250 | $1,350 |

The table shows **$1,350 — Lowest complete package**. A D&O-only quote cannot understate that forecast because it does not cover the required property insurance.

When the client chooses, click **Client chose this option**. Pending commission then follows that selected option. This records their choice; it does not bind insurance or send a message. Continue the existing client authorization and carrier-confirmation steps for each selected quote.

Changed terms invalidate the package review. Changing a selected package's included quotes or coverage needs requires renewed client selection. A package that has started binding cannot be cleared or replaced in a way that abandons its authorized or bound policies.

As individual policies bind, their commission leaves the pending amount. The account stays in the Leads table with **Binding in progress** until every selected quote is bound. A champion reminder tracks the unfinished package, including when a remaining offer is withdrawn. Alternatives from the unselected packages no longer drive sales work. Existing quotes without package options continue using the existing quote workflow; their pending commission stays blank until the team reviews an option.

## Review walkthrough

1. **Leads table:** find Willow Court. Expect Avery Brooks, Morgan Lane, Boston and MA in separate columns, Google Ad Website, Quote form, a $1,800 estimate, and $1,350 pending.
2. **Owner filters:** select Morgan Lane as salesperson. Expect no matching sample leads. Restore All salespeople. Select Morgan as champion; the sample leads return.
3. **Estimate:** open Pine Grove's estimate. Enter $987.65 and Cancel; it stays blank. Enter $1,250.50 and Save; expect that exact amount. This must not open the account or change pending commission.
4. **Package choice:** open Package options. Choose the bundled option. Expect $1,500 pending with “Client-selected package.” Clear the selection before any binding; expect $1,350 again.
5. **Incomplete option:** add a D&O-only option while Property and D&O are needed. Marking it reviewed must fail with “Missing Property.” Save it without the review checkbox; it remains incomplete and does not lower the $1,350 forecast.
6. **Partial binding:** Cedar House is already a client with one of two policies bound. Expect it in both Clients and Leads, with $250 pending and “Binding in progress” in Leads.
7. **Clients:** City and State remain separate. Cedar's renewal comes from its active policy.
8. **Dashboard and exports:** check owner names, form, location, both commission columns and last contact. Download the lead work list. Columns and amounts must agree with the current filtered table.

Before release, repeat against staging with persisted records: two users editing the same estimate; a quote amended after package review; client selection and authorization; one policy bound, then the remaining policy bound; and a withdrawn remaining offer. The local checks validate these state transitions, but do not replace a connected staging bind test.

## Test-lead cleanup safeguards

Identifiable production cleanup candidates are retained privately. This implementation does not authorize deletion of any particular production record. Before an approved cleanup, recheck each candidate for quotes, documents, invoices, policies and linked communications. Internal addresses on genuine properties and real duplicate leads are not sufficient evidence that a record is a test.

The updated deletion flow checks for policies, billing, and delivery uncertainty before removing a lead. It deletes the lead's contacts with its quotes/documents, retires queued work in resumable batches, and prevents future sends from acquiring a lease for a deleted account. A send already accepted by a provider cannot be recalled; its delivery result is preserved for review. Deleting a CRM lead does not delete its historical Front conversations.

## Verification and rollout

- 2,245 tests passed across 112 files, including package calculation, selection, scope changes, partial binding, withdrawn offers, deletion cleanup over multiple pages, and a deletion during send preparation.
- Frontend and backend typechecks, CRM build (including Front sidebar), and backend synthesis passed.
- Chrome verified the running fictional preview: owner filtering, estimate Save/Cancel, complete versus incomplete packages, client choice, partial-binding visibility, client location columns, and dashboard fields.
- The standalone HTML compiled successfully. Chrome's automation policy blocks opening local file URLs, so that file's direct-open check was not completed through automation.
- No new data tables, schema migration, or website deployment are required. Deploy the CRM backend and frontend together using the existing pipeline. Existing leads inherit the new columns from their current assignments and saved sources; no historical attribution is invented.
- Keep the prior reminder-review changes in the deployment; these changes build on that local commit.
