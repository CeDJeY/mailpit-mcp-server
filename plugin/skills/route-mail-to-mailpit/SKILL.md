---
name: route-mail-to-mailpit
description: Configure an application to send its outgoing email to the Mailpit test mailbox over SMTP, and prove the routing works with a canary email. Use when connecting an app to Mailpit, when the user asks where test emails go, or when expected emails are NOT arriving in Mailpit during verification.
---

# Route application email to Mailpit

Mailpit only captures what is sent to **its SMTP port**. Before any email verification can work, the application under test must be configured to send there — and you must prove it, not assume it.

## Two different addresses — don't confuse them

- **SMTP host:port** — where the *application* sends mail (e.g. `mailpit-host:1025`; deployments often remap the port). No TLS, credentials optional (accepted but ignored).
- **MCP endpoint URL** — where *you* (the agent) read the mailbox (e.g. `http://mailpit-host:3000/mcp`). Never give this to the application.

Get the actual SMTP host and port from the user, the project's docs/CLAUDE.md, or the Mailpit docker-compose configuration. If you can only see the MCP endpoint, ask — do not guess that the ports match defaults.

## Configure the application

Find where the app defines its outgoing mail transport and point it at Mailpit — typical spots: `SMTP_HOST`/`SMTP_PORT`/`MAIL_HOST` env vars, Laravel `MAIL_*`, Django `EMAIL_HOST`, Rails `smtp_settings`, Spring `spring.mail.*`, nodemailer transport options. Set: Mailpit's host and SMTP port, TLS off (or STARTTLS optional), any or no credentials.

**Safety check — do this even if routing "already works":** scan the app's mail config (all environments that tests touch) for real provider hosts — `sendgrid`, `mailgun`, `ses`/`amazonaws`, `postmark`, `resend`, `smtp.gmail.com`, `office365`, or any production SMTP relay. If the test environment can reach a real provider, flag it to the user immediately: test runs could email real people. Verification must never run against a configuration that might deliver externally.

## Prove the routing with a canary

1. Note the baseline: `get_mailbox_info` → `RuntimeStats.SMTPAccepted` and `Messages`.
2. Trigger an email **through the application itself** (its test endpoint, a signup, a CLI task — not via Mailpit's own send_message, which proves nothing about the app), ideally with a unique marker in the subject or recipient (e.g. `canary-<timestamp>@example.com`).
3. `wait_for_message` with a query matching the marker.
4. Arrived → routing confirmed; report the message ID and the config location that made it work.
5. Timed out → routing is broken or misdirected. Check: did `SMTPAccepted` grow anyway (email arrived but query missed it)? Did the app log an SMTP error (wrong host/port/TLS)? Is the config pointing at a real provider or another environment's Mailpit? Report exactly where the app is currently configured to send.

## Report

State the verdict plainly: where the app sends mail, whether it is proven (canary message ID) or merely configured, and any safety findings (real-provider configs reachable from tests) first.
