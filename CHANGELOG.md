# Changelog

What changed, newest first. The Android app has its own versions (1.0.x), shown in
Settings → Troubleshooting.

## Unreleased

- The compass symbol, in grey bas-relief, now sits faintly behind every page.
- **Remind me** can now be a day to three months before the due date, as well as a time; it
  sits under Due, and either kind moves when the due date does.
- **A tidier task editor:** on the right, where it belongs (project, area, tags), then **When**
  (Starts, Due, Remind me, Repeat), then **More** (priority, time, energy, blocked by), folded
  away unless one is set. Starts is always there: a future start date schedules the task by
  itself, and clearing it puts it back in the Queue. ★ Focus moved to the top.
- **Repeat on certain days of the week:** Mon, Wed and Fri, say, with a button for each day
  under Repeat, or `every mon, wed and fri` when adding.
- **Repeat on a weekday of the month:** the first Monday, the second Tuesday, the last Friday
  (`every first monday`, `every last friday of the month` when adding).
- **Add tasks from other apps:** Settings → Add from other apps makes a key for an Alexa skill,
  Home Assistant, an iPhone shortcut or a script, which sends the task's text to `/api/add`
  and has it read like quick add. A key can also be allowed to read your lists
  (`GET /api/read/focus`, `/queue`, …), with a sentence ready to say: "Focus has 3 tasks: …",
  and to complete them by what they're called (`POST /api/complete` with "call the dentist";
  it can check first, and asks which when several match).
  See docs/api.md.
- **People in tasks, from Google Contacts:** the Google connection can now keep a read-only copy
  of your contacts. Type `@Mom` in quick add (it suggests names) or add people in a task's
  details; the name shows on the task, and the details have their numbers to call or text, their
  email and a map of their address. Already connected? Settings → Google Calendar → Reconnect,
  and tick Google Contacts. (Site owners: enable the People API and add the
  `contacts.readonly` scope; see docs/google-calendar.md.)
- **New task** from the installed app's icon: right-click it in the taskbar or dock (or
  press and hold it on Android) to open the app ready to type a task.
- Choosing another list in the sidebar now closes the open task's details.
- A task's "Created" date was the UTC one (a task made in the evening said "Tomorrow").
- **Expiry dates are gone** (the Expires field, the Expiries list, its notices and the
  `expires …` quick-add word): Start, Due and a reminder before the due date cover the same ground.

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
