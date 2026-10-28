# Housecall Pro connection

The Order Tracker works alongside Housecall Pro (HCP). Staff paste an HCP job
link on an order and the tracker fills in what HCP knows. HCP is then where
jobs are scheduled and finished, and the tracker follows along. The tracker
keeps what HCP doesn't know: the supplier, the PO on the supplier order, ETA,
when it arrived and which shelf it's on. This replaces the HCP Pipeline
add-on ($100/month), which you can cancel.

Built against HCP's official documentation (docs.housecallpro.com,
help.housecallpro.com) and tested against a stand-in for HCP. Not yet
connected to the real HCP account: that needs the setup steps below.

## How it works day to day

1. **Add an order (or an approved job).** Paste the job's link from HCP (or
   type its job number) in the first box. The tracker fills in the empty
   boxes: customer name, job #, category (from the HCP job type) and the
   job's description and notes. It also says how many photos or files the
   job has in HCP. Staff add the rest: supplier, **PO** (the reference you
   put on the supplier order), ordered by and ETA.
2. **HCP gets a tag and a note.** After the 15-second Undo window, the tracker
   tags the HCP job **Materials ordered** and adds a note, for example
   "Order Tracker: materials ordered from Jeld-Wen, PO SMITH REV2, expected
   Nov 3."
3. **Material arrives.** Mark received asks which shelf it's on. HCP gets a
   note ("Jeld-Wen materials received (PO SMITH REV2), shelf H"). Once every
   tracker order for that HCP job is here, the tag changes to **Materials
   received**, which you can filter on in HCP when scheduling.
4. **Labor meeting.** The To schedule tab (or Condensed lines) lists what's
   here and not scheduled. Linked lines have a **Schedule in HCP** button that
   opens the job in HCP.
5. **Schedule in HCP.** Within seconds the tracker shows it as scheduled, with
   the date ("HCP: Scheduled Nov 3").
6. **Finished in HCP.** When the job is completed in HCP, the tracker marks the
   order done and it moves to the Done tab. "In progress" in HCP still counts
   as scheduled.

Undoing a change in the tracker inside the Undo window writes nothing to HCP.
If an order is deleted, the HCP tags are put back to match the remaining
orders. Jobs already complete or canceled in HCP are never re-tagged.

### How orders are matched to HCP jobs

1. The HCP job link on the order (`https://pro.housecallpro.com/app/jobs/job_…`)
   contains the job's id. This is the most reliable, and what the
   paste-to-fill box stores.
2. Orders made from an approved job inherit that job's HCP link.
3. Otherwise the job number (HCP calls it the invoice number). HCP's API can't
   search by number, so the tracker reads recent jobs, newest first, to find
   it. Placeholders like "TBD" or "0" never match anything.

Each order otherwise stands on its own. Two orders only share HCP status when
they point at the same HCP job.

## Setting it up

Do these in order. Nothing here needs a code change. Don't paste keys or
secrets into chat or email: enter them only in Render.

1. **Create the API key in HCP** (an HCP Admin must do this):
   My Apps › All Apps › **API Key Management** › Generate API Key. Name it
   "Order Tracker" and choose **Full access**. Full access is what lets the
   tracker add the tags and notes; with Read-only everything else still
   works and Master Lists says the tags and notes aren't being written.
   Copy the key.
2. **Add it to Render:** boulevard-order-tracker › Environment › add
   `HCP_API_KEY` with the key as its value.
3. **Let HCP reach the webhook address through Cloudflare.** Every page of
   tools.blvdglass.com requires a Google sign-in, which HCP can't do. In
   Cloudflare Zero Trust › Access › Applications, add a **self-hosted**
   application for `tools.blvdglass.com` with path `/api/hcp/webhooks`, and
   give it one policy: action **Bypass**, include **Everyone**. Cloudflare
   applies the most specific path, so only this one address is opened. The
   app then accepts a request there only if it carries HCP's signature.
4. **Deploy** the `tracker-updates` work (see the handoff checklist). The new
   tables are created by the usual `npm run migrate:postgres` step.
5. **Start fresh** (admin): Master Lists › Start fresh… clears the test orders,
   approved jobs, suppliers and staff now in the tracker. Run the backup job
   in Render first. Then add your real suppliers and Ordered by staff in
   Master Lists.
6. **Turn on webhooks in HCP:** My Apps › All Apps › **Webhooks** › switch it
   on › URL `https://tools.blvdglass.com/api/hcp/webhooks` › Save. HCP then
   shows a **signing secret**: copy it. Choose these events: all `job.*` and
   all `job.appointment.*`. (Others are accepted and ignored.)
7. **Add the secret to Render:** `HCP_WEBHOOK_SECRET` = the signing secret.
   Save and let Render restart the service.
8. **Check it** in Master Lists (admin) › Housecall Pro. It should say "API
   connected · webhooks set up · tags and notes in HCP on". Under
   **Category for each Housecall Pro job type**, check the suggested category
   for each of your HCP job types and press Save categories.
   Then paste a real job's link on a new order and watch it fill in.
9. **Cancel the Pipeline add-on** in HCP once you're happy. Nothing in the
   tracker uses Pipeline.

### Settings

| Render variable | Needed | Meaning |
|---|---|---|
| `HCP_API_KEY` | Yes | HCP company API key (MAX plan). Full access for tags and notes. |
| `HCP_WEBHOOK_SECRET` | Yes | Signing secret HCP shows after saving the webhook URL. Without it the webhook address answers 503. |
| `HCP_SYNC_INTERVAL_MINUTES` | No | Catch-up interval, default 60. `0` turns the automatic sync off (the button still works). |
| `HCP_WRITE_BACK` | No | `off` stops the tags and notes. Default on. |

To disconnect, remove both keys (and turn off the HCP Webhooks app). Orders
keep the values they had, and the tracker's own Mark scheduled / Mark complete
buttons come back.

## Behind the scenes

- **Webhooks** update an order within seconds. A webhook is accepted only with
  a valid HCP signature made in the last 30 minutes, and each delivery is
  applied once. HCP sends events for every job in the company; the tracker
  keeps only jobs it has orders or approved jobs for. If an event looks older
  than what the tracker last read, it reads the job from HCP again rather
  than miss a change.
- **Hourly catch-up.** HCP documents no retries, so once an hour the tracker
  re-reads every unfinished linked job, re-matches its tags, and finds the HCP
  job for orders that only have a job number. Master Lists › Sync with
  Housecall Pro now does the same on demand.
- **Every call to HCP goes one at a time**, waits out HCP's rate limits, and
  gives up after 20 seconds. The only writes are job tags and job notes.
- **Not used:** invoices and payments, tech names, deposits, and approved
  estimates (approved jobs are added by staff, with the paste-to-fill box).

## What could not be checked without the live account

HCP's documentation leaves these open. The code handles each case, but watch
the first real events (Master Lists › Housecall Pro lists the last 10):

- Whether `job.scheduled` fires again on a reschedule, or only `job.updated` /
  `job.appointment.rescheduled`. The tracker listens for all of them.
- Which event fires when a job is unscheduled. The hourly sync catches it if
  none does.
- The exact status spellings in webhooks; all known spellings are handled.
- Whether `Api-Signature` is hex or base64. Both are accepted.
- The time zone of `completed_at` (assumed UTC, like the schedule times).
- Whether HCP returns photos and files on a job when asked
  (`expand[]=attachments`); if not, the "photos or files" count is simply
  left out.
- Rate limits aren't published.
