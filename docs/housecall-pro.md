# Housecall Pro connection

The Order Tracker works alongside Housecall Pro (HCP). Staff paste an HCP job
link on an order and the tracker fills in what HCP knows. HCP is then where
jobs are scheduled and finished, and the tracker follows along. The tracker
keeps what HCP doesn't know: the supplier, the PO on the supplier order, ETA,
when it arrived and which shelf it's on. It also moves each job across the
Pipeline **Jobs board**, so the board shows which jobs are waiting on a
deposit, waiting to be ordered, waiting on materials, or ready to schedule
(see [The Pipeline Jobs board](#the-pipeline-jobs-board)).

Built against HCP's official documentation (docs.housecallpro.com,
help.housecallpro.com) and tested against a stand-in for HCP. The live site
has had the API key since October 27, 2026; the setup steps below list the
rest. Every API call and webhook the tracker uses is listed in
[housecall-pro-connections.md](housecall-pro-connections.md).

## How it works day to day

1. **Add an order (or an approved job).** Paste the job's link from HCP (or
   type its job number) in the first box. The tracker fills in the empty
   boxes: customer name, job #, category (from the HCP job type) and the
   job's description and notes. It also says how many photos or files the
   job has in HCP. Staff add the rest: supplier, **PO** (the reference you
   put on the supplier order), ordered by and ETA. An approved job's
   **Order materials** fills the order form the same way (category and
   notes included); saving it moves the job to Outstanding, or **Save +
   another supplier** keeps it waiting for the next supplier order.
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

## The Pipeline Jobs board

Pipeline is kept (October 28, 2026), for its estimate follow-ups and for this
board. Its Jobs columns, in order:

New Job → Deposit Needed → Need to Order Materials → Waiting on Materials →
Materials Received → Unscheduled → Scheduled → In Progress → Completed →
Invoice Sent → On Hold → Invoice Paid

New jobs land in the first column. The tracker moves a job through the
middle four, and HCP moves it from Scheduled on as the work is done:

| Column | Moved there by | When |
|---|---|---|
| New Job | HCP | The job is created. A job with no materials stays here until it is scheduled. |
| Deposit Needed | Tracker | An approved job is added with "Awaiting deposit" |
| Need to Order Materials | Tracker | An approved job is added, or edited, with the deposit received or waived |
| Waiting on Materials | Tracker | A supplier order is saved |
| Materials Received | Tracker | Every order for the job is here, and the approved job isn't waiting on another supplier (Save + another supplier) |
| Unscheduled (required by HCP) | HCP | Past the materials steps and needs a date |
| Scheduled → Invoice Paid | HCP | As the job is scheduled, worked, completed and invoiced |
| On Hold | By hand | The tracker never moves a job into or out of it |

Rules the tracker keeps:

- **Forward only.** HCP's API can only move a job forward, so Undo, reopening
  an order or deleting one never moves a job back. The tags still correct
  themselves.
- **Once per step,** after the Undo window, like the tags.
- **Hands off:** jobs HCP has scheduled or finished, jobs on hold, and jobs
  someone moved further by hand. When HCP refuses a move, Master Lists shows
  it, and the tracker doesn't try again.
- **Nothing moves until an admin saves the columns** in Master Lists ›
  Housecall Pro.
- **Missed moves come back:** the hourly catch-up makes any move that didn't
  happen (for example while HCP was unreachable).
- **No texts:** the Jobs board's automated texts are off for now. Pipeline's
  estimate follow-ups are separate, and the tracker doesn't touch the estimate
  or lead boards.

### Office rule

Share with the office:

```
JOB BOARD RULE (Housecall Pro Pipeline)

Don't drag job cards on the Jobs board. Do the real step and the card moves itself.

New jobs start in New Job. A job with no materials stays there until you schedule it.

Deposit and materials -> in the Order Tracker
  - Add the job under Approved - Need to Order (paste the HCP link)
      -> Deposit Needed, or Need to Order Materials if the deposit is in or waived
  - Deposit received or waived: edit the approved job
      -> Need to Order Materials
  - Save the supplier order
      -> Waiting on Materials
  - Mark everything received
      -> Materials Received

Scheduling, finishing, invoicing -> in Housecall Pro
  - Schedule the job -> Scheduled
  - In Progress, Completed, Invoice Sent and Invoice Paid follow as you do the work

On Hold is the only column you move by hand.

Card in the wrong column? Don't drag it. Find the step that wasn't entered
(usually an order missing from the Order Tracker) and enter it.
```

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
   tracker add the tags and notes and move jobs on the Pipeline board; with
   Read-only everything else still works and Master Lists says those aren't
   being written.
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
   on › URL `https://tools.blvdglass.com/api/hcp/webhooks` › Save. HCP sends a
   test request to that address when you save, so this only works once the
   new version is live (step 4) and the Cloudflare rule is in place (step 3);
   otherwise HCP says "Error testing webhook request". HCP then shows a
   **signing secret**: copy it. Choose these events: all `job.*` and
   all `job.appointment.*`. (Others are accepted and ignored.)
7. **Add the secret to Render:** `HCP_WEBHOOK_SECRET` = the signing secret.
   Save and let Render restart the service.
8. **Check it** in Master Lists (admin) › Housecall Pro. It should say "API
   connected · webhooks set up · tags and notes in HCP on · Pipeline moves
   on". Under
   **Category for each Housecall Pro job type**, check the suggested category
   for each of your HCP job types and press Save categories.
   Then paste a real job's link on a new order and watch it fill in.
9. **Pipeline columns:** in Master Lists › Housecall Pro › **Pipeline column
   for each step**, check the suggested column for each step and press Save
   Pipeline columns. Then use **Try one job** on a test job to check that HCP
   takes the move. Moves only go forward, so don't use a customer's job. Once
   it works, share the office rule above.

### Settings

| Render variable | Needed | Meaning |
|---|---|---|
| `HCP_API_KEY` | Yes | HCP company API key (MAX plan). Full access for tags, notes and Pipeline moves. |
| `HCP_WEBHOOK_SECRET` | Yes | Signing secret HCP shows after saving the webhook URL. Until it is set, the webhook address answers HCP's test but changes nothing; once set, only requests signed with it are accepted. |
| `HCP_SYNC_INTERVAL_MINUTES` | No | Catch-up interval, default 60. `0` turns the automatic sync off (the button still works). |
| `HCP_WRITE_BACK` | No | `off` stops the tags, notes and Pipeline moves. Default on. |

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
  re-reads every unfinished linked job and open approved job, re-matches its
  tags and Pipeline column, and finds the HCP job for orders that only have a
  job number. Master Lists › Sync with
  Housecall Pro now does the same on demand.
- **Every call to HCP goes one at a time**, waits out HCP's rate limits, and
  gives up after 20 seconds. The only writes are job tags, job notes and the
  job's Pipeline column.
- **Not used:** invoices and payments, tech names, HCP's own deposits (the
  tracker's deposit status on approved jobs drives the board), and approved
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
- Pipeline moves: HCP's docs call the job's id a "UUID", while job ids look
  like `job_…`; **Try one job** shows whether HCP takes them. Also not
  documented: what HCP answers when a move is refused, and whether Pipeline
  automations run for jobs the tracker moves (texts are off for now).
