# Changelog

What changed, newest first. The Android app has its own versions (1.0.x), shown in
Settings → Troubleshooting.

## Unreleased

- **Notes:** a new page for anything worth keeping that isn't a task. Notes have a title,
  formatted text (bold, italic, underline, strike, fonts, headings, lists, quotes, links),
  pictures you can place and drag anywhere in the text, and other files. Give them categories,
  each in its own colour, plus tags and an area; link them to tasks and projects (which show
  their notes); pin the important ones. Sort by when they were written or last edited, filter by
  category, tag and what they have, and search with phrases, `-word`, `#tag`, `cat:`, `has:picture`,
  `before:` and more. They save as you type, offline too.
- **Journals:** tick *Journal entry* on a note to put it in a journal, at a point in time: a day
  and a time (now, unless you change it), as many entries in a day as you like. The Journal page
  reads each journal in order, under its months; keep as many as you like.
- **Share to notes:** Settings → Sharing to Entropicide can send what you share from your phone
  (photos especially) to a new note, or as a new entry in a journal, instead of the Inbox; or
  **ask each time**, offering the Inbox, a new note, or a new entry in each journal.
- **Make it a note:** a task can become a note (right-click it, or the button in its details),
  with its notes, tags, files and links.
- The Trash no longer says "Nothing here" when it only holds projects or notes.
- **Convert to project:** right-click a task (or open it) → *Convert to project*. The project
  takes its name, notes, area, due date, priority, star, tags and files; what it was blocked by
  and related to, and what waited on it, move to the project; and its checklist lines can become
  the project's tasks.
- **Projects get tags, files, Blocked by and Related to,** like tasks. A project's tags count for
  all its tasks (in the tag filter), its files show in each task's details, and while it's blocked
  none of its tasks show in the Queue or Focus. Tasks can be blocked by, and related to, projects too.
- **Project priorities:** drag a project's ↕ on the Projects page to raise or lower it, as for
  tasks; higher ones come first.
- **A right-click menu for projects** (press and hold on a phone): set its status (Active,
  Someday, Later, Completed) in one click, its area, priority and tags, star it, make it
  sequential, open it or move it to the trash.
- **A tidier sidebar:** projects are no longer listed there; *Projects* (with how many are active)
  opens their page.
- **Today's calendar** in Focus leaves out events that have already ended.
- **Editing pictures in notes:** click a picture to crop it (drag a box over the part to keep),
  turn it, fade it with the ◐ slider, or put it **behind the text**. The original is kept, so a
  crop can be changed or undone later (*Original*).
- **Formatted notes on tasks and projects,** in the same editor as notes: bold, italic, headings,
  lists, links, and pictures placed in the text (cropped, turned, faded, behind the words), instead
  of typing Markdown. Notes written before are converted as they were shown.
- **Real checklists:** the ☐ button makes one, in a task, project or note; tick items in the
  details, on a task's row, in Focus mode, or on a note's card.
- **Vim keys edit the HTML:** with Settings → Notes editor → Vim, text opens as its HTML (one block
  to a line), for tasks, projects and notes alike; `:check` ticks a checklist item, `:item` adds one.
  *</>* in the toolbar switches between the formatted text and its HTML on any device.
- **Subprojects:** a project can be a part of a bigger one (*New subproject…*, *Move into*, or *Part
  of* in its details). The Projects page shows them as a tree that folds away. A project that's
  waiting, or in Someday or Later, holds back everything in it. On a project's page its tasks and
  subprojects are in one order you drag; a sequential project takes them one at a time, a
  subproject's tasks showing when its turn comes. A task converted to a project inside one becomes
  its subproject, in the same place.
- **Change what something is:** a note can become a task or a project (at the bottom of the note),
  and an empty project a task or a note, keeping its title, text, tags, files and links. Converting
  a task now keeps it the same item, so links to it, and what waited on it, simply stay.
- Moving a task into a project that waits on it, or a project into one it waits on, is refused (it
  could never finish).
- **Drawing:** ✎ in the editor's toolbar draws a picture into a note, task or project: a
  **Sketch** (pen and ink, in six colours and three sizes, with an eraser and undo; it follows a
  stylus's pressure) or a **Diagram** (boxes, arrows, shapes and words, with Excalidraw built in).
  They're placed like any picture, and *Edit drawing* opens them again to carry on.
- **Focus's calendar:** today's and tomorrow's events side by side, one line each, the time first
  (which calendar each is from only when there's more than one). − makes an event small, as not
  one to focus on; + beside the day brings them all back.
- **Inventory:** keep track of food storage, supplies and things around the house, alone or
  shared with a group. Each thing has a name and brand (looked up from its barcode), a category,
  where it's bought and a link to it there. Count things in and out by scanning their barcodes (type 12, scan: 12
  cans added), with the camera or a barcode scanner; a new barcode asks once what it is. Things
  used up get a minimum, and below it “Buy …” goes on the inventory's shopping list; things kept
  have a place (nested places, with printable QR labels that open them) and can be lent.
- **Groups:** Settings → Groups makes a group (a family, a club) of people with an account here,
  invited by username, each an owner, editor or viewer.
- **Sharing:** share a project (and everything in it), a journal (and every entry), or a single
  task or note with a group. 👥 marks what's shared, *by Ann* who made it, and **👥 Shared** in the
  sidebar lists it. A shared task can be given to someone (in their lists alone, with a
  notification and its reminders) or left for anyone; your star, area and order stay your own.
  Viewers only look. Changes by others show within 30 seconds; two edits of a note at once keep both.
- **Projects use the same lists as tasks:** Inbox, Queue (what was Active), Soon, Waiting,
  Scheduled, Someday and Later, or Completed. Moving a project further off takes its tasks and
  subprojects with it (unless they're further off already), and moving it nearer brings them back;
  any can then be moved nearer on its own. A task added to a project starts no nearer than it.
- **A project's start date:** one still to come puts it, and what's in it, in Scheduled until then.
- **Lists by project:** a list's tasks come under their project, with the list's projects shown
  too (Settings → Lists turns that off on a device, leaving each project's name as a heading).
- **Fixed:** the Vim editor stayed light in dark mode.
- **Weekly review:** *Review* in the sidebar walks you through GTD's weekly review: empty the
  Inbox and loose notes, look over what's overdue, waited for and coming up, then each project due
  for a look (stalled ones flagged), and Someday and Later. Projects come up every week by default
  (or every 2 or 4 weeks, or never), and a weekly reminder can be set in Settings.
- **A project's completed tasks and subprojects** are listed at the bottom of its page, under
  *Completed* (folded away until opened; it stays open on that device). Untick one to reopen it.
- **Timelines:** mark tasks, projects, notes and journal entries as **waypoints** (⚑) and see them
  on a line through today: what's done behind, what's coming ahead. *Timeline* in the sidebar for
  all your tasks and projects, one for each project and each journal, or everything dated.
  Waypoints also line up in a strip across the Notes and Journal pages, to jump to.
- **Notes as a list, by category,** as well as cards; long pages draw as you scroll, so many
  notes (and pictures) stay quick.
- **Archive notes:** out of the way, off the Notes page, but still found by search (and listed under
  *Show → Archived*).
- **A right-click menu for notes:** category, tags, pin, waypoint, archive, make it a task or
  project, trash.
- **Text sizes:** a size list in the editor (Small, Normal, Large, Larger, Huge), for the words
  selected or what you type next, in tasks, projects and notes alike.
- **Search tasks like notes:** all the words, anywhere (title, text, tags, project, files,
  people), `"a phrase"`, `-word`, `#tag`, `project:`, `area:`, `in:queue`, `is:overdue` /
  `blocked` / `focus`, `has:checklist` / `file` / `reminder`, and `before:` / `after:` / `on:today`
  by its due (or start) date. `/regex/` still works. Notes' dates take `today` and `yesterday` too.
- **Fixed:** a project moved to the trash took only itself, leaving its tasks in the Queue; now
  everything in it goes too (listed under it in the Trash) and comes back with it. Deleting a
  project for good no longer leaves its subprojects behind.

- **Priority by dragging:** each task's ▲/▼ is now one ↕: press and drag up to raise the
  priority, down to lower it, and let go to set it. The row stays put until then, so it no
  longer jumps away between clicks.
- **A quicker right-click menu:** Move to and Area are rows of buttons at the top (one click
  instead of a submenu), then Priority, Tag and Defer, then Open, Focus timer, Star, Complete
  and Duplicate.
- **Android app 1.0.5:** the Add task tile's box shows its text light on dark in dark mode
  (it was black on dark grey).
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
- **Alexa:** a ready-made skill in `alexa/` ("Alexa, tell Entropicide to add buy milk tomorrow",
  "… what's due today", "… I finished call the dentist"), run on your own server with
  `sudo ./alexa/install.sh`; see docs/alexa.md.
- **Related to:** link tasks that belong together, both ways, without either waiting on the other
  (in a task's details, under More). Click one to open it; rows show 🔗 and how many.
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
