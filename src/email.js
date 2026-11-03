// Alert emails through Resend's HTTP API (resend.com). The key and the
// recipients live in the server environment, never in the database:
// RESEND_API_KEY, INVENTORY_ALERT_EMAIL (one address, or several separated by
// commas) and optionally ALERT_EMAIL_FROM (an address on a domain verified in
// Resend; Resend's own onboarding address only delivers to the account owner).
const DEFAULT_BASE = 'https://api.resend.com';
const DEFAULT_FROM = 'Boulevard Glass Tools <onboarding@resend.dev>';

export const alertEmailConfigured = () => Boolean(process.env.RESEND_API_KEY && process.env.INVENTORY_ALERT_EMAIL);

export async function sendAlertEmail({ subject, text }) {
  let response;
  try {
    response = await fetch(`${process.env.RESEND_API_BASE || DEFAULT_BASE}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.ALERT_EMAIL_FROM || DEFAULT_FROM,
        to: process.env.INVENTORY_ALERT_EMAIL.split(',').map(address => address.trim()).filter(Boolean),
        subject,
        text
      }),
      signal: AbortSignal.timeout(20000)
    });
  } catch {
    throw new Error("Couldn't reach the email service.");
  }
  if (!response.ok) throw new Error(`The email service refused the email (${response.status}). Check RESEND_API_KEY and the addresses.`);
}
