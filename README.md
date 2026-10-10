# Boulevard Glass Order Tracker

This is a small internal web app for tracking supplier orders for glass and glazing jobs. It stores orders in a durable SQLite database, supports staff logins, and lets office staff manage outstanding and received orders from one shared place.

## What it does

- Tracks customer name, job number, job link, supplier, PO number, ordered date, expected delivery date, received date, and notes.
- Keeps orders in two states: Ordered and Received.
- Marks overdue based on the expected delivery date using America/Phoenix time.
- Shows outstanding, overdue, received, and all-order views.
- Saves supplier names for reuse and allows adding new suppliers.
- Requires staff login before viewing or editing orders.
- Persists data in a local SQLite database so it survives refreshes, sign-outs, restarts, and reopening the app.

## Local preview setup

1. Open a terminal in this project folder.
2. Install Node.js 22 if it is not already installed.
   - If you already use nvm, run:
     - `nvm install 22`
     - `nvm use 22`
3. Install dependencies:
   - `npm install`
4. Copy the example environment file:
   - `cp .env.example .env`
5. Start the app:
   - `npm start`
6. Open the app in your browser:
   - `http://localhost:3000/login`

## Demo logins

The first run creates demo staff accounts automatically.

- Username: `admin` | Password: `admin123`
- Username: `mary` | Password: `staff123`

These accounts are intended for preview only and should be replaced with real office logins before live use.

## Preview data

The app includes fictional sample orders for preview use. The sample data is clearly labeled as preview data in the interface and is kept separate from any live business records.

## App workflow

- Outstanding view is the default landing page.
- Search across customer, job number, supplier, and PO number.
- Filter by supplier and sort by expected delivery date or order date.
- Add, edit, receive, and reopen orders.
- Received orders remain searchable for history.
- Overdue is a calculated flag, not a separate status.
- Orders without an ETA show `No ETA`.

## Publish the app for office staff online

For real office use, deploy the app to a host with persistent storage and a custom domain. A straightforward option is:

- Host: Render, Railway, Fly.io, or another Node.js host
- Database: SQLite for a small office at first, or move to PostgreSQL if you want a more production-style setup
- Domain: use a private or internal company domain if the app is only for staff access
- Secure session secret: set a strong value in the environment

Recommended production settings:

- Set `SESSION_SECRET` to a real long secret.
- Set `PREVIEW_MODE=false` when you want to stop using sample data.
- Use a real user account system or add staff accounts to the database.
- Back up the database file or migrate to a managed database if the app grows.

## Ongoing costs and requirements

- Local preview: no ongoing cost.
- Shared online deployment: usually a small monthly hosting fee, plus optional domain and backups.
- If you want a fully managed database and permanent external access, expect a small monthly service cost depending on the host.

## HCP automation readiness

The archive workflow is designed to support a later Housecall Pro import or automation step without connecting to HCP from this project.

Eligibility for a future automated archive decision:

- The job is completed.
- The job has been invoiced.
- The job is paid in full.
- All linked supplier orders have been received.

Important exclusions:

- Deposit payments alone do not qualify.
- Individually paid progress invoices do not qualify on their own.
- If HCP conditions are satisfied but local ordering or receiving work is still incomplete, the job should be flagged for review instead of being auto-hidden.

Safety rules for later integration:

- Use stable HCP job IDs and treat repeated notifications as idempotent.
- Keep archive metadata in the local database with source values like `manual` and `future_hcp_automation` and the optional archive reason.
- Verify the actual HCP API fields, event semantics, and payload naming during the later integration.
- Do not connect to HCP or change anything in HCP during this task.

## Notes for beginners

- The app is intentionally simple and maintainable.
- It uses one database file in the `data/` folder for persistence.
- The local preview is a working demo, not a public internet deployment.
- The app has backend authorization checks so unauthorized users cannot view or edit orders.

## Running tests

From the project folder:

```bash
npm test
```

## Production reminder

This preview is ready for local office use. To make it available to the whole office online, deploy it to a hosted environment and configure a real login model, domain, and persistent storage.
