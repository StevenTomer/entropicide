// Reads a task typed on the phone (the Android app's notification or tile) the way quick add
// does in the browser, by running static/quickadd.js itself. app.py's app_add runs it as
//   TZ=<the user's time zone> node quickadd_server.js
// with {"text", "lang", "now", "areas": [{id, name}]} on stdin (now: when it was typed,
// YYYY-MM-DDTHH:MM on the phone); it writes the new task's fields
// (title, state, tags, dates, …) as JSON. The time zone makes "today" the user's.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const context = vm.createContext({
  navigator: { language: input.lang || "en-US" },
  S: { data: { areas: input.areas || [] } },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "static", "quickadd.js"), "utf8"), context);
// Typed earlier (sent once the phone was back online): read dates from when it was typed.
if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.now || "")) {
  context.typedAt = input.now;
  vm.runInContext("today = () => typedAt.slice(0, 10); nowStamp = () => typedAt;", context);
}
// Like app.js's quickAdd, from the Inbox (no list or project open).
const task = vm.runInContext(`(() => {
  const parsed = parseQuickAdd(${JSON.stringify(String(input.text || ""))});
  const task = { title: parsed.title, tags: parsed.tags, state: parsed.state || "inbox" };
  if (parsed.focus) task.focus = true;
  if (parsed.priority) task.priority = parsed.priority;
  if (parsed.repeat) task.repeat = parsed.repeat;
  if (parsed.area_id) task.area_id = parsed.area_id;
  Object.assign(task, whenFields(parsed));
  if (task.state === "scheduled" && !task.start_date) task.start_date = addDays(today(), 1);
  return task;
})()`, context);
process.stdout.write(JSON.stringify(task));
