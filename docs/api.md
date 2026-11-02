# Adding tasks from other apps (and reading and completing them)

Anything that can send a web request can add tasks: an Alexa skill, Home Assistant, an iPhone
shortcut, Tasker, a script. Each gets a key of its own, made in **Settings → Add from other
apps** (shown once; only a hash of it is kept), and *Revoke* there stops it. Every add is in
the App log (Settings → Troubleshooting), with the key's name. A key made with **Can also
read my lists** ticked can also [read](#reading-a-list) Focus, the Queue and the other lists,
for "what's due today?", and one with **Can also complete tasks** can
[complete](#completing-a-task) them, for "I finished …".

## Adding a task

```
POST https://YOUR-SITE/api/add
Authorization: Bearer YOUR-KEY
```

The task is **text, read just like quick add**: `#tags`, `!lists` (`!queue`, `!waiting`, …),
`!N` priority, `+area`, `@person` (with Google Contacts), and dates and times in plain words
(`tomorrow 3pm`, `due fri`, `every monday`). It goes to the Inbox unless it names a list. Its
first line is the task; any more lines become its notes.

Send it any of these ways:

| Content-Type | Body |
|---|---|
| `application/json` | `{"text": "Buy milk tomorrow #errand"}` |
| `application/x-www-form-urlencoded` | `text=Buy+milk+tomorrow+%23errand`, or just the task as it is (what `curl -d "Buy milk"` sends) |
| `text/plain` (or none) | `Buy milk tomorrow #errand` |

JSON and form bodies can also have:

- `notes`: more notes (after any from the text's later lines).
- `lang`: a language tag such as `en-GB`, for reading `11/5` as 11 May rather than November 5
  (the default is `en-US`).
- `now`: when it was said or typed, `YYYY-MM-DDTHH:MM` in your time zone, if it's sent later
  (so "tomorrow" means the day after that). Without it, now.

Dates are in the time zone your Entropicide account uses (set by your browser).

## The answer

`201 Created`, with JSON:

```json
{"id": 123, "title": "Buy milk", "summary": "Buy milk · Mon Nov 2 · #errand"}
```

`summary` is a line to show or say back ("Added: …"). Otherwise:

- `400` with `{"error": "…"}`: no text, or something in it isn't allowed.
- `401` with `{"error": "…"}`: no key, or one that's been revoked.

## Reading a list

```
GET https://YOUR-SITE/api/read/LIST
Authorization: Bearer YOUR-KEY
```

`LIST` is one of `focus`, `queue`, `inbox`, `soon`, `later`, `someday`, `waiting` or
`scheduled`. The tasks are the ones that list shows in Entropicide, in the same order: Focus is
starred tasks plus anything due today or overdue, and Focus and the Queue leave out blocked
tasks (Blocked by, or later actions of a sequential project) and projects that aren't active,
highest priority first. "Today" is in your account's time zone.

Optional query parameters:

- `area=Home`: only that area's tasks (by name; case doesn't matter).
- `limit=N`: send at most N tasks (default 50, at most 200). `count` is still all of them.
- `say=N`: how many tasks `summary` names (default 5).

The answer:

```json
{
  "list": "Focus",
  "count": 3,
  "summary": "Focus has 3 tasks: Pay rent, overdue; Call Mom, due today; and Buy milk.",
  "tasks": [
    {"id": 41, "title": "Pay rent", "list": "Queue", "focus": false, "priority": 0,
     "due_date": "2026-10-31", "overdue": true, "start_date": null, "start_time": null,
     "project": null, "area": "Home", "tags": ["bills"], "people": []},
    …
  ]
}
```

`summary` is written to be said aloud ("Nothing in Focus." when it's empty). Otherwise:
`401` for no key or a revoked one, `403` for a key that may only add, and `404` for a list or
area that doesn't exist, each with `{"error": "…"}`. Reading doesn't change anything except
what reading the lists in the app would: repeat copies that are due get made, and scheduled
tasks whose start has come move to the Queue.

## Completing a task

```
POST https://YOUR-SITE/api/complete
Authorization: Bearer YOUR-KEY

{"text": "call the dentist"}
```

`text` is what the task is called, as said or typed; it's matched to your open tasks:

1. a title that's the same, ignoring case, punctuation and little words (*the*, *a*, *my*,
   *to*, …): "call the dentist" is *Call dentist*;
2. else the titles that have all its words, or their starts: "dentist" or "call dent";
3. else the nearest by spelling, for a misheard word: "renew pasport" is *Renew passport*.

Tasks in Focus, the Queue, the Inbox, Soon or Waiting beat ones that are scheduled or put
off (Later, Someday), and several open copies of one repeating task count as one: the oldest.
The body can be JSON, a form, or plain text, as for adding (`curl -d "buy milk" …`).

Also in the body:

- `"check": true`: only find the task, without completing it, to ask first ("Complete Call
  dentist?").
- `"id": 123` instead of `text`: complete that task (after a check, or a choice of several).
- `"id": 123, "undo": true`: put a completed task back.

The answers, each with `summary`, a sentence to say:

| Status | When | Example `summary` |
|---|---|---|
| `200` | done (or found, with `check`), with `"task": {"id", "title"}` | `Done: Call dentist.` / `Complete Call dentist?` |
| `409` | several match, with `"matches": [{"id", "title"}, …]` | `Which one: Buy milk, or Buy bread?` |
| `404` | nothing matches | `I couldn't find a task like walk the llama.` |
| `400` | no text | |
| `401`/`403` | no key or a revoked one / a key that can't complete | |

Completing works as it does in the app: a repeating task's next copy comes (for one that
counts from completion), and tasks it was blocking are free. Each one is in the App log.

## Examples

### curl

```sh
curl -d "Buy milk tomorrow #errand" -H "Authorization: Bearer YOUR-KEY" https://YOUR-SITE/api/add
```

(`-d` sends the text as it is. To add notes too: `--data-urlencode "text=Buy milk" --data-urlencode "notes=2%"`.)

### An Alexa skill

A ready-made one is in `alexa/` (add, read and complete, run on your server): see
[alexa.md](alexa.md). To write your own, make a custom skill in the [Alexa developer console](https://developer.amazon.com/alexa/console/ask)
(left in *Development*, it works on the Echos of your own Amazon account, without publishing)
with one intent whose slot takes the whole phrase:

```json
{
  "name": "AddTaskIntent",
  "slots": [{"name": "task", "type": "AMAZON.SearchQuery"}],
  "samples": ["add {task}", "to add {task}", "new task {task}", "put {task} on my list"]
}
```

Then "Alexa, tell *your skill's name* to add buy milk tomorrow" sends `buy milk tomorrow`. The
skill's endpoint (your own server, or AWS Lambda) posts it here and says the summary back.
With the [ASK SDK for Python](https://github.com/alexa/alexa-skills-kit-sdk-for-python):

```python
import requests
from ask_sdk_core.dispatch_components import AbstractRequestHandler
from ask_sdk_core.utils import get_slot_value, is_intent_name

ENTROPICIDE = "https://YOUR-SITE/api/add"
KEY = "YOUR-KEY"  # keep it out of source control: an environment variable is better


class AddTaskHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return is_intent_name("AddTaskIntent")(handler_input)

    def handle(self, handler_input):
        text = get_slot_value(handler_input, "task") or ""
        try:
            r = requests.post(ENTROPICIDE, json={"text": text}, timeout=5,
                              headers={"Authorization": "Bearer " + KEY})
            speech = "Added: " + r.json()["summary"] if r.status_code == 201 else r.json().get("error", "That didn't work.")
        except (requests.RequestException, ValueError, KeyError):
            speech = "I couldn't reach your task list."
        return handler_input.response_builder.speak(speech).response
```

Alexa can't hear `#`, `!` or `@`, so spoken tasks get their dates read but not tags, lists or
people; they land in the Inbox to sort later.

To answer "what's due today?", add a second intent (samples such as "what's due today",
"what's on my list", "what's in focus") whose handler reads the summary out:

```python
class ReadFocusHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return is_intent_name("ReadFocusIntent")(handler_input)

    def handle(self, handler_input):
        try:
            r = requests.get(ENTROPICIDE.replace("/add", "/read/focus"), timeout=5,
                             headers={"Authorization": "Bearer " + KEY})
            speech = r.json()["summary"] if r.ok else r.json().get("error", "That didn't work.")
        except (requests.RequestException, ValueError, KeyError):
            speech = "I couldn't reach your task list."
        return handler_input.response_builder.speak(speech).response
```

(Its key needs *Can also read my lists*.)

And to complete one ("Alexa, tell *your skill* I finished call the dentist"), an intent with
a `{task}` slot (`AMAZON.SearchQuery`; samples such as "I finished {task}", "I did {task}",
"complete {task}", "mark {task} done") that checks first and asks, then completes on "yes"
(the built-in `AMAZON.YesIntent` and `AMAZON.NoIntent`):

```python
def entropicide(path, body):
    r = requests.post(ENTROPICIDE.replace("/add", path), json=body, timeout=5,
                      headers={"Authorization": "Bearer " + KEY})
    return r.status_code, r.json()


class CompleteTaskHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return is_intent_name("CompleteTaskIntent")(handler_input)

    def handle(self, handler_input):
        status, answer = entropicide("/complete", {"text": get_slot_value(handler_input, "task") or "",
                                                   "check": True})
        rb = handler_input.response_builder
        if status != 200:  # nothing like it, or "Which one: …?"
            return rb.speak(answer.get("summary") or answer.get("error")).ask("Which task?").response
        handler_input.attributes_manager.session_attributes["complete"] = answer["task"]["id"]
        return rb.speak(answer["summary"]).ask(answer["summary"]).response  # "Complete Call dentist?"


class YesHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return (is_intent_name("AMAZON.YesIntent")(handler_input)
                and "complete" in handler_input.attributes_manager.session_attributes)

    def handle(self, handler_input):
        task_id = handler_input.attributes_manager.session_attributes.pop("complete")
        status, answer = entropicide("/complete", {"id": task_id})
        return handler_input.response_builder.speak(answer.get("summary") or answer.get("error")).response
```

(Its key needs *Can also complete tasks*; a `NoIntent` handler just says "OK, I left it.")

One key per household member: each person's skill (or each voice profile, if your skill
tells them apart) needs their own key to add to their own tasks.

### Home Assistant

In `configuration.yaml`:

```yaml
rest_command:
  add_task:
    url: https://YOUR-SITE/api/add
    method: post
    headers:
      Authorization: !secret entropicide_key   # "Bearer YOUR-KEY" in secrets.yaml
    content_type: application/json
    payload: '{"text": {{ text | tojson }}}'
```

Then an automation can call `rest_command.add_task` with `text: "Empty the dehumidifier #home"`
(when its tank is full, say), and Assist or a dashboard button can do the same.

To show Focus on a dashboard (with a key that can read), a REST sensor:

```yaml
rest:
  - resource: https://YOUR-SITE/api/read/focus
    headers:
      Authorization: !secret entropicide_key
    scan_interval: 300
    sensor:
      - name: Entropicide Focus
        value_template: "{{ value_json.count }}"
        json_attributes: [summary, tasks]
```

Its state is how many tasks are in Focus; its `summary` attribute can go on a card or be
spoken by a morning automation.

### iPhone and iPad (Shortcuts)

New shortcut: **Ask for Input** (Text) → **Get Contents of URL** with the URL
`https://YOUR-SITE/api/add`, Method *POST*, a Header `Authorization` = `Bearer YOUR-KEY`, and
Request Body *JSON* with `text` = the Provided Input. Then "Hey Siri, *shortcut name*" asks
what to add. Add **Get Dictionary Value** `summary` and **Show Notification** to see what was
added.

### Android (Tasker, HTTP Shortcuts)

Not needed with the Entropicide Android app (its notification and tile do this already), but
any app that can make an HTTP request works the same way: POST, the `Authorization` header,
and the text as the body.
