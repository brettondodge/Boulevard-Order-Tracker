# Housecall Pro: every connection point

Every way the Order Tracker and Housecall Pro (HCP) talk to each other, as of
October 28, 2026. Setup steps are in [housecall-pro.md](housecall-pro.md).

In short:

- The tracker **reads** from HCP to fill in orders and to follow each job's
  schedule.
- The tracker **writes** only two things to HCP: job **tags** and job
  **notes**.
- HCP **tells** the tracker when a job changes (webhooks), and the tracker
  double-checks once an hour.

All of it uses HCP's public API, which is part of the MAX plan. Nothing uses
the Pipeline add-on.

## 1. The tracker reads from HCP (API)

| When | HCP call | What the tracker does with it |
|---|---|---|
| Someone pastes an HCP job link on an order or approved job | `GET /jobs/{id}?expand[]=attachments` | Fills the empty boxes: customer name, job #, category (from the job type), notes (the job's description and notes). Says how many photos or files the job has. |
| Someone types a job # instead of a link | `GET /jobs`: newest first, 100 per page, up to 1,000 jobs | HCP can't search by job #, so the tracker reads recent jobs to find it, then fills in as above. |
| Order materials on an approved job | Same as a pasted link | Fills the category and notes on the order form. |
| An order is saved with a new HCP link | `GET /jobs/{id}` | Shows the job's HCP status on the order right away. |
| An appointment webhook arrives, or a webhook looks older than what the tracker has | `GET /jobs/{id}` | Reads the whole job so no change is missed. |
| Hourly catch-up, or Master Lists › **Sync with Housecall Pro now** | `GET /jobs/{id}` for every unfinished linked job, and `GET /jobs` (newest 3,000) for orders that only have a job # | Updates scheduled and complete. Links orders found by job #. Re-matches tags. |
| An admin opens Master Lists › Housecall Pro | `GET /job_fields/job_types` | Lists your HCP job types so each can be given a tracker category. |
| The first time a tag is needed | `GET /tags` | Finds the tracker's two tags in HCP. |

## 2. The tracker writes to HCP (API)

These need the API key's **Full access**. `HCP_WRITE_BACK=off` in Render turns
all of them off.

- **Timing:** each write happens about 20 seconds after the change, once the
  15-second Undo window is over. The tracker then looks at the order as it is
  at that moment, so a change that was undone writes nothing.
- **Fresh read first:** before writing, it reads the job (`GET /jobs/{id}`) to
  see its current tags.
- **Finished jobs:** jobs already complete or canceled in HCP are never
  re-tagged.

| Tracker action | HCP call | What appears in HCP |
|---|---|---|
| Order added for an HCP job | `POST /jobs/{id}/notes` | Note: "Order Tracker: materials ordered from Jeld-Wen, PO SMITH REV2, expected Nov 3." |
| | `POST /jobs/{id}/tags` | Tag **Materials ordered** |
| Order marked received | `POST /jobs/{id}/notes` | Note: "Order Tracker: Jeld-Wen materials received (PO SMITH REV2), shelf H." |
| Every tracker order for that job is received | `DELETE /jobs/{id}/tags/{tag}`, then `POST /jobs/{id}/tags` | **Materials ordered** is replaced by **Materials received**, which you can filter on in HCP when scheduling |
| Order edited | Depends on the edit | Newly linked to a job: note and tag, as for a new order. Newly received: the received note. Anything else: tags only. |
| Order reopened, deleted or restored, or an approved job deleted or restored | Tag add or remove only | Tags re-matched to the orders still in the tracker. With no orders left for the job, both tags come off. |
| A tag doesn't exist in HCP yet | `POST /tags` | Creates "Materials ordered" or "Materials received", once |

Notes are only ever added. The tracker never edits or deletes an HCP note,
even if the order is later deleted. It only adds or removes its own two
tags.

## 3. HCP tells the tracker (webhooks)

The address is `https://tools.blvdglass.com/api/hcp/webhooks`. A Cloudflare
Access **Bypass** rule opens this one path. The rest of the site still needs
the Google sign-in.

Every delivery is checked before anything happens:

- **Signature:** the `Api-Signature` header must be the HMAC-SHA256 of
  `Api-Timestamp` + "." + the message body, made with `HCP_WEBHOOK_SECRET`.
  Hex or base64 is accepted.
- **Age:** the delivery must be made within the last 30 minutes.
- **Repeats:** each delivery is applied once.
- **Size:** 1 MB at most.
- **Before the secret is set:** deliveries are answered OK and ignored. That
  lets HCP's test pass when the webhook URL is first saved.

HCP sends events for every job in the company. The tracker acts only on jobs
it has orders or approved jobs for, and records the rest as ignored.

| HCP event | What the tracker does |
|---|---|
| `job.created`, `job.updated`, `job.scheduled`, `job.on_my_way`, `job.started`, `job.completed`, `job.paid`, `job.canceled`, `job.deleted` | Takes the status, schedule, completion time and tags from the event and updates that job's orders |
| `job.appointment.*` (scheduled, rescheduled, discarded, …) | Reads the whole job from the API, because the event only describes the visit |
| Anything else (invoices, estimates, customers, …) | Recorded and ignored |

Master Lists › Housecall Pro lists the last 10 events. The history is kept
for 90 days.

## 4. What an HCP job's status does to its orders

| HCP job | Order in the tracker |
|---|---|
| Needs scheduling | Not scheduled. Shows in **To schedule** once the material is here. |
| Scheduled, On my way, In progress | **Scheduled**, with the scheduled day (Phoenix time) |
| Rescheduled | The date changes |
| Unscheduled again | Back to not scheduled |
| Complete (rated or unrated) | **Done**, with HCP's completion date |
| Canceled or deleted | Left as it is. The HCP line goes away and the tracker's own Mark scheduled / Mark complete buttons come back. |

Linked orders show what HCP says ("HCP: Scheduled Nov 3"). Instead of the
tracker's own schedule buttons, they get a **Schedule in HCP** or **Open in
HCP** button.

## 5. How an order is matched to an HCP job

1. **The order's HCP link.** The job's id is inside the link.
2. **The approved job's HCP link,** for orders made from that approved job.
3. **The job #,** when it matches a job the tracker already knows. For the
   rest, the hourly catch-up searches the newest 3,000 HCP jobs.
   Placeholders like "TBD" or "0" never match.

Each order stands on its own. Two orders share HCP status only when they
point at the same HCP job.

## 6. What the tracker keeps from HCP

- **For each job it follows:** the HCP id, job #, work status, scheduled
  start and day, completed, canceled and deleted times, tags, and when it
  was last read.
- **Copied into an order when it's filled in:** the customer name, job #,
  category and notes.
- **Nothing else:** no addresses, prices, invoices, payments or employees.

## 7. What it never does

- **No Pipeline:** it doesn't use the Pipeline add-on, and HCP's API can't
  read a job's Pipeline stage anyway.
- **No changes to jobs:** it never creates, schedules, completes or cancels
  an HCP job. HCP's API can't mark a job complete.
- **No other records:** it never touches customers, estimates, invoices or
  payments.
- **No messages:** it never sends texts or emails.
- **No automatic entries:** it doesn't add orders or approved jobs on its own.
  Staff add them, using the paste-to-fill box.

## 8. Settings (Render › boulevard-order-tracker › Environment)

| Setting | Meaning |
|---|---|
| `HCP_API_KEY` | HCP company API key (My Apps › API Key Management). Full access for tags and notes; Read-only still allows everything in sections 1, 3 and 4. |
| `HCP_WEBHOOK_SECRET` | The signing secret HCP shows after the webhook URL is saved. |
| `HCP_SYNC_INTERVAL_MINUTES` | How often the catch-up runs. Default 60; `0` turns it off (the button still works). |
| `HCP_WRITE_BACK` | `off` stops the tags and notes. On by default. |

For tests and local copies only: `HCP_API_BASE` points the tracker at a
stand-in HCP, and `HCP_WRITE_DELAY_MS` changes the 20-second wait.

## 9. Staying within HCP's limits

- Calls to HCP go one at a time.
- When HCP says to slow down (429), the tracker waits as long as HCP asks
  (up to 30 seconds), then tries again, up to 3 times.
- A call gives up after 20 seconds.
- One job that can't be read doesn't stop the hourly catch-up. A rejected API
  key does.
- Problems show in Master Lists › Housecall Pro: the last error, and the last
  error writing tags or notes.

## 10. The tracker's own Housecall Pro addresses

| Address | Who | Purpose |
|---|---|---|
| `POST /api/hcp/webhooks` | HCP only (signed) | Receives the webhooks in section 3 |
| `GET /api/hcp/lookup?q=` | Staff | The paste-to-fill box |
| `GET`, `PUT /api/hcp/job-types` | Admin | Category for each HCP job type |
| `GET /api/hcp/status` | Admin | The Housecall Pro panel in Master Lists |
| `POST /api/hcp/sync` | Admin | The Sync now button |

## 11. Where it lives in the code

- `src/hcp/client.js`: every call to HCP's API.
- `src/hcp/sync.js`: matching, webhooks, the hourly catch-up, and the tags
  and notes.
- `src/server.js`: the `/api/hcp/*` addresses, and the hooks on order
  changes that trigger the writes.
- `migrations/007-housecall.sql`, `migrations/008-orders-hcp-job.sql`: the
  `hcp_jobs`, `hcp_events` and `hcp_state` tables, and `orders.hcp_job_id`.
- `tests/hcp-fake.js`: the stand-in HCP the tests run against.

HCP's documentation leaves a few things open, such as exact status spellings
and whether `job.scheduled` repeats on a reschedule. See "What could not be
checked without the live account" in [housecall-pro.md](housecall-pro.md).
