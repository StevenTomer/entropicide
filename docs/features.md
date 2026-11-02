# Feature tour

The in-app **Help** (sidebar, or press `?`) explains every list and feature with examples.
In brief:

- **Lists:** Inbox, Focus, Queue (GTD's *next actions*), Soon, Later, Someday, Waiting, Scheduled,
  Recurring, then All. **Focus** shows starred tasks
  plus anything due today or overdue.
  **All** shows every open task, grouped by list (except repeating tasks' next copies, which
  stay in Recurring). The **Logbook** is grouped by the day each task was completed.
- **Scheduled** tasks move to the Queue on their start date.
- **Repeating** tasks follow the calendar, not your completions: when one copy's start
  date arrives, the next copy appears in **Recurring** (a list of its own, so Scheduled
  holds only one-off tasks). **If missed** decides what happens to
  an unfinished copy once the next one starts: *keep* it open alongside the new one
  (e.g. register the van) or *replace* it, logged as Missed (e.g. load the dishwasher).
  Editing the newest copy's dates changes the schedule from then on; editing an older
  copy moves only that one. Set Repeat to Never, or trash every copy, to stop it.
  Repeat can be daily, weekdays, weekly, monthly, yearly, on certain days of the week, or every
  N days, weeks, months or years, or a weekday of the month (quick add: `every 6 weeks`,
  `every 3 months`, `every monday`, `every mon, wed and fri`, `every last friday`).
  Adding a task while viewing Recurring makes it repeat weekly from tomorrow; the editor
  opens on Repeat so you can change that.
- **Projects** can be *sequential*, so only their first action shows in the Queue.
- **Areas** (Work, Home, …) filter the whole app from the sidebar dropdown: tick one or several
  (or *No area*); none ticked shows everything. New tasks go in the first area ticked. Each can have an
  SVG icon (Settings → Areas: upload a file, or give a URL to download it from), shown before
  its tasks. Icons are cleaned of scripts and external links when saved; URLs must be on the
  public internet.
- **Quick add:** `Call Bob #phone !waiting +work !2` adds the tag *phone*, puts the task in
  Waiting, in the *Work* area, with priority 2. `!focus` stars it; `+side` is enough for
  *Side Projects* if no other area starts that way. Typing `#`, `!` or `+` suggests the choices.
- **Dates in quick add:** `Call dentist tomorrow 3pm`, `Gym mon 7:30am`, `Renew passport in 2 weeks`,
  `Taxes due apr 15`. A date or time is when the task starts: a later one puts it in Scheduled
  until then. After `due` or `by` it's the due date. `today` alone stars the task (Focus).
  Understood: today, tonight (6 pm), tomorrow, weekdays (`fri`, `on sat`, `this fri`, `next fri` =
  Friday of next week), `next week`/`next month`, `this weekend`, `in 3 days`/`2 weeks`/`a month`,
  `nov 5`, `5 nov`, `11/5`, `2026-11-05`; times `3pm`, `3:30 pm`, `15:00`, `noon`, `at 3`.
  A line under the box shows how it was read before you press Enter.
- **Notes** (and titles) take Markdown: `**bold**`, `*italic*`, `~~struck~~`, `` `code` ``, `# headings`,
  `- lists`, `1. lists`, `> quotes`, `---`, code blocks, `[ ]` checklists and links.
- **Vim keys in notes** (Settings → Notes editor, per device): CodeMirror 5.65.21 with its Vim
  keymap, served from `static/vendor/codemirror` (MIT; loaded only on devices that choose it).
- **Attachments**: add files to a task from its details (button, drag and drop, or paste an image);
  up to 25 MB each, 1 GB per user, stored in the database. Pictures, PDFs and text open in a
  viewer over the task (PDFs drawn with pdf.js); anything else downloads.
- **Search** filters the list by title and notes; `/regex/` for a regular expression.
- **Priority** is a number, 0 by default (negative pushes a task down); rows are tinted red above 0
  and blue below, deeper the further from 0. **Focus** and the
  **Queue** list higher numbers first, in your drag order within the same number. Change it
  with the ▲/▼ on each task, right-click → Priority, `+`/`-` on the open or selected tasks, or
  the editor. Dragging a task within Focus or the Queue gives it the priority of where it lands.
- **Drag** tasks to reorder them, or drop them on a sidebar list, a project, Logbook (to
  complete them) or Trash.
- **Select several tasks** with Ctrl/⌘-click, Shift-click (a range) or Ctrl/⌘-A (all shown);
  on a phone, press and hold a task → *Select*, then tap others. Right-click one of them (or use
  *Actions* in the bar above the list) to move, tag, defer, star, complete or trash them all,
  or drag them together.
- **Links:** save web pages you often need, in folders (drag to rearrange or move into a
  folder). Star a link to put it in the **toolbar** across the top of every list; give it an SVG
  icon (✎ → Upload icon / From URL, as for areas) and the toolbar shows just the icon.
- **Google Calendar** (Settings → Google Calendar): tasks with a due date (or else a start date)
  appear as events on a calendar you choose — a shared one like *Family*, or a new *Entropicide*
  calendar. Sync runs both ways every minute: move or rename a task's event in Google and the
  task follows; delete it and the task goes to the Trash. On the app's own calendar, events you
  add become tasks; on a shared calendar its other events are left alone. Events from your
  calendars show in **Focus** (today) and the **Calendar** (next two weeks; the calendar icon in the toolbar).
- **People** (with Google connected): a read-only copy of your Google Contacts, refreshed hourly
  and deleted on Disconnect. `@Mom` in quick add (suggested as you type; `@BobSmith` for a full
  name) or *People* in the editor names contacts on a task; the row shows the name and the
  editor their phone numbers (call, text), email addresses and addresses (map).
- **Text size** (Settings → Text size, 75–200%) is kept per device, so a tablet can use larger
  text than a laptop. The whole layout scales with it.
- **Phone app** (Settings → Phone app, or `/install` on your site): an Android download (if the
  site has one: see [android.md](android.md)), or *Install* / *Add to Home Screen* from the browser.
- **New task shortcut:** right-click the installed app's taskbar or dock icon (press and hold on
  Android) → *New task* opens it ready to type one (`?new`, the manifest's `shortcuts`).
- **Add from the phone** (Android app): a notification you reply to in place, and a Quick Settings
  tile, add tasks without leaving the app you're in; what you type is read like quick add, and it
  waits on the phone when there's no signal.
- **Offline:** once opened on a device, the app also works without a connection, showing your
  tasks as last loaded. Adding, editing, completing, moving and trashing tasks and projects
  still works: the changes are kept on the device (a badge counts them, even across a
  reload) and sent in order when the connection is back. If the same task was changed
  elsewhere meanwhile, the later change wins. Settings, the Logbook and Trash need a connection.
- **Reminders** (Settings → Notifications, per device): a task's *Remind me* time (or snoozed:
  1 hour, tonight, tomorrow), timed starts, and a morning summary, as Web Push notifications
  with ✓ Done and Snooze buttons, and quiet hours that hold them overnight. The server's VAPID key is `data/vapid_private.pem` (made on first use;
  if it's lost, devices must turn notifications on again).
- **Add from other apps** (Settings → Add from other apps): a key per app; `POST /api/add` with
  the task's text, read like quick add; a key allowed to read gets `GET /api/read/focus` (or any
  list) with a summary to say, and one allowed to complete gets `POST /api/complete` ("call the
  dentist" finds *Call dentist*) ([api.md](api.md): curl, Alexa, Home Assistant, Shortcuts).
- **Share menu:** the installed app (Android) takes shared pages, text, photos and files as new
  Inbox tasks (`/share`, the manifest's `share_target`).
- **Repeating tasks** start each copy with its checklist unticked, and can carry their
  attachments to each copy (stored once).
- **Blocked by:** a task can wait on others (in any project); until they're done it stays out of
  the Queue and Focus. **Related to** links tasks both ways without waiting: click one to open it.
- **Templates:** *Save as template* from a project (dates kept as days from the project's date),
  then *New project* from it with a date. A template can repeat, making a new project on
  schedule, some days ahead (*Monthly bills (Nov 1)*).
- **Ctrl/⌘+K** finds anything (lists, projects, tags, areas, links, tasks) and runs commands,
  including the right-click actions on the selected tasks.
- **Repeat from completion:** a repeat can count from when a copy is completed instead of the
  calendar; the next copy is made then.
- **Reminders before the due date:** *Remind me* can be a time, or a day to three months
  before the due date; either way it moves when the due date does.
- **Focus timer:** one task full screen with a countdown; the time is added to the task.
- **Keys:** `↑`/`↓` or `j`/`k` move through tasks, `h`/`l` (`←`/`→`) to the lists on the left and
  back (there `j`/`k` change the list), `Enter` opens, `x` completes, `s` stars, `t` focus timer, `n` new task, `/` search, `Esc` clear the selection or close the editor, `Ctrl/⌘-A` select all, `+`/`-` raise/lower priority.
