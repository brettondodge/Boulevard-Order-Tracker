# Housecall Pro connection

The Order Tracker reads job status from Housecall Pro (HCP), so the office no
longer marks jobs scheduled or complete by hand, and the HCP Pipeline add-on
($100/month) is no longer needed. HCP stays the place where jobs are
scheduled and finished. The tracker adds what HCP doesn't know: which
materials are ordered and here, where they sit in the shop, and notes for the
labor meeting.

Built October 26–27, 2026, against HCP's official documentation
(docs.housecallpro.com, help.housecallpro.com). Not yet connected to the real
HCP account: that needs the steps below.

## What it does

- **Scheduled / complete come from HCP.** When a job is scheduled,
  rescheduled, unscheduled or finished in HCP, every tracker order on that job
  updates within seconds (webhooks), with the date and the assigned techs.
  Each line shows a purple "HCP: Scheduled Nov 3 · tech" note.
- **Invoiced.** When HCP sends or is paid an invoice for the job, the tracker
  marks the job invoiced ("HCP: Invoice sent" / "Paid"). The tracker never
  un-marks invoiced, because billing sometimes happens outside HCP.
- **Approved jobs appear by themselves.** When HCP creates a job from an
  approved estimate, it is added to Approved – Need to Order (deposit status
  "Awaiting deposit"), with its job number and HCP link. Turn on HCP's
  "Automatically copy an approved estimate to a new job" setting (Settings ›
  Estimates) so customer approvals create the job without anyone clicking.
- **Canceled jobs are flagged**, never deleted: "HCP: Canceled" in red.
- **Linked lines send you to HCP.** A linked job that is received and not
  scheduled shows **Schedule in HCP** (opens the job in HCP) instead of
  "Mark scheduled". In the Job progress window, Scheduled and Complete are
  locked for linked jobs ("change them there").
- **Hourly catch-up.** HCP documents no retries for webhooks, so once an
  hour the tracker re-reads every unfinished linked job, and finds the HCP job
  for orders that only have a job number. Master Lists › Housecall Pro ›
  **Sync with Housecall Pro now** does the same on demand.
- **Only the tracker's jobs are kept.** HCP sends events for every job in
  the company; the tracker stores only jobs it has orders or an approved job
  for. Finished-and-billed orders are never reopened by HCP.
- **Security.** A webhook is accepted only with a valid HCP signature made in
  the last 30 minutes, and each delivery is applied once. All calls to HCP
  are read-only and go one at a time.

### How orders are matched to HCP jobs

1. The HCP job link pasted on the order (`https://pro.housecallpro.com/app/jobs/job_…`)
   contains the job's API id. This is the most reliable.
2. Orders made from an approved job that came from HCP inherit its job.
3. Otherwise the job number: HCP's job number is its `invoice_number`, the
   8-digit number the office already types (and that the sheet import pulled
   from the invoice column). HCP's API can't search by number, so the sync
   reads recent jobs, newest first (up to 30 pages), to find them.

Everything on the same job (same approved job or job number) moves together.
Placeholders like "TBD" or "0" never link anything.

## Setting it up

Do these in order. Nothing here needs a code change. Don't paste keys or
secrets into chat or email: enter them only in Render.

1. **Create the API key in HCP** (an HCP Admin must do this):
   My Apps › All Apps › **API Key Management** › Generate API Key.
   Name it "Order Tracker". **Read-only** is enough today. Copy the key.
2. **Add it to Render:** boulevard-order-tracker › Environment › add
   `HCP_API_KEY` with the key as its value. Save without deploying yet.
3. **Let HCP reach the webhook address through Cloudflare.** Every page of
   tools.blvdglass.com requires a Google sign-in, which HCP can't do. In
   Cloudflare Zero Trust › Access › Applications, add a **self-hosted**
   application for `tools.blvdglass.com` with path `/api/hcp/webhooks`, and
   give it one policy: action **Bypass**, include **Everyone**. Cloudflare
   applies the most specific path, so only this one address is opened. The
   app then accepts a request there only if it carries HCP's signature.
4. **Deploy** the `tracker-updates` work to the live service (see the
   go-live checklist in `docs/handoff-2026-10-27.md`). The new database tables are created by the usual
   `npm run migrate:postgres` pre-deploy step.
5. **Turn on webhooks in HCP:** My Apps › All Apps › **Webhooks** › switch it
   on › URL `https://tools.blvdglass.com/api/hcp/webhooks` › Save. HCP then
   shows a **signing secret**: copy it.
   Choose these events: all `job.*`, all `job.appointment.*` and all
   `invoice.*`. (Estimate, customer, lead and pro events are accepted but not
   used.)
6. **Add the secret to Render:** `HCP_WEBHOOK_SECRET` = the signing secret.
   Save and let Render restart the service.
7. **Check it:** Tools › Order Tracker › Master Lists (admin) › Housecall Pro
   should say "API connected · webhooks set up". Press **Sync with Housecall
   Pro now**. Then schedule a test job in HCP and watch the "last webhook"
   time change and the order update.
8. **Cancel the Pipeline add-on** in HCP once you're happy (Settings ›
   Billing, or HCP support chat). Nothing in the tracker uses Pipeline.

### Settings

| Render variable | Needed | Meaning |
|---|---|---|
| `HCP_API_KEY` | Yes | HCP company API key (MAX plan). Read-only is enough. |
| `HCP_WEBHOOK_SECRET` | Yes | Signing secret HCP shows after saving the webhook URL. Without it the webhook address answers 503. |
| `HCP_SYNC_INTERVAL_MINUTES` | No | Catch-up interval, default 60. `0` turns the automatic sync off (the button still works). |
| `HCP_AUTO_APPROVED_JOBS` | No | `off` stops adding approved jobs from HCP estimates. Default on. |

To disconnect, remove both variables (and turn off the HCP Webhooks app).
Orders keep the values they had, and the tracker's own Mark scheduled /
Mark complete buttons come back.

## What could not be checked without the live account

HCP's documentation leaves these open; the code handles each case
defensively, but the first real events should be watched (Master Lists ›
Housecall Pro lists the last 10 events and their outcome):

- Whether `job.scheduled` fires again on a reschedule, or only
  `job.updated` / `job.appointment.rescheduled`. The tracker subscribes to all
  of them and re-reads the job, so either works.
- Which event, if any, fires when a job is unscheduled. The hourly sync
  catches it if none does.
- The exact `work_status` spelling in webhooks ("unscheduled" in the webhook
  sample, "needs scheduling" in the job model). Both are handled.
- Whether `Api-Signature` is hex or base64. Both are accepted.
- The time zone of `completed_at` (assumed UTC, like the schedule times).
- Whether the job link's `job_…` id is exactly the API id. It matches the
  documented id format; if not, matching falls back to the job number.
- Rate limits are not published. The client waits out HTTP 429 using
  `RateLimit-Reset` and makes requests one at a time.

## What it does not do (yet)

- **Customer texts/emails.** Pipeline's "unscheduled for X days" nudges and
  estimate follow-ups are Pipeline features. HCP's API has no way to send
  messages, so the tracker can't take them over. You said you've never used
  Pipeline, so nothing is lost.
- **Writing to HCP.** The tracker only reads. It could later tag a job
  "Materials received" in HCP (that needs a Full-access key).
- **Deposits.** Deposit status on approved jobs is still set by hand.
- **Paid jobs are not deleted automatically.** They show "HCP: Paid"; delete
  them with Delete (Undo available) when you're done with them.
