---
name: verify-email
description: Verify an email captured by Mailpit — wait for it, inspect structure and content, check links and HTML client compatibility, and report a PASS/FAIL verdict. Use when the user asks to verify, test, or check an email their application sent (e.g. "check the welcome email", "did the invoice email go out correctly?").
---

# Verify an email in Mailpit

Verify an email captured by the Mailpit test mailbox using the `mailpit` MCP tools.

## Input

From the user's request, determine:
- **query** — a Mailpit search query narrowing down the email: `to:user@example.com`, `subject:"welcome"`, `from:`, `tag:`, or a combination. If the user gave nothing specific, use `get_message` with id `latest` instead of waiting.
- **checklist** — any structure/content requirements the user stated (must contain a greeting with the user's name, a confirmation link, an unsubscribe footer, etc.).

## Steps

1. If the email is expected to arrive as a result of a just-triggered action, call `wait_for_message` with the query (default timeout is fine; it also accepts messages that arrived a few seconds before the call). Otherwise `search_messages` / `get_message(latest)`.
2. `get_message` with the found ID — review subject, sender, recipients, text and HTML bodies, attachment list.
3. `check_links` with `follow: true` — any non-2xx link is a finding.
4. If there is an HTML body: `check_html` — note compatibility warnings relevant to mainstream clients (Gmail, Outlook, Apple Mail); ignore exotic ones unless the user cares.
5. Look for general defects regardless of checklist: unrendered template variables (`{{name}}`, `%FIRST_NAME%`), placeholder or missing images, empty sections, mojibake/encoding artifacts, obviously wrong personalization.
6. If the user provided a checklist, verify every item explicitly.

## Report

Lead with the verdict: **PASS** or **FAIL**. Then findings, most severe first, each one line: what's wrong, where (subject/body/link), and evidence (the broken URL, the unrendered variable). If the email never arrived, that's a FAIL — include the query and timeout used. Keep it short; no restating the email's full content.
