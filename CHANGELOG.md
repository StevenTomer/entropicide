# Changelog

What changed, newest first. The Android app has its own versions (1.0.x), shown in
Settings → Troubleshooting.

## 0.1.0 (2026-11-01)

The first public release.

- **Renamed** from Todo to **Entropicide**, with a new logo. Existing installs move over by
  themselves: `deploy/install.sh` moves `/opt/todo` to `/opt/entropicide` (after a backup), and
  sign-ins, saved device settings, old backups and older Android apps keep working.
- **Runs anywhere:** a container image and `docker-compose.yml`; the site's address, the
  Android app's package and the operator's details are settings rather than built in.
- Add tasks from the phone without leaving the app you're in: a reply-in-place notification and
  a Quick Settings tile (Android app 1.0.4), read like quick add, and kept until there's signal.
- Reminders: ✓ Done from the notification, and quiet hours.
- Attachments open in a viewer over the task (pictures, PDFs, text).
- Search takes regular expressions (`/pattern/`).
- An App log (Settings → Troubleshooting) of shares and Android app launches.
- Security: sign-in throttling also per address across usernames; framing and referrer
  headers; the Android app asks before connecting to an account.
- Licensed under the AGPL-3.0; the name and logo are trademarks (TRADEMARKS.md).
