# Alexa

"Alexa, tell Entropicide to add buy milk tomorrow", "Alexa, ask Entropicide what's due today",
"Alexa, tell Entropicide I finished call the dentist" (it asks "Complete Call dentist?" first).

This is your own private Alexa skill, made in your Amazon developer account and run on your
server next to Entropicide. It uses Entropicide's [API](api.md) with a key of its own. Amazon
keeps it in *Development*, which means it works on the Echo devices on your Amazon account
without being published or reviewed. (Amazon no longer lets other apps use Alexa's own
to-do list, so "Alexa, add milk to my to-do list" stays in Amazon's list: you name the skill.)

What's in `alexa/`:

| File | What it is |
|---|---|
| `interaction-model.json` | What you can say: pasted into the Alexa developer console |
| `lambda_function.py` | The skill: what it does with what you say |
| `server.py`, `requirements.txt`, `entropicide-alexa.service` | It as a web service on your server |
| `install.sh` | Installs that (with `sudo`), for a server set up with `deploy/install.sh` |

It needs your site on the internet over HTTPS with a certificate from a known authority (Let's
Encrypt is fine), since Amazon's servers call it.

## 1. A key

In Entropicide: **Settings → Add from other apps**. Name it *Alexa*, tick **Can also read my
lists** and **Can also complete tasks**, and **Make a key**. Keep the page open: the key is
shown once.

## 2. The skill

1. Sign in at the [Alexa developer console](https://developer.amazon.com/alexa/console/ask)
   with the **same Amazon account as your Echo** (making a developer account is free).
2. **Create Skill**. Name: *Entropicide*. Locale: your Echo's (e.g. English (US)). Type:
   **Other → Custom**. Hosting: **Provision your own**. Template: **Start from Scratch**.
3. When it's made, copy its **skill ID** (`amzn1.ask.skill.…`): it's under the skill's name in
   the list of skills (*Copy Skill ID*), or in **Build → Endpoint**.
4. **Build → Interaction Model → JSON Editor**: replace everything with
   `alexa/interaction-model.json`, then **Save** and **Build skill**. The invocation name in it
   is *entropicide*; if Alexa doesn't hear that well, change `invocationName` to two easy words
   (lower case), such as *task box*, and build again.

## 3. Run it on your server

```sh
sudo ./alexa/install.sh
```

It asks for the skill ID and the key (kept in `/opt/entropicide-alexa/.env`, readable only by
the app's user), installs the skill as the `entropicide-alexa` service on 127.0.0.1:5004, and
adds a marked block to the Apache site in `deploy/site.conf` that forwards
`https://YOUR-SITE/entropicide-alexa` to it (backup beside it; Entropicide's own `install.sh`
leaves the block alone). It finishes by checking that the address answers and refuses requests
that aren't Amazon's. Run it again after updating Entropicide to update the skill; to change
the key or skill ID, edit the `.env` and `sudo systemctl restart entropicide-alexa`.

The skill checks every request is really from Amazon (its signature and time) and for your
skill ID, and talks to Entropicide on the same machine (`http://127.0.0.1:PORT/PATH`), not
over the internet.

## 4. Point the skill at it

In the console: **Build → Endpoint → HTTPS**. Default Region: `https://YOUR-SITE/entropicide-alexa`,
and for the certificate, **My development endpoint has a certificate from a trusted
certificate authority**. **Save**.

## 5. Try it

**Test** tab: set *Skill testing is enabled in* to **Development**, then type (or hold the mic
and say) *ask entropicide what's due today*. Then on an Echo:

| Say | Does |
|---|---|
| "Alexa, tell Entropicide to add buy milk tomorrow" | Adds it, read like quick add; says "Added: Buy milk · Scheduled · …" |
| "Alexa, ask Entropicide what's due today" | Reads Focus (also: "what's on my list", "what do I have to do") |
| "Alexa, ask Entropicide what's in my inbox" | Reads that list: inbox, queue (or "next", "to do"), soon, later, someday, waiting, scheduled ("upcoming") |
| "Alexa, tell Entropicide I finished call the dentist" | "Complete Call dentist?" → "yes" completes it, "no" leaves it |
| "Alexa, open Entropicide" | Asks what you'd like; "help" lists these |

Also: "put … on my list", "new task …", "I need to …", "I did …", "mark … done", "tick off …".
Avoid "remind me to …": that's Alexa's own Reminders, which asks when and doesn't add a task.
A task with no date goes to the Inbox; one with a date ("tomorrow", "on friday") is Scheduled.

Spoken tasks get their dates read ("tomorrow at 3", "due friday") but not `#tags`, `!lists`
or `@people`, which can't be said; they land in the Inbox to sort later. Adds and completions
appear in Entropicide's App log (Settings → Troubleshooting), under the key's name.

## If it doesn't work

- **"There was a problem with the requested skill's response"**: `journalctl -u entropicide-alexa -n 50`.
- **"I couldn't reach your task list"**: Entropicide isn't answering on this machine
  (`systemctl status entropicide`), or `ENTROPICIDE_SITE` in the `.env` is wrong.
- **"Not connected any more…"**: the key was revoked; make another and put it in the `.env`.
- **Alexa says something unrelated**: it didn't hear the invocation name; try another (step 2.4).

## Without your own server

The same `lambda_function.py` runs as an **Alexa-hosted** skill (Amazon runs it, free): choose
*Alexa-hosted (Python)* in step 2, paste the file into `lambda/lambda_function.py` in the
console's **Code** tab, fill in `SITE` (your site's public address) and `KEY` at the top, and
**Deploy**; skip steps 3 and 4. The key then sits in your developer account's copy of the code.
