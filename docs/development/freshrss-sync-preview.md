# FreshRSS synchronization preview

This branch adds FreshRSS synchronization through the Google Reader API, with Local / FreshRSS selection inside the existing RSS Dashboard.
Open Settings > RSS Dashboard > Sync to connect using the API address, username,
and dedicated API password. The command "Open FreshRSS library" selects FreshRSS in the existing dashboard. Both sources use the existing sidebar, article list, and reader; local subscriptions remain separate.

The current preview includes flat folders, subscriptions, article download,
read/starred state synchronization, local tags and saved notes, durable pending
operations, conflict records, automatic retry, and manual sync.

Empty local folders are uploaded when their first feed is added. Deleting a
folder moves its subscriptions to the default category. Subscription URLs are
edited on the FreshRSS server. Local RSS Dashboard subscriptions remain separate.

Account state is stored under the plugin's freshrss directory. The API password
is not retained; the authentication token is stored in separate account files.
These files are outside RSS Dashboard's existing portable export payload, but
whole-vault or plugin-directory backup/sync tools can copy them. Protect them as
credentials. Disconnect clears the token from both recovery slots.

## Verification and remaining work

- Production build, lint, TypeScript and platform/CSS checks passed.
- 22 focused synchronization/view tests passed at initial UI integration.
- Full suite initially reported 1744 passed and three failures. The two
  settings-tab count assertions were updated and passed targeted reruns.
- The remaining original article-saver date test expects an English date, while
  this Windows environment formats it in Chinese. Changing LANG did not fix it.
- This is not a completed production release. Real FreshRSS interoperability,
  complete interactive desktop/mobile verification, concurrent structural
  operations, cancellation, and remote article-deletion cases still require
  validation and hardening. Do not treat the preview as fully accepted.

Source-switch integration: production build passed; full suite 1750 passed with the same pre-existing locale-dependent article-saver failure. Switching sources and account-scoped article writes have focused regression coverage.
