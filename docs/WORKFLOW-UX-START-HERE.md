# Start the CRM UX/UI review

Start with the fictional preview. It needs no sign-in, sends no messages, and does not change client records.

1. Open **WORKFLOW-UX-TEST-WORKSPACE.html** in Chrome. In Finder, right-click the file and choose **Open With → Google Chrome**.
2. Choose a **role** and **situation**. Explore the **Front workspace**, **Daily report**, and **Reminder email**. The owner also has **Team settings**.
3. Follow **WORKFLOW-UX-ACCEPTANCE.md**. Begin with the first 12 usability cases. Each case gives the steps and expected outcome.
4. Open **WORKFLOW-UX-RESULTS.csv** in Excel or Numbers. Record Pass, Fail, Blocked, or Not run. For a problem, add the role, screen, steps, actual result, and a screenshot.

The review covers 75 cases across sales, champions, managers, reminders, carrier work, renewals, binding, client service, and next-year prospect follow-up. The preview demonstrates the interface; it does not simulate every saved change or prove live delivery. Reload resets the fictional data.

For every screen, check whether a person can immediately answer:

- Why did this appear?
- What should I do now?
- Will doing that work update the system automatically?
- Who is responsible if it remains unhandled?

## Connected staging tests

Staging is at https://staging.d2d4g940z91vj4.amplifyapp.com.

The original workflow release is **7559ad3**, deployed September 11, 2026, in CRM staging job **199** and website staging job **198**. The engineering handoff recorded 2,157 passing tests, successful type checks, infrastructure synthesis, and both app builds. These checks are separate from your UX sign-off.

At handoff, delivery was paused pending real manager assignments, approved verified report recipients, a separate internal Front reporting mailbox, and a confirmed operations-alert recipient. Check the readiness record before running connected tests. Use fresh, clearly named **UX TEST** records and only approved controlled recipients. Do not invite staff as part of this review.

Actual 9 a.m. delivery and distinct manager/owner escalation still require connected acceptance. See **WORKFLOW-RELEASE-READINESS.md** for setup details and the limits of automatic evidence. Production has not been changed by this release.

The latest preview includes a light-green **All caught up** confirmation near the top of the Everything is up to date situation. It replaces the empty action prompt. Check this in case UX-11.
