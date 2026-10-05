# Owner access

`OWNER` is an independent Cognito group. Its active view has all administrator
permissions plus the private employee profitability dashboard. An Owner does
not need an `ADMIN` membership for normal administration. Other assigned views
remain restricted: switching an Owner to Producer removes administrative and
profitability access until the Owner view is selected again.

Cognito membership is authoritative. The `UserProfile.role` field is only a
display mirror and must never be used to grant Owner access. Compensation must
remain outside UserProfile and other shared team records.

## First Owner after deployment

The new group is created by the deployment, with no automatic memberships. An
existing administrator cannot promote themselves or another member to Owner.
A deployment operator must bootstrap the first explicitly designated Owner in
the intended environment:

1. Verify the AWS account, region, Amplify branch, and Cognito user pool for the
   intended staging or production environment. Each environment has its own
   user pool; do not reuse a pool ID from another environment.
2. Look up the designated existing user by their verified email. Confirm their
   Cognito `sub` and canonical username before changing membership.
3. Use Cognito's **Add user to group** action to add that exact user to `OWNER`.
   Preserve their other memberships. The equivalent AWS CLI operation is
   `cognito-idp admin-add-user-to-group` with the verified pool, username, region,
   and `--group-name OWNER`.
4. Have the user sign out and sign back in so their Cognito token includes the
   new membership. If they already have a saved Admin or Producer view, choose
   **OWNER** in the sidebar role selector.
5. Verify the user can open the profitability dashboard, an ordinary Admin
   cannot open it, and switching the Owner to an assigned Producer view hides
   the dashboard and its data.

After bootstrap, an active Owner can use Settings → Team to assign or remove
Owner access for other team members. The app prevents an Owner from removing
their own Owner membership. An Admin cannot edit any existing Owner's roles,
including removing their Owner role. No production membership changes are part
of the feature deployment or PR.
