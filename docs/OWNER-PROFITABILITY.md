# Employee profitability

The **Profitability** navigation item is available only in the Owner view.
Owners retain all Admin permissions. Admins, Staff, and Producers cannot read
or change compensation, including through direct API calls. See
[Owner access](OWNER-ACCESS.md) for the first Owner's deployment setup.

## Report basis

The initial report estimates insurance contribution for an inclusive date range
(year to date by default), using each policy's effective date:

1. Agency commission = policy premium × agency commission percentage.
2. Producer share = agency commission × the employee's commission share on
   that policy's effective date.
3. Net revenue = agency commission − producer share.
4. Estimated contribution = net revenue − salary prorated for the report period.

Example: $100,000 premium at 10% agency commission yields $10,000 commission.
A 25% producer share leaves $7,500 for the agency. If salary for the selected
period is $5,000, estimated contribution is $2,500.

Revenue is attributed to the account's **current salesperson**. Reassigning an
account changes this estimate for past periods; the CRM does not yet preserve
historical producer attribution. Salary and commission rates themselves are
dated, so pay changes do not retroactively replace earlier rates.

Cancelled policies are excluded. This is not cash accounting or full firm net
profit: carrier receipts, cancellation adjustments, fees, finance interest,
benefits, payroll taxes, and other overhead are not included. The current CRM
does not provide a complete carrier commission receipt ledger.

## Entering compensation

Open **Manage pay settings**, choose an employee, and enter dated annual salary
and commission share periods. The share is a percentage of agency commission,
not a percentage of premium. No salary or commission-share amounts are seeded.

- Use the actual employment/pay start date. The initial suggested date is the
  report start date and should be corrected when necessary.
- The last day is inclusive. Leave it blank for ongoing employment/rates.
- Close the previous period before adding a new rate; overlaps are rejected.
- Enter explicit zero amounts for salary-free or commission-free arrangements.
- Salary uses calendar days and the actual 365/366-day year, rounded once per
  employee/report. Days before the first period and after the final closed
  period are outside employment. Internal gaps are incomplete data; enter a
  zero-salary period to represent unpaid leave.
- Saving no periods removes compensation setup. It does not mean zero pay.

All assignment-eligible salespeople, employees with compensation setup, and
salespeople attributed policies in the selected period appear. Non-producing
staff can be included by entering salary with a zero commission share.

Missing policy commission, undated policies, missing pay periods, and unassigned
policies are called out. Unknown amounts remain blank/“Incomplete,” with known
partial subtotals clearly labeled. The CSV and PDF exports use the same
date range, calculation basis, and completeness rules as the dashboard.

## Storage and operations

Compensation and its audit trail live in a dedicated encrypted DynamoDB table
with point-in-time recovery and retention on deletion. They never enter shared
team profiles, general activity records, or account communication storage.
Current compensation and audit history occupy separate key partitions, allowing
strongly consistent compensation reads without scanning the audit history.

Every save uses an optimistic version check and writes the previous/current
record plus verified actor in the same transaction. Concurrent edits cannot
silently overwrite each other. Private state is discarded when the active role
changes or a data refresh fails.

The API follows all source pages and retries account-assignment batch reads. It
fails the report if a source cannot be read or the bounded snapshot is too large,
instead of displaying incomplete source data as complete totals. Policy and
profile snapshots currently scan their source tables (200 pages/25,000 returned
records maximum); larger agencies will need an indexed reporting projection.

No schedules, outbound messages, production salary values, or Owner memberships
are created by this feature.
