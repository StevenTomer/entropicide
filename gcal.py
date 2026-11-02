"""Google Calendar (and Contacts): OAuth, the few API calls sync needs, and how tasks map to events.

Each user's dated tasks go on a calendar of their choice: an "Entropicide" calendar the app creates,
or one of their own (such as a shared family calendar).
Google's addresses can be overridden (ENTROPICIDE_GOOGLE_*_URL) so tests can use a fake server.
"""
import base64
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

CLIENT_ID = os.environ.get("ENTROPICIDE_GOOGLE_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("ENTROPICIDE_GOOGLE_CLIENT_SECRET", "")
AUTH_URL = os.environ.get("ENTROPICIDE_GOOGLE_AUTH_URL", "https://accounts.google.com/o/oauth2/v2/auth")
TOKEN_URL = os.environ.get("ENTROPICIDE_GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token")
REVOKE_URL = os.environ.get("ENTROPICIDE_GOOGLE_REVOKE_URL", "https://oauth2.googleapis.com/revoke")
API = os.environ.get("ENTROPICIDE_GOOGLE_API_URL", "https://www.googleapis.com/calendar/v3")
PEOPLE_API = os.environ.get("ENTROPICIDE_GOOGLE_PEOPLE_URL", "https://people.googleapis.com/v1")
CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar"
CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly"  # optional
SCOPES = f"openid email {CALENDAR_SCOPE} {CONTACTS_SCOPE}"
NO_CONTACTS_ACCESS = ("Google didn't give Entropicide access to your contacts. Click Reconnect and "
                      "tick the box for Google Contacts.")
NO_CALENDAR_ACCESS = ("Google didn't give Entropicide access to your calendars. Click Reconnect and, on "
                      "Google's permissions page, tick the box for Google Calendar.")
CALENDAR_NAME = "Entropicide"  # (made before the rename, it's called Todo)
TIMED_MINUTES = 30  # length of the event for a task with a start time


def configured():
    return bool(CLIENT_ID and CLIENT_SECRET)


class GoogleError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class AuthRevoked(GoogleError):
    pass


def _request(method, url, *, token=None, form=None, body=None, params=None):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = {"User-Agent": "entropicide-calendar-sync/1"}
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        try:
            info = json.loads(e.read() or b"{}")
        except ValueError:
            info = {}
        err = info.get("error")
        if err == "invalid_grant":
            raise AuthRevoked("Google access was revoked or has expired. Reconnect in Settings.",
                              e.code)
        msg = (err.get("message") if isinstance(err, dict) else
               info.get("error_description") or err) or e.reason
        if e.code == 403 and "insufficient" in str(msg).lower():
            raise AuthRevoked(NO_CALENDAR_ACCESS, e.code)
        raise GoogleError(f"Google said: {msg} ({e.code})", e.code)
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise GoogleError(f"Couldn't reach Google ({getattr(e, 'reason', e)}).")


def _quote(s):
    return urllib.parse.quote(s, safe="")


# --- OAuth ----------------------------------------------------------------

def auth_url(redirect_uri, state):
    return AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id": CLIENT_ID, "redirect_uri": redirect_uri, "response_type": "code",
        "scope": SCOPES, "state": state,
        # offline + consent: always get a refresh token, so sync works while nobody is signed in
        "access_type": "offline", "prompt": "consent", "include_granted_scopes": "true",
    })


def has_calendar_access(tokens):
    """Whether the user ticked Calendar on Google's consent page (each scope has a checkbox)."""
    return CALENDAR_SCOPE in tokens.get("scope", CALENDAR_SCOPE).split()


def has_contacts_access(scopes):
    return CONTACTS_SCOPE in (scopes or "").split()


def exchange_code(code, redirect_uri):
    """Trade the callback's code for tokens; adds "email" read from the ID token."""
    tokens = _request("POST", TOKEN_URL, form={
        "code": code, "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
        "redirect_uri": redirect_uri, "grant_type": "authorization_code"})
    tokens["email"] = ""
    if tokens.get("id_token"):
        # Straight from Google's token endpoint over TLS, so no signature check is needed.
        payload = tokens["id_token"].split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        tokens["email"] = claims.get("email", "")
    return tokens


def refresh(refresh_token):
    return _request("POST", TOKEN_URL, form={
        "refresh_token": refresh_token, "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET, "grant_type": "refresh_token"})


def revoke(token):
    _request("POST", REVOKE_URL, form={"token": token})


# --- Calendar API ---------------------------------------------------------

def create_calendar(token, tz):
    return _request("POST", f"{API}/calendars", token=token, body={
        "summary": CALENDAR_NAME, "timeZone": tz,
        "description": "Tasks with a start or due date, kept in step with Entropicide."})


def delete_calendar(token, cal):
    _request("DELETE", f"{API}/calendars/{_quote(cal)}", token=token)


def list_calendars(token):
    return _request("GET", f"{API}/users/me/calendarList", token=token,
                    params={"maxResults": 250}).get("items", [])


def writable_calendars(token):
    """[(id, name)] of the calendars the user can add events to, their main one first."""
    cals = [c for c in list_calendars(token) if c.get("accessRole") in ("owner", "writer")]
    cals.sort(key=lambda c: (not c.get("primary"), (c.get("summaryOverride") or c.get("summary") or "").lower()))
    return [(c["id"], c.get("summaryOverride") or c.get("summary") or c["id"]) for c in cals]


def is_ours(event):
    """Whether an event was put on the calendar by this app (for a task)."""
    return "todo_task" in event.get("extendedProperties", {}).get("private", {})


def list_events(token, cal, params):
    return _request("GET", f"{API}/calendars/{_quote(cal)}/events", token=token, params=params)


def insert_event(token, cal, body):
    return _request("POST", f"{API}/calendars/{_quote(cal)}/events", token=token, body=body)


def patch_event(token, cal, event_id, body):
    return _request("PATCH", f"{API}/calendars/{_quote(cal)}/events/{_quote(event_id)}",
                    token=token, body=body)


def delete_event(token, cal, event_id):
    """Delete an event; one that's already gone is fine."""
    try:
        _request("DELETE", f"{API}/calendars/{_quote(cal)}/events/{_quote(event_id)}", token=token)
    except GoogleError as e:
        if e.status not in (404, 410):
            raise


# --- tasks <-> events -----------------------------------------------------

def snapshot(task):
    """What a task's event shows, or None if it shouldn't have one.

    The event sits on the due date if there is one, else on the start date (at the
    start time, if set). The snapshot last sent to Google is kept with the task, so
    each side's changes can be told apart.
    """
    if task["completed_at"] or task["deleted_at"]:
        return None
    if task["due_date"]:
        kind, day, hhmm = "due", task["due_date"], None
    elif task["start_date"]:
        kind, day, hhmm = "start", task["start_date"], task["start_time"]
    else:
        return None
    return {"kind": kind, "title": task["title"], "date": day, "time": hhmm,
            "notes": task["notes"]}


def event_body(snap, task_id, tz, link, patch=False):
    d = date.fromisoformat(snap["date"])
    if snap["time"]:
        start = datetime.combine(d, datetime.strptime(snap["time"], "%H:%M").time())
        end = start + timedelta(minutes=TIMED_MINUTES)
        when = {"start": {"dateTime": start.isoformat(), "timeZone": tz},
                "end": {"dateTime": end.isoformat(), "timeZone": tz}}
        if patch:  # switching an all-day event to a timed one
            for k in when:
                when[k]["date"] = None
    else:
        when = {"start": {"date": d.isoformat()}, "end": {"date": (d + timedelta(days=1)).isoformat()}}
        if patch:
            for k in when:
                when[k].update(dateTime=None, timeZone=None)
    notes = snap["notes"].strip()
    return when | {
        "summary": ("Due: " if snap["kind"] == "due" else "") + snap["title"],
        "description": (notes + "\n\n" if notes else "") + f"From Entropicide: {link}",
        "transparency": "transparent",  # tasks don't make you look busy
        "extendedProperties": {"private": {"todo_task": str(task_id)}},
    }


def event_title(event, kind):
    title = (event.get("summary") or "").strip()
    if kind == "due" and title.startswith("Due:"):
        title = title[4:].strip()
    return title[:500] or "(untitled)"


def event_when(edge, tz):
    """(YYYY-MM-DD, HH:MM or None) of an event's start or end, in the user's time zone."""
    edge = edge or {}
    if edge.get("date"):
        return edge["date"], None
    if edge.get("dateTime"):
        dt = datetime.fromisoformat(edge["dateTime"].replace("Z", "+00:00")).astimezone(ZoneInfo(tz))
        return dt.date().isoformat(), dt.strftime("%H:%M")
    return None


def event_notes(event):
    """An event's description as task notes, minus the "From Entropicide" line the app adds
    ("From Todo", before the rename)."""
    text = event.get("description") or ""
    return re.split(r"From (?:Entropicide|Todo): ", text)[0].rstrip()[:20000]


# --- Contacts (People API) ------------------------------------------------

def list_contacts(token):
    """The user's contacts that have a name or nickname, as [{id, name, info}] where info is
    {nicknames, phones, emails, addresses} (each phone, email or address {value, type})."""
    out, page = [], None
    while True:
        params = {"personFields": "names,nicknames,phoneNumbers,emailAddresses,addresses",
                  "pageSize": 1000}
        if page:
            params["pageToken"] = page
        res = _request("GET", f"{PEOPLE_API}/people/me/connections", token=token, params=params)
        for p in res.get("connections", []):
            nicknames = [n["value"].strip() for n in p.get("nicknames", []) if n.get("value", "").strip()]
            name = next((n["displayName"].strip() for n in p.get("names", [])
                         if n.get("displayName", "").strip()), None) or (nicknames[:1] or [None])[0]
            if not name:
                continue
            some = lambda key, field: [{"value": x[field].strip()[:300], "type": x.get("formattedType", "")}
                                       for x in p.get(key, []) if x.get(field, "").strip()][:10]
            out.append({"id": p["resourceName"], "name": name[:200], "info": {
                "nicknames": nicknames[:10], "phones": some("phoneNumbers", "value"),
                "emails": some("emailAddresses", "value"), "addresses": some("addresses", "formattedValue")}})
        page = res.get("nextPageToken")
        if not page or len(out) > 50000:
            return out
