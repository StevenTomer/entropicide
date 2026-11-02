"""Entropicide for Alexa: a custom skill that adds, reads and completes tasks through
Entropicide's API (docs/api.md), set up as in docs/alexa.md. It runs on your own server
(server.py, installed by install.sh), or as an Alexa-hosted skill, which needs only this file.

  "Alexa, tell Entropicide to add buy milk tomorrow"
  "Alexa, ask Entropicide what's due today"            (or "what's in my inbox", …)
  "Alexa, tell Entropicide I finished call the dentist" (it asks first: "Complete …?")

It needs Entropicide's address and a key from its Settings → Add from other apps, with "Can
also read my lists" and "Can also complete tasks" ticked: ENTROPICIDE_SITE and ENTROPICIDE_KEY
in the environment (install.sh puts them in .env), or, Alexa-hosted, filled in below. Anyone
with the key can add to your tasks: if it gets out, revoke it there and make another.
"""
import json
import os
import urllib.error
import urllib.request

from ask_sdk_core.dispatch_components import (AbstractExceptionHandler, AbstractRequestHandler,
                                              AbstractRequestInterceptor, AbstractResponseInterceptor)
from ask_sdk_core.skill_builder import SkillBuilder
from ask_sdk_core.utils import get_slot, get_slot_value, is_intent_name, is_request_type

# Where Entropicide is (as in your browser, https://example.org/todo; on the same server,
# http://127.0.0.1:PORT/PATH), and the key.
SITE = os.environ.get("ENTROPICIDE_SITE", "https://YOUR-SITE")
KEY = os.environ.get("ENTROPICIDE_KEY", "YOUR-KEY")

HELP = ("You can say: add, and a task, like add buy milk tomorrow. Or ask what's due today, or "
        "what's in your inbox. Or say I finished, and the task. What would you like?")
UNREACHABLE = "I couldn't reach your task list. Try again in a minute."


def entropicide(method, path, body=None):
    """(HTTP status, answer) from Entropicide's API, or (None, {}) if it couldn't be reached."""
    req = urllib.request.Request(
        SITE.rstrip("/") + "/api" + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json",
                 "User-Agent": "entropicide-alexa/1"})
    try:
        with urllib.request.urlopen(req, timeout=6) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except ValueError:
            return e.code, {}
    except (urllib.error.URLError, OSError, ValueError):
        return None, {}


def said(status, answer):
    """What to say back: Entropicide's own sentence, else why not."""
    if status is None:
        return UNREACHABLE
    return answer.get("summary") or answer.get("error") or "That didn't work."


def list_name(handler_input):
    """The list asked for (its own name, whatever synonym was said), or Focus."""
    slot = get_slot(handler_input, "list")
    for authority in (slot and slot.resolutions and slot.resolutions.resolutions_per_authority) or []:
        if authority.status.code.value == "ER_SUCCESS_MATCH":
            return authority.values[0].value.name
    return "focus"


class Launch(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return is_request_type("LaunchRequest")(handler_input)

    def handle(self, handler_input):
        return handler_input.response_builder.speak("What would you like to do?").ask(HELP).response


class AddTask(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return is_intent_name("AddTaskIntent")(handler_input)

    def handle(self, handler_input):
        rb = handler_input.response_builder
        task = (get_slot_value(handler_input, "task") or "").strip()
        if not task:
            return rb.speak("What should I add? Say add, and the task.").ask("Say add, and the task.").response
        # (Alexa hears it all in lower case: "Buy milk tomorrow", not "buy milk tomorrow".)
        status, answer = entropicide("POST", "/add", {"text": task[0].upper() + task[1:]})
        if status == 201:
            return rb.speak("Added: " + answer["summary"]).response
        return rb.speak(said(status, answer)).response


class ReadList(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return is_intent_name("ReadListIntent")(handler_input)

    def handle(self, handler_input):
        status, answer = entropicide("GET", "/read/" + list_name(handler_input))
        return handler_input.response_builder.speak(said(status, answer)).response


class CompleteTask(AbstractRequestHandler):
    """Finds the task first and asks; Yes completes it (the id waits in the session)."""
    def can_handle(self, handler_input):
        return is_intent_name("CompleteTaskIntent")(handler_input)

    def handle(self, handler_input):
        rb = handler_input.response_builder
        task = (get_slot_value(handler_input, "task") or "").strip()
        if not task:
            return rb.speak("Which task? Say I finished, and its name.").ask("Say I finished, and the task.").response
        status, answer = entropicide("POST", "/complete", {"text": task, "check": True})
        if status != 200:  # nothing like it, or "Which one: …?"
            return (rb.speak(said(status, answer) + (" Say I finished, and its name." if status == 409 else ""))
                    .ask("Say I finished, and the task.").response)
        handler_input.attributes_manager.session_attributes["complete"] = answer["task"]["id"]
        return rb.speak(answer["summary"]).ask(answer["summary"]).response  # "Complete Call dentist?"


class Yes(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return (is_intent_name("AMAZON.YesIntent")(handler_input)
                and "complete" in handler_input.attributes_manager.session_attributes)

    def handle(self, handler_input):
        task_id = handler_input.attributes_manager.session_attributes.pop("complete")
        status, answer = entropicide("POST", "/complete", {"id": task_id})
        return handler_input.response_builder.speak(said(status, answer)).response


class No(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return is_intent_name("AMAZON.NoIntent")(handler_input)

    def handle(self, handler_input):
        handler_input.attributes_manager.session_attributes.pop("complete", None)
        return handler_input.response_builder.speak("OK, I left it.").response


class Help(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return (is_intent_name("AMAZON.HelpIntent")(handler_input) or is_intent_name("AMAZON.FallbackIntent")(handler_input)
                or is_intent_name("AMAZON.YesIntent")(handler_input))  # (a yes with nothing to confirm)

    def handle(self, handler_input):
        return handler_input.response_builder.speak(HELP).ask(HELP).response


class Stop(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return any(is_intent_name(name)(handler_input) for name in
                   ("AMAZON.CancelIntent", "AMAZON.StopIntent", "AMAZON.NavigateHomeIntent"))

    def handle(self, handler_input):
        return handler_input.response_builder.speak("OK.").response


class SessionEnded(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return is_request_type("SessionEndedRequest")(handler_input)

    def handle(self, handler_input):
        return handler_input.response_builder.response


class Oops(AbstractExceptionHandler):
    def can_handle(self, handler_input, exception):
        return True

    def handle(self, handler_input, exception):
        print("Entropicide skill error:", repr(exception))  # (shows in the console's CloudWatch logs)
        return handler_input.response_builder.speak("Sorry, something went wrong.").response


class LogRequest(AbstractRequestInterceptor):
    """What Alexa heard, in the log (journalctl -u entropicide-alexa, or the console's CloudWatch
    logs), to tell "it never got here" from "it got here and went wrong"."""
    def process(self, handler_input):
        req = handler_input.request_envelope.request
        intent = getattr(req, "intent", None)
        slots = {k: v.value for k, v in ((intent and intent.slots) or {}).items() if v.value}
        print("Heard:", intent.name if intent else req.object_type, slots or "", flush=True)


class LogResponse(AbstractResponseInterceptor):
    def process(self, handler_input, response):
        speech = response and response.output_speech
        print("Said:", getattr(speech, "ssml", None) or getattr(speech, "text", ""), flush=True)


sb = SkillBuilder()
sb.add_global_request_interceptor(LogRequest())
sb.add_global_response_interceptor(LogResponse())
for handler in (Launch(), AddTask(), ReadList(), CompleteTask(), Yes(), No(), Help(), Stop(), SessionEnded()):
    sb.add_request_handler(handler)
sb.add_exception_handler(Oops())
lambda_handler = sb.lambda_handler()
