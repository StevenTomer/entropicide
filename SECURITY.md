# Security

## Reporting a vulnerability

Please report it privately, through GitHub: the repository's **Security** tab → **Report a
vulnerability**. Don't open a public issue. Include what an attacker could do, and how to
reproduce it. You'll get a reply within a week; once a fix is out, you'll be credited in the
changelog unless you'd rather not be.

## Supported versions

Fixes go into the latest release (and the `main` branch). Run the latest image or code.

## How it's built to be safe

For anyone reviewing it, the main protections:

- **Accounts:** invite-only; passwords hashed (Werkzeug); sign-in throttled per address and
  username, and per address across usernames; changing a password signs out other sessions.
- **Sessions:** signed cookies, `HttpOnly`, `SameSite=Lax` and `Secure`.
- **Requests that change things:** the API needs a custom header that cross-site pages can't
  send; the sign-in form has its own token.
- **Each user's data is their own:** every query is scoped to the signed-in user (admins manage
  accounts, not other people's tasks).
- **Files:** attachments and uploaded icons are served with `nosniff` and a sandboxing
  Content-Security-Policy; SVG icons are cleaned of scripts and outside links, and icons fetched
  from a URL must be on the public internet (no requests to the server's own network).
- **Pages:** `X-Frame-Options: DENY`, `nosniff` and a same-origin referrer policy.
- **Phones:** each connected Android app has its own key (only a hash is stored), can be
  disconnected in Settings, and asks before connecting to an account.
- **Secrets** (the cookie key, the push-notification key, Google tokens) stay in the data folder
  and the database, never in the code.
