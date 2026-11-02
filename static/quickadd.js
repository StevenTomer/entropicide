"use strict";

// Quick add's reading of typed text ("Call dentist tomorrow 3pm #phone !next"), and what it
// needs: the lists, priorities and dates. Loaded before app.js; the server also runs it
// (quickadd_server.js) for tasks typed into the Android app's notification or tile.

// ---- lists, priorities, repeats ----------------------------------------------

const STATES = [
  // "next" shows as Queue: the GTD next-actions list, renamed.
  ["inbox", "Inbox"], ["next", "Queue"], ["soon", "Soon"], ["later", "Later"],
  ["someday", "Someday"], ["waiting", "Waiting"], ["scheduled", "Scheduled"],
];

// Quick add's !word for each list is its name (!queue), or its state (!next).
const LIST_WORDS = Object.fromEntries(STATES.flatMap(([s, label]) => [[s, s], [label.toLowerCase(), s]]));
const PRIORITY_MAX = 99;
const clampPriority = (n) => Math.max(-PRIORITY_MAX, Math.min(PRIORITY_MAX, Math.trunc(n) || 0));
const everyValue = (n, unit) => `every:${n}${unit === "d" ? "" : unit}`;

// ---- days, in the device's time zone ----------------------------------------

function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function nowStamp() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

// Areas in quick add: +work, or +sideprojects for "Side Projects" (case and spaces don't
// matter); the start of a name is enough when only one area begins that way.
const areaWord = (name) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
function areaByWord(word) {
  const w = areaWord(word);
  if (!w) return null;
  const exact = S.data.areas.find((a) => areaWord(a.name) === w);
  if (exact) return exact;
  const starts = S.data.areas.filter((a) => areaWord(a.name).startsWith(w));
  return starts.length === 1 ? starts[0] : null;
}

// People in quick add: @Mom, or @BobSmith for "Bob Smith" (a contact's name or nickname, read
// like areas); the start of one is enough when only one contact begins that way.
// Returns {contact, name}: name is what the title says, the contact's own if typed in full.
function contactByWord(word) {
  const w = areaWord(word);
  if (!w) return null;
  const names = (S.data.contacts || []).flatMap((c) =>
    [c.name, ...(c.nicknames || [])].map((name) => ({ contact: c, name })));
  const exact = names.find((n) => areaWord(n.name) === w);
  if (exact) return exact;
  const starts = new Set(names.filter((n) => areaWord(n.name).startsWith(w)).map((n) => n.contact));
  return starts.size === 1 ? { contact: [...starts][0], name: word } : null;
}

// ---- dates in quick add -------------------------------------------------
// "Call dentist tomorrow 3pm", "Pay rent due nov 1", "Gym mon at 7:30am", "Renew in 2 weeks".
// A date or time on its own is when the task starts; after "due" or "by" it's the due date.

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december"];
// Short day names that are also ordinary words count only after on/due/by/next/this.
const WORDY_DAYS = ["sun", "sat", "wed", "mon"];
// 11/5 is 5 November in the US, 11 May elsewhere.
const MONTH_FIRST = /^en-US|^en-PH|^es-US/.test(navigator.language || "en-US");

function weekdayOf(w, loose) {
  if (w.length < 3 || (!loose && WORDY_DAYS.includes(w))) return -1;
  return WEEKDAYS.findIndex((d) => d.startsWith(w));
}
const monthOf = (w) => w.length < 3 ? -1 : MONTHS.findIndex((m) => m.startsWith(w) || (w === "sept" && m === "september"));
const dayNum = (w) => { const m = /^(\d{1,2})(st|nd|rd|th)?$/.exec(w); return m && +m[1] >= 1 && +m[1] <= 31 ? +m[1] : 0; };
const isoDate = (y, m, d) => {
  const dt = new Date(y, m, d, 12);
  return dt.getMonth() === m ? `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
};
// A day and month without a year: the next time it comes round.
function nextDate(m, d, y) {
  const now = new Date();
  if (y) return isoDate(y, m, d);
  const iso = isoDate(now.getFullYear(), m, d);
  return iso && iso < today() ? isoDate(now.getFullYear() + 1, m, d) : iso;
}
// Days until weekday i: 1-7 ("fri" on a Friday is next week), or 0-6 with "this".
const daysUntil = (i, thisWeek) => (i - new Date(today() + "T12:00:00").getDay() + 7) % 7 || (thisWeek ? 0 : 7);

// The date starting at words[i]: { date, len }, plus time for "tonight", today for "today".
function matchDate(words, i, loose) {
  const [w = "", w2 = "", w3 = ""] = words.slice(i, i + 3);
  const t = today();
  // "mon 9am": a short day name is clearly a day when a time follows.
  loose ||= !!(matchTime(words, i + 1, false) || (w2 === "at" && matchTime(words, i + 2, true)));
  if (w === "today") return { date: t, len: 1, today: true };
  if (w === "tonight") return { date: t, len: 1, time: "18:00" };
  if (["tomorrow", "tmrw", "tmr", "tomorow"].includes(w)) return { date: addDays(t, 1), len: 1 };
  // "this fri": the coming Friday; "next fri": Friday of next week (weeks start on Monday).
  if (w === "this" && weekdayOf(w2, true) >= 0) return { date: addDays(t, daysUntil(weekdayOf(w2, true), true)), len: 2 };
  if (w === "next" && weekdayOf(w2, true) >= 0) {
    return { date: addDays(t, daysUntil(1) + (weekdayOf(w2, true) + 6) % 7), len: 2 };
  }
  if (w === "next" && w2 === "week") return { date: addDays(t, daysUntil(1)), len: 2 };
  if (w === "next" && w2 === "month") {
    const d = new Date(t + "T12:00:00");
    return { date: isoDate(d.getMonth() === 11 ? d.getFullYear() + 1 : d.getFullYear(), (d.getMonth() + 1) % 12, 1), len: 2 };
  }
  if (w === "weekend" || (w === "this" && w2 === "weekend")) return { date: addDays(t, daysUntil(6, true)), len: w === "this" ? 2 : 1 };
  if (weekdayOf(w, loose) >= 0) return { date: addDays(t, daysUntil(weekdayOf(w, loose))), len: 1 };
  if (w === "in") {
    const n = /^\d+$/.test(w2) ? +w2 : w2 === "a" || w2 === "an" || w2 === "one" ? 1 : 0;
    const unit = /^(day|week|month|year)s?$/.exec(w3)?.[1];
    if (n && unit) {
      if (unit === "day") return { date: addDays(t, n), len: 3 };
      if (unit === "week") return { date: addDays(t, 7 * n), len: 3 };
      const d = new Date(t + "T12:00:00");
      const months = d.getMonth() + (unit === "year" ? 12 * n : n);
      const y = d.getFullYear() + Math.floor(months / 12), m = months % 12;
      return { date: isoDate(y, m, Math.min(d.getDate(), new Date(y, m + 1, 0).getDate())), len: 3 };
    }
  }
  // "nov 5", "november 5th 2027", "5 nov"
  const year = (x) => /^\d{4}$/.test(x) ? +x : 0;
  if (monthOf(w) >= 0 && dayNum(w2)) {
    const date = nextDate(monthOf(w), dayNum(w2), year(w3));
    if (date) return { date, len: year(w3) ? 3 : 2 };
  }
  if (dayNum(w) && monthOf(w2) >= 0) {
    const date = nextDate(monthOf(w2), dayNum(w), year(w3));
    if (date) return { date, len: year(w3) ? 3 : 2 };
  }
  // "11/5", "11/5/27", "2026-11-05"
  let m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(w);
  if (m) {
    const [a, b] = MONTH_FIRST ? [+m[1], +m[2]] : [+m[2], +m[1]];
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : 0;
    const date = a >= 1 && a <= 12 && b >= 1 && b <= 31 && nextDate(a - 1, b, y);
    if (date) return { date, len: 1 };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w);
  if (m) { const date = isoDate(+m[1], +m[2] - 1, +m[3]); if (date) return { date, len: 1 }; }
  return null;
}

// The time starting at words[i] as "HH:MM": 3pm, 3:30 pm, 15:00, noon; after "at", 3 alone too.
function matchTime(words, i, at) {
  const [w = "", w2 = ""] = words.slice(i, i + 2);
  const hhmm = (h, min) => `${String(h).padStart(2, "0")}:${min || "00"}`;
  const ampm = (h, min, p) => h >= 1 && h <= 12 ? hhmm(h % 12 + (p[0] === "p" ? 12 : 0), min) : null;
  if (w === "noon") return { time: "12:00", len: 1 };
  let m = /^(\d{1,2})(?::([0-5]\d))?(am|pm|a|p)$/.exec(w);
  if (m) { const time = ampm(+m[1], m[2], m[3]); if (time) return { time, len: 1 }; }
  m = /^(\d{1,2})(?::([0-5]\d))?$/.exec(w);
  if (m && /^(am|pm|a\.m\.|p\.m\.)$/.test(w2)) { const time = ampm(+m[1], m[2], w2); if (time) return { time, len: 2 }; }
  m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(w);
  if (m) return { time: hhmm(+m[1], m[2]), len: 1 };
  // "at 3": 7 to 11 in the morning, 12 to 6 in the afternoon.
  if (at && (m = /^(\d{1,2})$/.exec(w)) && +m[1] >= 1 && +m[1] <= 12) {
    return { time: hhmm(+m[1] >= 7 && +m[1] <= 11 ? +m[1] : +m[1] % 12 + 12), len: 1 };
  }
  return null;
}

// The next date (after today) that's the nth (-1: last) weekday (Monday 0) of its month.
function nextNth(nth, day) {
  const t = today();
  for (let k = 0; k < 3; k++) {
    const first = new Date(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1 + k, 1, 12);
    let d;
    if (nth > 0) d = new Date(first.getFullYear(), first.getMonth(), 1 + ((day - (first.getDay() + 6) % 7 + 7) % 7) + 7 * (nth - 1), 12);
    else {
      const last = new Date(first.getFullYear(), first.getMonth() + 1, 0, 12);
      d = new Date(last.getFullYear(), last.getMonth(), last.getDate() - (((last.getDay() + 6) % 7 - day + 7) % 7), 12);
    }
    const iso = isoDate(d.getFullYear(), d.getMonth(), d.getDate());
    if (iso > t) return iso;
  }
}

// After "every": "day", "weekday", "week", "2 weeks", "other month", "3 months", "year",
// "9 days", or a day of the week ("every monday": weekly, from the next Monday), or several
// ("every mon, wed and fri": on those days, from the next of them), or a weekday of the month
// ("every first monday", "every 2nd tue", "every last friday (of the month)").
function matchRepeat(words, i) {
  const [w = "", w2 = ""] = words.slice(i, i + 2);
  const named = { day: "daily", weekday: "weekdays", week: "weekly", month: "monthly", year: "yearly" };
  if (named[w]) return { repeat: named[w], len: 1 };
  const unit = (x) => /^(day|week|month|year)s?$/.exec(x)?.[1];
  const n = w === "other" ? 2 : /^\d{1,3}$/.test(w) && +w >= 1 ? +w : 0;
  if (n && unit(w2)) {
    const u = unit(w2);
    return { repeat: n === 1 ? named[u] : everyValue(n, u[0] === "d" ? "d" : u[0]), len: 2 };
  }
  const nth = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, last: -1 }[w];
  const nthDay = nth ? weekdayOf(w2, true) : -1;
  if (nthDay >= 0) {
    const tail = words.slice(i + 2, i + 5).join(" ");
    const len = 2 + (/^of (the|every|each) month\b/.test(tail) ? 3 : /^of month\b/.test(tail) ? 2 : 0);
    const day = (nthDay + 6) % 7;  // (counted from Monday, 0)
    return { repeat: `nth:${nth}:${day}`, date: nextNth(nth, day), len };
  }
  const days = [];
  let len = 0;
  for (let j = i; j < words.length; j++) {
    const d = weekdayOf(words[j], true);
    if (d >= 0) { days.push(d); len = j - i + 1; }
    else if (!(days.length && ["and", "&", ","].includes(words[j]))) break;
  }
  if (!days.length) return null;
  const date = addDays(today(), Math.min(...days.map((d) => daysUntil(d))));
  if (new Set(days).size === 1) return { repeat: "weekly", date, len };
  // (days:… counts from Monday, 0; these from Sunday)
  return { repeat: "days:" + [...new Set(days.map((d) => (d + 6) % 7))].sort().join(","), date, len };
}

// Takes the first start date, due date and time out of words.
function parseWhen(words) {
  const lc = words.map((w) => w.toLowerCase().replace(/[,;]+$/, ""));
  const out = { rest: [] };
  for (let i = 0; i < words.length;) {
    const w = lc[i];
    const due = w === "due" || w === "by";
    const j = due || w === "on" ? i + 1 : i;
    const d = !(due ? out.due_date : out.start_date) && matchDate(lc, j, j > i);
    if (d) {
      if (due) out.due_date = d.date;
      else Object.assign(out, { start_date: d.date, today: d.today, defaultTime: d.time });
      i = j + d.len;
      continue;
    }
    const r = w === "every" && !out.repeat && matchRepeat(lc, i + 1);
    if (r) {
      out.repeat = r.repeat;
      if (r.date && !out.start_date) out.start_date = r.date;
      i += 1 + r.len;
      continue;
    }
    const k = w === "at" ? i + 1 : i;
    const t = !out.start_time && matchTime(lc, k, k > i);
    if (t) { out.start_time = t.time; i = k + t.len; continue; }
    out.rest.push(words[i]);
    i++;
  }
  out.start_time ||= out.defaultTime || null;
  // A time with no start date: the next time it comes round (or on the due date).
  if (out.start_time && !out.start_date) {
    out.start_date = out.due_date || (out.start_time > nowStamp().slice(11) ? today() : addDays(today(), 1));
  }
  delete out.defaultTime;
  return out;
}

// What quick add's dates do to a new task: a later start schedules it (unless a list was
// named), so it waits in Scheduled; "today" with no time stars it, for Focus.
function whenFields(parsed) {
  const f = {};
  if (parsed.due_date) f.due_date = parsed.due_date;
  if (!parsed.start_date) return f;
  const now = nowStamp();
  const later = parsed.start_date > now.slice(0, 10) ||
    (parsed.start_date === now.slice(0, 10) && parsed.start_time && parsed.start_time > now.slice(11));
  if (later) {
    Object.assign(f, { start_date: parsed.start_date, start_time: parsed.start_time || null });
    if (!parsed.state) f.state = "scheduled";
  } else if (parsed.start_time) {
    Object.assign(f, { start_date: parsed.start_date, start_time: parsed.start_time });
  } else {
    f.focus = true;
  }
  return f;
}

function parseQuickAdd(text) {
  const out = { tags: [], people: [] };
  const words = [];
  for (const w of text.split(/\s+/)) {
    if (/^#\S+/.test(w)) out.tags.push(w.slice(1));
    else if (w === "!focus" || w === "*") out.focus = true;
    else if (/^!\w+$/.test(w) && LIST_WORDS[w.slice(1).toLowerCase()]) out.state = LIST_WORDS[w.slice(1).toLowerCase()];
    else if (/^!-?\d+$/.test(w)) out.priority = clampPriority(Number(w.slice(1)));
    else if (/^\+\S+/.test(w) && areaByWord(w.slice(1))) out.area_id = areaByWord(w.slice(1)).id;
    else if (/^@\S/.test(w)) {
      // (Punctuation after the name stays: "Call @Mom, then…")
      const [, word, tail] = /^@(.*?)([.,;:!?)]*)$/.exec(w);
      const found = contactByWord(word);
      if (found && !out.people.includes(found.contact.id)) out.people.push(found.contact.id);
      words.push(found ? found.name + tail : w);
    }
    else words.push(w);
  }
  const when = parseWhen(words);
  out.title = when.rest.join(" ").trim();
  for (const k of ["start_date", "start_time", "due_date", "repeat"]) if (when[k]) out[k] = when[k];
  return out;
}
