var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  DEFAULT_SETTINGS: () => DEFAULT_SETTINGS,
  default: () => KanbanPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian3 = require("obsidian");

// src/KanbanView.ts
var import_obsidian2 = require("obsidian");

// src/kanban.ts
var import_obsidian = require("obsidian");
function buildConfig(settings) {
  const normKanban = settings.kanban.map(normalizeTag);
  return {
    kanban: settings.kanban,
    parentPages: settings.parentPages,
    allVaultNotes: settings.allVaultNotes,
    doneColumn: settings.doneColumn,
    startColumn: settings.startColumn,
    dueColumn: settings.dueColumn,
    laterColumn: settings.laterColumn,
    newTaskInsert: settings.newTaskInsert,
    normKanban,
    normDone: normalizeTag(settings.doneColumn),
    normStart: normalizeTag(settings.startColumn),
    normDue: normalizeTag(settings.dueColumn),
    normLater: normalizeTag(settings.laterColumn),
    recurrentColumn: settings.recurrentColumn || "#recurrent",
    normRecurrent: normalizeTag(settings.recurrentColumn || "#recurrent"),
    normProject: (settings.projectColumns || []).map(normalizeTag),
    normActive: (settings.activeColumns && settings.activeColumns.length ? settings.activeColumns : ["#next", "#important", "#today"]).map(normalizeTag),
    projectsDocument: settings.projectsDocument || "",
    allChildrenDoneColor: settings.allChildrenDoneColor,
    columnColors: Object.fromEntries(
      (settings.kanban || []).map((tag, i) => [normalizeTag(tag), (settings.columnColors || [])[i] || ""])
    ),
    columnMaxCards: Object.fromEntries(
      (settings.kanban || []).map((tag, i) => [normalizeTag(tag), (settings.columnMaxCards || [])[i] || 0])
    ),
    colorColumnOverLimit: settings.colorColumnOverLimit || "#5c1a1a",
    colorCardBg: settings.colorCardBg || "",
    colorColumnBg: settings.colorColumnBg || "",
    colorText: settings.colorText || "",
    colorAccent: settings.colorAccent || "",
    colorLink: settings.colorLink || "",
    colorFamilySelf: settings.colorFamilySelf || "#e03e3e",
    colorFamilyParent: settings.colorFamilyParent || "#2db55d",
    colorFamilySibling: settings.colorFamilySibling || "#4a90d9",
    colorDate: settings.colorDate || "#7ab8e8",
    fontDate: settings.fontDate || "monospace",
    colorBold: settings.colorBold || "",
    colorItalicStar: settings.colorItalicStar || "",
    colorItalicUnderscore: settings.colorItalicUnderscore || ""
  };
}
function validateConfig(settings) {
  const normKanban = settings.kanban.map(normalizeTag);
  const normDone = normalizeTag(settings.doneColumn);
  const normStart = normalizeTag(settings.startColumn);
  const normDue = normalizeTag(settings.dueColumn);
  const normLater = normalizeTag(settings.laterColumn);
  if (!settings.kanban.length)
    return "Missing/empty 'Kanban columns' setting.";
  if (!settings.doneColumn || !normKanban.includes(normDone))
    return "'Done column' must match one of the Kanban columns.";
  if (!settings.startColumn || !normKanban.includes(normStart))
    return "'Start column in single row view' must match one of the Kanban columns.";
  if (!settings.dueColumn || !normKanban.includes(normDue))
    return "'Target column for due later and recurrent tasks' must match one of the Kanban columns.";
  if (!settings.laterColumn || !normKanban.includes(normLater))
    return "'Later column' must match one of the Kanban columns.";
  if (normDue === normLater)
    return "'Target column for due later and recurrent tasks' and 'Later column' must be different.";
  if (!settings.allVaultNotes && !settings.parentPages.length)
    return "Add at least one 'Parent page', or enable 'Scan all vault notes'.";
  if (!settings.newTaskInsert)
    return "Missing 'New task insert location' \u2014 set a note name in settings.";
  return null;
}
var normalizeTag = (tag) => (tag || "").trim().replace(/^#/, "").replace(/_$/, "").toLowerCase();
var matchesKanbanTag = (raw, normList) => normList.includes(normalizeTag(raw));
function extractTags(text) {
  const cleaned = text.replace(/`[^`]*`/g, "").replace(/["'""][^"'""]*["'""]/g, "");
  return cleaned.match(/(?<!\w)#\w+/g) || [];
}
function parseOrderComment(text) {
  const m = text.match(/%% @(\d+)(\w) %%/);
  if (!m)
    return null;
  const stateChar = m[2].toLowerCase();
  const state = stateChar === "x" ? "expanded" : stateChar === "c" ? "collapsed" : null;
  if (!state)
    return null;
  return /[1-9]/.test(m[1]) ? { digits: m[1], state, len: m[1].length } : null;
}
function parseTaskLine(raw) {
  const indent = (raw.match(/^(\s*)/) || ["", ""])[1];
  let rest = raw.slice(indent.length);
  let orderDigits = null;
  let orderState = null;
  const om = rest.match(/%% @(\d+)(\w) %%/);
  if (om) {
    orderDigits = om[1];
    orderState = om[2].toLowerCase() === "x" ? "expanded" : "collapsed";
  }
  let skipDate = null;
  const sm = rest.match(/%% @skip:(\d{4}-\d{2}-\d{2}) %%/);
  if (sm)
    skipDate = sm[1];
  rest = rest.replace(/\s*%%[\s\S]*?%%\s*/g, " ").trim();
  let date = null;
  const dm = rest.match(/(^|\s)(@\d{4}-\d{2}-\d{2})\b/);
  if (dm)
    date = dm[2];
  rest = rest.replace(/\s*(?:^|\s)@\d{4}-\d{2}-\d{2}\b/g, "").trim();
  let doneDate = null;
  const ddm = rest.match(/✅(\d{4}-\d{2}-\d{2})/);
  if (ddm)
    doneDate = ddm[1];
  rest = rest.replace(/\s*✅\d{4}-\d{2}-\d{2}/, "").trim();
  let bullet = "";
  let checked = null;
  const cbm = rest.match(/^([-*+])\s+\[([^\]]*)\]\s*/);
  if (cbm) {
    bullet = cbm[1];
    checked = cbm[2].trim().toLowerCase() === "x";
    rest = rest.slice(cbm[0].length);
  } else {
    const bm = rest.match(/^([-*+])\s+/);
    if (bm) {
      bullet = bm[1];
      rest = rest.slice(bm[0].length);
    }
  }
  const tags = rest.match(/(?<!\w)#\w+/g) || [];
  const text = rest.replace(/\s*(?<!\w)#\w+/g, "").trim();
  return { indent, bullet, checked, text, tags, date, doneDate, orderDigits, orderState, skipDate };
}
function serializeTaskLine(t) {
  const parts = [];
  if (t.bullet) {
    parts.push(t.checked !== null ? `${t.bullet} [${t.checked ? "x" : " "}]` : t.bullet);
  }
  if (t.text)
    parts.push(t.text);
  parts.push(...t.tags);
  if (t.date)
    parts.push(t.date);
  if (t.doneDate)
    parts.push(`\u2705${t.doneDate}`);
  if (t.orderDigits && t.orderState !== null) {
    parts.push(`%% @${t.orderDigits}${t.orderState === "expanded" ? "x" : "c"} %%`);
  }
  if (t.skipDate) {
    parts.push(`%% @skip:${t.skipDate} %%`);
  }
  return t.indent + parts.join(" ");
}
async function updateFileOrderComment(app, filePath, lineNum, newDigits, newState = null) {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    if (lineNum < 1 || lineNum > lines.length)
      return false;
    const parsed = parseTaskLine(lines[lineNum - 1]);
    const digits = newDigits ?? parsed.orderDigits;
    if (!digits)
      return false;
    const state = newState ?? parsed.orderState ?? "collapsed";
    if (parsed.orderDigits === digits && parsed.orderState === state)
      return true;
    parsed.orderDigits = digits;
    parsed.orderState = state;
    lines[lineNum - 1] = serializeTaskLine(parsed);
    await app.vault.modify(tFile, lines.join("\n"));
    return true;
  } catch (e) {
    console.error("updateFileOrderComment failed:", e);
    return false;
  }
}
function compareDigits(a, b) {
  const l = Math.max(a.length, b.length);
  const pa = a.padEnd(l, "0");
  const pb = b.padEnd(l, "0");
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}
function compareCardsByDigits(a, b) {
  if (a.digits == null && b.digits == null)
    return (a.discoveryIndex || 0) - (b.discoveryIndex || 0);
  if (a.digits == null)
    return 1;
  if (b.digits == null)
    return -1;
  const c = compareDigits(a.digits, b.digits);
  return c !== 0 ? c : (a.discoveryIndex || 0) - (b.discoveryIndex || 0);
}
function calcMidDigits(prev, next, isEnd) {
  const l = Math.max(prev.len || 1, next?.len || 1);
  const a = BigInt(prev.digits.padEnd(l, "0"));
  const b = isEnd ? 10n ** BigInt(l) : BigInt((next.digits || "0").padEnd(l, "0"));
  const sum = a + b;
  const mid = sum / 2n;
  if (sum % 2n === 0n) {
    return { digits: mid.toString().padStart(l, "0"), len: l };
  }
  const digs = (mid * 10n + 5n).toString().padStart(l + 1, "0");
  return { digits: digs, len: l + 1 };
}
function calcInsertOrder(siblingData, insertIndex, isMulti = false) {
  const n = siblingData.length;
  if (insertIndex === 0 || isMulti) {
    return n === 0 ? { digits: "5", len: 1 } : calcMidDigits({ digits: "0", len: 1 }, siblingData[0], false);
  }
  if (insertIndex >= n)
    return calcMidDigits(siblingData[n - 1], null, true);
  return calcMidDigits(siblingData[insertIndex - 1], siblingData[insertIndex], false);
}
function parseCardDate(text) {
  const m = text.match(/@(\d{4}-\d{2}-\d{2})/);
  if (!m)
    return null;
  const d = new Date(m[1] + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}
var TRIGGER_WEEKDAYS_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
var TRIGGER_WEEKDAYS_FULL = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
var TRIGGER_MONTHS_SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
var TRIGGER_MONTHS_FULL = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function hasRecurrentAnnotation(text, normRecurrent) {
  return new RegExp(`@${normRecurrent}\\b`, "i").test(text);
}
function extractTriggerAnnotations(text, normRecurrent) {
  const cleaned = text.replace(/%%[\s\S]*?%%/g, "").replace(/@repeat:\d+(?:day|week|month|year)s?\b/gi, "");
  const matches = cleaned.match(/@([a-zA-Z][a-zA-Z_]*(?:[+-]\d+)?|\d{1,2})\b/g) || [];
  return matches.map((m) => m.slice(1).toLowerCase()).filter((m) => m !== normRecurrent);
}
function extractRepeatSpec(text) {
  const m = text.match(/@repeat:(\d+)(day|week|month|year)s?\b/i);
  if (!m)
    return null;
  return { count: parseInt(m[1], 10), unit: m[2].toLowerCase() };
}
function formatRepeatAnnotation(spec) {
  return `@repeat:${spec.count}${spec.unit}`;
}
function formatRepeatLabel(spec) {
  const plural = spec.count === 1 ? spec.unit : `${spec.unit}s`;
  return `every ${spec.count} ${plural}`;
}
function formatDateAnnotation(d) {
  return `@${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addRepeatInterval(base, spec) {
  const d = new Date(base);
  switch (spec.unit) {
    case "day":
      d.setDate(d.getDate() + spec.count);
      break;
    case "week":
      d.setDate(d.getDate() + spec.count * 7);
      break;
    case "month":
      d.setMonth(d.getMonth() + spec.count);
      break;
    case "year":
      d.setFullYear(d.getFullYear() + spec.count);
      break;
  }
  return d;
}
function lastDayOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}
function matchesTriggerAnnotations(triggers, today) {
  if (!triggers.length)
    return false;
  const todayWeekday = today.getDay();
  const todayDate = today.getDate();
  const todayMonth = today.getMonth();
  const lastDay = lastDayOfMonth(today);
  for (const t of triggers) {
    if (t === "last_day") {
      if (todayDate === lastDay)
        return true;
      continue;
    }
    if (t === "quarterly" || t === "q+1") {
      if (todayDate === 1 && [0, 3, 6, 9].includes(todayMonth))
        return true;
      continue;
    }
    if (t === "quarterly+2" || t === "q+2") {
      if (todayDate === 1 && [1, 4, 7, 10].includes(todayMonth))
        return true;
      continue;
    }
    if (t === "quarterly+3" || t === "q+3") {
      if (todayDate === 1 && [2, 5, 8, 11].includes(todayMonth))
        return true;
      continue;
    }
    const wdShort = TRIGGER_WEEKDAYS_SHORT.indexOf(t);
    if (wdShort !== -1) {
      if (wdShort === todayWeekday)
        return true;
      continue;
    }
    const wdFull = TRIGGER_WEEKDAYS_FULL.indexOf(t);
    if (wdFull !== -1) {
      if (wdFull === todayWeekday)
        return true;
      continue;
    }
    const mShort = TRIGGER_MONTHS_SHORT.indexOf(t);
    if (mShort !== -1) {
      if (mShort === todayMonth && todayDate === 1)
        return true;
      continue;
    }
    const mFull = TRIGGER_MONTHS_FULL.indexOf(t);
    if (mFull !== -1) {
      if (mFull === todayMonth && todayDate === 1)
        return true;
      continue;
    }
    if (/^\d{1,2}$/.test(t)) {
      const dayNum = parseInt(t, 10);
      if (dayNum >= 1 && dayNum <= 31) {
        const effectiveDay = Math.min(dayNum, lastDay);
        if (effectiveDay === todayDate)
          return true;
      }
    }
  }
  return false;
}
function isValidTriggerToken(t) {
  if (t === "last_day")
    return true;
  if (t === "quarterly" || t === "quarterly+2" || t === "quarterly+3" || t === "q+1" || t === "q+2" || t === "q+3")
    return true;
  return TRIGGER_WEEKDAYS_SHORT.includes(t) || TRIGGER_WEEKDAYS_FULL.includes(t) || TRIGGER_MONTHS_SHORT.includes(t) || TRIGGER_MONTHS_FULL.includes(t) || /^\d{1,2}$/.test(t) && parseInt(t, 10) >= 1 && parseInt(t, 10) <= 31;
}
function hasValidTriggers(text, normRecurrent) {
  return extractRepeatSpec(text) !== null || extractTriggerAnnotations(text, normRecurrent).some(isValidTriggerToken);
}
function extractSkipDate(rawLine) {
  const m = rawLine.match(/%% @skip:(\d{4}-\d{2}-\d{2}) %%/);
  return m ? m[1] : null;
}
function setSkipDate(line, dateStr) {
  const cleaned = line.replace(/\s*%% @skip:\d{4}-\d{2}-\d{2} %%/g, "").trimEnd();
  return `${cleaned} %% @skip:${dateStr} %%`;
}
async function addTagAndSkipDate(app, filePath, lineNum, tag, dateStr) {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    const idx = lineNum - 1;
    if (idx < 0 || idx >= lines.length)
      return;
    const parsed = parseTaskLine(lines[idx]);
    if (!parsed.tags.includes(tag))
      parsed.tags.push(tag);
    lines[idx] = serializeTaskLine(parsed);
    lines[idx] = setSkipDate(lines[idx], dateStr);
    await writeFileLines(app, tFile, lines);
  } catch {
  }
}
async function addTagAndClearDate(app, filePath, lineNum, tag) {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    const idx = lineNum - 1;
    if (idx < 0 || idx >= lines.length)
      return;
    const parsed = parseTaskLine(lines[idx]);
    if (!parsed.tags.includes(tag))
      parsed.tags.push(tag);
    parsed.date = null;
    lines[idx] = serializeTaskLine(parsed);
    await writeFileLines(app, tFile, lines);
  } catch {
  }
}
async function triggerDatedLaterSubs(app, subs, filePath, config, today) {
  if (!subs || !subs.length)
    return false;
  let changed = false;
  for (const sub of subs) {
    if (!sub.tags.some((t) => config.normKanban.includes(normalizeTag(t)))) {
      const d = parseCardDate(sub.text);
      if (d && d <= today) {
        await addTagAndClearDate(app, filePath, sub.line, config.dueColumn);
        changed = true;
      }
    }
    if (sub.subs?.length) {
      if (await triggerDatedLaterSubs(app, sub.subs, filePath, config, today))
        changed = true;
    }
  }
  return changed;
}
async function triggerRecurrentSubs(app, subs, filePath, config, today, todayStr) {
  if (!subs || !subs.length)
    return false;
  let changed = false;
  for (const sub of subs) {
    if (!sub.tags.some((t) => config.normKanban.includes(normalizeTag(t)))) {
      const repeatDate = parseCardDate(sub.text);
      const fires = repeatDate ? repeatDate <= today : matchesTriggerAnnotations(extractTriggerAnnotations(sub.text, config.normRecurrent), today);
      if (hasRecurrentAnnotation(sub.text, config.normRecurrent) && fires && extractSkipDate(sub.text) !== todayStr) {
        await addTagAndSkipDate(app, filePath, sub.line, config.dueColumn, todayStr);
        changed = true;
      }
    }
    if (sub.subs?.length) {
      if (await triggerRecurrentSubs(app, sub.subs, filePath, config, today, todayStr))
        changed = true;
    }
  }
  return changed;
}
function hasDatedSub(subs) {
  if (!subs?.length)
    return false;
  for (const sub of subs) {
    if (parseCardDate(sub.text))
      return true;
    if (hasDatedSub(sub.subs))
      return true;
  }
  return false;
}
function isLaterDueToday(text, today, normRecurrent) {
  const d = parseCardDate(text);
  if (d)
    return d <= today;
  const triggers = extractTriggerAnnotations(text, normRecurrent).filter(isValidTriggerToken);
  if (triggers.length)
    return matchesTriggerAnnotations(triggers, today);
  return true;
}
function getNextMonday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const diff = (8 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d;
}
function getTomorrow() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d;
}
function getNextWeekend() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const diff = (6 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d;
}
function getInSevenDays() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 7);
  return d;
}
function getInThirtyDays() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 30);
  return d;
}
function getNextMonth() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setMonth(d.getMonth() + 1);
  return d;
}
var DATE_PRESETS = [
  ["tomorrow", "Tomorrow", getTomorrow],
  ["weekend", "Next weekend", getNextWeekend],
  ["monday", "Next monday", getNextMonday],
  ["sevendays", "In 7 days", getInSevenDays],
  ["month", "Next month", getNextMonth],
  ["thirtydays", "In 30 days", getInThirtyDays]
];
function getDefaultDate(existing = null) {
  if (!(existing instanceof Date) || isNaN(existing.getTime()))
    return getNextMonday();
  const c = new Date(existing);
  c.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return c <= today ? getNextMonday() : c;
}
var TRIGGER_LINE_STYLE = `display:block;font-size:.8em;color:var(--kb-date-color);font-family:var(--kb-date-font);margin-top:2px;`;
var TITLE_FONT_WEIGHT = 600;
function collapseWeekdayLabels(triggers) {
  const weekdayIndex = (label) => {
    const s = TRIGGER_WEEKDAYS_SHORT.indexOf(label);
    return s !== -1 ? s : TRIGGER_WEEKDAYS_FULL.indexOf(label);
  };
  let firstPos = -1;
  const present = /* @__PURE__ */ new Set();
  triggers.forEach((label, i) => {
    const idx = weekdayIndex(label);
    if (idx !== -1) {
      present.add(idx);
      if (firstPos === -1)
        firstPos = i;
    }
  });
  const hasAllWeekdays = [1, 2, 3, 4, 5].every((i) => present.has(i));
  if (!hasAllWeekdays)
    return;
  let combined;
  if (present.has(0) && present.has(6))
    combined = "every day";
  else if (present.has(6))
    combined = "week day+sat";
  else if (present.has(0))
    combined = "week day+sun";
  else
    combined = "week day";
  for (let i = triggers.length - 1; i >= 0; i--) {
    if (weekdayIndex(triggers[i]) !== -1)
      triggers.splice(i, 1);
  }
  triggers.splice(firstPos, 0, combined);
}
function formatTriggerAnnotations(text, normRecurrent, clickable = true) {
  if (!normRecurrent)
    return text;
  let hasRecurrent = false;
  const triggers = [];
  text = text.replace(new RegExp(`@${normRecurrent}\\b`, "gi"), () => {
    hasRecurrent = true;
    return "";
  });
  text = text.replace(/@repeat:(\d+)(day|week|month|year)s?\b/gi, (_match, count, unit) => {
    triggers.push(formatRepeatLabel({ count: parseInt(count, 10), unit: unit.toLowerCase() }));
    return "";
  });
  text = text.replace(/@([a-zA-Z][a-zA-Z_]*(?:[+-]\d+)?|\d{1,2})\b/g, (match, token) => {
    const t = token.toLowerCase();
    if (!isValidTriggerToken(t))
      return match;
    const label = t === "last_day" ? "last day" : t;
    triggers.push(label);
    return "";
  });
  text = text.replace(/\s{2,}/g, " ").trim();
  collapseWeekdayLabels(triggers);
  if (triggers.length) {
    const label = `\u21BB ${triggers.join("\xB7")}`;
    const spanStyle = clickable ? `${TRIGGER_LINE_STYLE}cursor:pointer;text-decoration:underline dotted;` : TRIGGER_LINE_STYLE.replace("display:block", "display:inline");
    const spanClass = clickable ? `class="kb-trigger-label" ` : "";
    text += `<span ${spanClass}style="${spanStyle}">${label}</span>`;
  }
  return text;
}
function formatCardDateAnnotation(text, inline = false) {
  return text.replace(/@(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => {
    const dateVal = new Date(Number(y), Number(m) - 1, Number(d));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((dateVal.getTime() - today.getTime()) / 864e5);
    let label;
    if (diffDays === 0)
      label = "today";
    else if (diffDays === 1)
      label = "tomorrow";
    else if (diffDays > 1 && diffDays <= 7) {
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      label = `next ${days[dateVal.getDay()]}`;
    } else {
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      label = `${months[Number(m) - 1]} ${Number(d)}`;
    }
    const display = inline ? "inline" : "block";
    return `<span class="kb-date-label" data-date="${y}-${m}-${d}" style="display:${display};font-size:.8em;color:var(--kb-date-color);font-family:var(--kb-date-font);cursor:pointer;text-decoration:underline dotted;">${label}</span>`;
  });
}
function formatInlineEmphasis(text, baseWeight = 400) {
  const boldWeight = Math.min(baseWeight * 2, 1e3);
  const strokeWidth = (boldWeight - baseWeight) / 800;
  text = text.replace(/\*\*([^\n<]+?)\*\*/g, (_, inner) => `<strong style="font-weight:${boldWeight};-webkit-text-stroke:${strokeWidth}px currentColor;color:var(--kb-bold-color);">${inner}</strong>`);
  text = text.replace(/\*([^\n<]+?)\*/g, (_, inner) => `<em style="color:var(--kb-italic-star-color);">${inner}</em>`);
  text = text.replace(/(?<![\w_])_([^_\n<]+?)_(?![\w_])/g, (_, inner) => `<em style="color:var(--kb-italic-underscore-color);">${inner}</em>`);
  return text;
}
function linksToHtml(text, vaultName) {
  text = text.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_, path, alias) => {
      let filePath = path.includes("#") ? path.split("#")[0] : path;
      if (!filePath.endsWith(".md"))
        filePath += ".md";
      const section = path.includes("#") ? path.split("#")[1] : "";
      let href = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePath)}`;
      if (section)
        href += `&section=${encodeURIComponent(section)}`;
      const noteName = filePath.split("/").pop().replace(/\.md$/, "");
      const label = (alias || noteName).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<a href="${href}" style="color:var(--kb-link);text-decoration:underline dotted;text-underline-offset:2px;">${label}</a>`;
    }
  );
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_, label, url) => {
      const title = label.replace(/"/g, "&quot;");
      return `<a href="${url}" target="_blank" rel="noopener" title="${title}" style="display:inline-block;padding:0 5px;border-radius:4px;border:1px solid var(--kb-link);color:var(--kb-link);text-decoration:none;font-size:.8em;line-height:1.6;vertical-align:middle;">\u{1F517}</a>`;
    }
  );
  text = text.replace(/<(https?:\/\/[^\s<>"]+)>|(?<!href=")(https?:\/\/[^\s<>"]+)/g, (_, bracketed, bare) => {
    const url = bracketed ?? bare;
    const title = url.replace(/"/g, "&quot;");
    return `<a href="${url}" target="_blank" rel="noopener" title="${title}" style="display:inline-block;padding:0 5px;border-radius:4px;border:1px solid var(--kb-link);color:var(--kb-link);text-decoration:none;font-size:.8em;line-height:1.6;vertical-align:middle;">\u{1F517}</a>`;
  });
  return text;
}
function renderCheckbox(text, opts = {}) {
  const {
    isSub = false,
    showCheckbox = true,
    vaultName = null,
    enablePromotion = false,
    subLine = null,
    parentTag = null,
    parentDigits = null
  } = opts;
  let content = text.trim();
  let cbHtml = "";
  if (/^- \[[ xX]\] /.test(content)) {
    const checked = content[3] !== " ";
    content = content.slice(6);
    if (showCheckbox) {
      if (isSub && subLine != null) {
        cbHtml = `<input type="checkbox" class="kb-sub-check" data-sub-line="${subLine}"${checked ? " checked" : ""} style="margin-right:5px;cursor:pointer;">`;
      } else {
        cbHtml = `<input type="checkbox" disabled${checked ? " checked" : ""} style="margin-right:5px;">`;
      }
    }
  } else if (/^[-*+]\s+/.test(content)) {
    content = content.replace(/^[-*+]\s+/, "");
    cbHtml = showCheckbox ? `<input type="checkbox" disabled style="margin-right:5px;">` : "\u2022 ";
  }
  if (vaultName)
    content = linksToHtml(content, vaultName);
  content = formatInlineEmphasis(content);
  const promoteHtml = enablePromotion && isSub && subLine && parentTag && parentDigits !== null ? `<span class="promote-icon" style="margin-left:6px;font-size:1.2em;cursor:pointer;color:var(--kb-accent);"
           data-line="${subLine}" data-parent-tag="${parentTag}" data-parent-digits="${parentDigits}">&#9655</span>` : "";
  return `${cbHtml}${content}${promoteHtml}`;
}
async function readFileLines(app, filePath) {
  const tFile = app.vault.getAbstractFileByPath(filePath);
  if (!tFile)
    throw new Error(`File not found: ${filePath}`);
  return { tFile, lines: (await app.vault.read(tFile)).split("\n") };
}
async function writeFileLines(app, tFile, lines) {
  await app.vault.modify(tFile, lines.join("\n"));
}
async function updateCardDate(app, filePath, lineNum, newDateStr) {
  const { tFile, lines } = await readFileLines(app, filePath);
  if (lineNum < 1 || lineNum > lines.length)
    return;
  const parsed = parseTaskLine(lines[lineNum - 1]);
  parsed.date = newDateStr;
  lines[lineNum - 1] = serializeTaskLine(parsed);
  await writeFileLines(app, tFile, lines);
}
async function updateCardTriggers(app, filePath, lineNum, normRecurrent, newTriggerStr) {
  const { tFile, lines } = await readFileLines(app, filePath);
  if (lineNum < 1 || lineNum > lines.length)
    return;
  const parsed = parseTaskLine(lines[lineNum - 1]);
  parsed.text = parsed.text.replace(/@repeat:\d+(?:day|week|month|year)s?\b/gi, "").replace(/@([a-zA-Z][a-zA-Z_]*(?:[+-]\d+)?|\d{1,2})\b/g, (match, token) => {
    const t = token.toLowerCase();
    if (t === normRecurrent)
      return match;
    return isValidTriggerToken(t) ? "" : match;
  }).replace(/\s{2,}/g, " ").trim();
  parsed.date = null;
  for (const tok of newTriggerStr.trim().split(/\s+/)) {
    if (!tok)
      continue;
    if (/^@\d{4}-\d{2}-\d{2}$/.test(tok)) {
      parsed.date = tok;
      continue;
    }
    const key = tok.replace(/^@/, "");
    if (!new RegExp(`@${key}\\b`, "i").test(parsed.text))
      parsed.text = parsed.text.trimEnd() + " " + tok;
  }
  lines[lineNum - 1] = serializeTaskLine(parsed);
  const n = new Date();
  const skipStr = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
  lines[lineNum - 1] = setSkipDate(lines[lineNum - 1], skipStr);
  await writeFileLines(app, tFile, lines);
}
async function editCardText(app, filePath, lineNum, newText) {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    if (lineNum < 1 || lineNum > lines.length)
      return false;
    const original = lines[lineNum - 1];
    const indent = (original.match(/^(\s*)/) || [""])[0];
    const markerMatch = original.match(
      /^\s*(-\s*\[[ xX]\]\s*|-\s*|[*+]\s*|\d+\.\s*)/
    );
    const marker = markerMatch ? markerMatch[1] : "- ";
    const tags = extractTags(original).join(" ");
    const orderMatch = original.match(/%% @\d+\w %%/);
    const orderComment = orderMatch ? orderMatch[0] : "";
    const parts = [indent + marker + newText.trim()];
    if (tags)
      parts.push(tags);
    if (orderComment)
      parts.push(orderComment);
    lines[lineNum - 1] = parts.join(" ");
    await writeFileLines(app, tFile, lines);
    return true;
  } catch (e) {
    console.error("editCardText failed:", e);
    return false;
  }
}
async function deleteLineRange(app, filePath, startLine, endLine) {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    if (startLine < 1 || startLine > lines.length)
      return false;
    const end = Math.min(endLine, lines.length);
    lines.splice(startLine - 1, end - startLine + 1);
    await writeFileLines(app, tFile, lines);
    return true;
  } catch (e) {
    console.error("deleteLineRange failed:", e);
    return false;
  }
}
async function moveToColumn(app, filePath, lineNum, originalTags, targetTag, isDone, config, dateStrToAppend = null, newDigits = null, newState = null, triggerAnnotation = null, clearDate = false) {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    const sortedOrig = originalTags.slice().sort().join(",");
    let idx = -1;
    const lineCandidate = lines[lineNum - 1];
    if (lineCandidate && extractTags(lineCandidate).slice().sort().join(",") === sortedOrig) {
      idx = lineNum - 1;
    } else {
      idx = lines.findIndex(
        (l) => extractTags(l).slice().sort().join(",") === sortedOrig
      );
    }
    if (idx === -1)
      throw new Error("Line not found by tag fingerprint");
    const parsed = parseTaskLine(lines[idx]);
    parsed.tags = parsed.tags.filter((t) => !config.normKanban.includes(normalizeTag(t)));
    parsed.tags.push(targetTag);
    if (config.normRecurrent && normalizeTag(targetTag) === config.normRecurrent) {
      const annRe = new RegExp(`@${config.normRecurrent}\\b`, "i");
      if (!annRe.test(parsed.text))
        parsed.text += ` @${config.normRecurrent}`;
      if (triggerAnnotation) {
        for (const tok of triggerAnnotation.trim().split(/\s+/)) {
          const tokRe = new RegExp(`@${tok.replace(/^@/, "")}\\b`, "i");
          if (!tokRe.test(parsed.text))
            parsed.text += ` ${tok}`;
        }
      }
    }
    if (parsed.checked !== null)
      parsed.checked = isDone;
    if (clearDate)
      parsed.date = null;
    if (dateStrToAppend)
      parsed.date = dateStrToAppend;
    if (isDone) {
      const n2 = new Date();
      parsed.doneDate = `${n2.getFullYear()}-${String(n2.getMonth() + 1).padStart(2, "0")}-${String(n2.getDate()).padStart(2, "0")}`;
    } else {
      parsed.doneDate = null;
    }
    if (newDigits !== null) {
      parsed.orderDigits = newDigits;
      parsed.orderState = newState ?? ([config.normDone, config.normLater].includes(normalizeTag(targetTag)) ? "collapsed" : "expanded");
    }
    lines[idx] = serializeTaskLine(parsed);
    const n = new Date();
    const skipStr = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
    if (config.normRecurrent && normalizeTag(targetTag) === config.normRecurrent) {
      lines[idx] = setSkipDate(lines[idx], skipStr);
    }
    if (normalizeTag(targetTag) === config.normLater && !parsed.date) {
      lines[idx] = setSkipDate(lines[idx], skipStr);
    }
    await writeFileLines(app, tFile, lines);
    return true;
  } catch (e) {
    console.error("moveToColumn failed:", e);
    return false;
  }
}
async function addNewItem(app, rawInsertTarget, columnTag, userText, dateStr, config, createDoc = false, notesText = "") {
  try {
    if (!userText?.trim())
      return false;
    let cardText = userText.trim();
    const noteLines = formatNoteLines("", notesText);
    if (createDoc) {
      const safeTitle = cardText.replace(/\s*%%[\s\S]*?%%\s*/g, " ").replace(/@\S+/g, "").replace(/[\\/:*?"<>|#\[\]]/g, " ").replace(/\s+/g, " ").trim();
      const docPath = `${safeTitle}.md`;
      let projFile = app.vault.getAbstractFileByPath(docPath);
      if (!projFile) {
        projFile = await app.vault.create(docPath, "");
        showInfoDialog(`Created new note "${safeTitle}.md".`);
      }
      let newLine2 = `- [ ] ${cardText} ${columnTag}`;
      if (dateStr)
        newLine2 += ` ${dateStr}`;
      {
        const n = new Date();
        const skipStr = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
        if (config.normRecurrent && normalizeTag(columnTag) === config.normRecurrent && !hasValidTriggers(newLine2, config.normRecurrent) && !extractSkipDate(newLine2)) {
          newLine2 = setSkipDate(newLine2, skipStr);
        }
        if (normalizeTag(columnTag) === config.normLater && !dateStr) {
          newLine2 = setSkipDate(newLine2, skipStr);
        }
      }
      const projLines = (await app.vault.read(projFile)).split("\n");
      projLines.splice(afterFrontMatter(projLines), 0, newLine2, ...noteLines);
      await app.vault.modify(projFile, projLines.join("\n"));
      const masterDocName = config.projectsDocument.trim();
      if (masterDocName) {
        const masterPath = masterDocName.endsWith(".md") ? masterDocName : `${masterDocName}.md`;
        let masterFile = app.vault.getAbstractFileByPath(masterPath);
        if (!masterFile) {
          masterFile = await app.vault.create(masterPath, `# ${masterDocName}
`);
        }
        const masterLines = (await app.vault.read(masterFile)).split("\n");
        masterLines.splice(afterFrontMatter(masterLines), 0, `[[${safeTitle}]]`);
        await app.vault.modify(masterFile, masterLines.join("\n"));
      }
      new import_obsidian.Notice(`Added "${userText}" to ${safeTitle}.`);
      return true;
    }
    const baseName = rawInsertTarget.trim().split("#")[0].replace(/\.md$/, "").trim();
    const dirPath = baseName;
    const indexPath = `${dirPath}/${baseName}.md`;
    if (!(app.vault.getAbstractFileByPath(dirPath) instanceof import_obsidian.TFolder)) {
      await app.vault.createFolder(dirPath);
    }
    const normColumn = normalizeTag(columnTag);
    const isLater = normColumn === config.normLater;
    const isRecurrent = !!config.normRecurrent && normColumn === config.normRecurrent;
    let targetFileName;
    if (isLater)
      targetFileName = "Later";
    else if (isRecurrent)
      targetFileName = "Recurrent";
    else {
      const now = new Date();
      const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      targetFileName = `${baseName}-${monthStr}`;
    }
    const targetPath = `${dirPath}/${targetFileName}.md`;
    let targetFile = app.vault.getAbstractFileByPath(targetPath);
    if (!targetFile) {
      targetFile = await app.vault.create(targetPath, `# ${targetFileName}
`);
    }
    const linkLine = `[[${targetFileName}]]`;
    let indexFile = app.vault.getAbstractFileByPath(indexPath);
    if (!indexFile) {
      await app.vault.create(indexPath, linkLine + "\n");
    } else {
      const idxLines = (await app.vault.read(indexFile)).split("\n");
      if (!idxLines.some((l) => l.trim() === linkLine)) {
        idxLines.splice(afterFrontMatter(idxLines), 0, linkLine);
        await app.vault.modify(indexFile, idxLines.join("\n"));
      }
    }
    let newLine = `- [ ] ${cardText} ${columnTag}`;
    if (dateStr)
      newLine += ` ${dateStr}`;
    {
      const n = new Date();
      const skipStr = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
      if (isRecurrent && !hasValidTriggers(newLine, config.normRecurrent) && !extractSkipDate(newLine)) {
        newLine = setSkipDate(newLine, skipStr);
      }
      if (isLater && !dateStr) {
        newLine = setSkipDate(newLine, skipStr);
      }
    }
    const targetLines = (await app.vault.read(targetFile)).split("\n");
    let insertAt = afterFrontMatter(targetLines);
    if (targetLines[insertAt]?.match(/^#\s/))
      insertAt++;
    targetLines.splice(insertAt, 0, newLine, ...noteLines);
    await app.vault.modify(targetFile, targetLines.join("\n"));
    new import_obsidian.Notice(`Added "${userText}" to ${columnTag.replace(/^#/, "").toUpperCase()}.`);
    return true;
  } catch (e) {
    console.error("addNewItem failed:", e);
    new import_obsidian.Notice(`Failed to add item: ${e.message}`);
    return false;
  }
}
async function addDueColumnExplanationCard(app, config) {
  if (!config.dueColumn)
    return false;
  const text = "This column only shows up while it has cards in it \u2014 it disappears automatically when it's empty, and reappears once the board moves a due-later or recurrent card into it.";
  return addNewItem(app, config.newTaskInsert, config.dueColumn, text, null, config, false, "");
}
async function moveCardToNewDoc(app, filePath, lineNum, plainTitle, targetTag, config) {
  const safeTitle = plainTitle.replace(/[\\/:*?"<>|#\[\]]/g, " ").replace(/\s+/g, " ").trim();
  const docPath = `${safeTitle}.md`;
  const { tFile, lines } = await readFileLines(app, filePath);
  const parsed = parseTaskLine(lines[lineNum - 1]);
  parsed.tags = parsed.tags.filter((t) => !config.normKanban.includes(normalizeTag(t)));
  parsed.tags.push(targetTag);
  parsed.orderDigits = null;
  parsed.orderState = null;
  const newTaskLine = serializeTaskLine(parsed);
  let projFile = app.vault.getAbstractFileByPath(docPath);
  const isNew = !projFile;
  if (!projFile)
    projFile = await app.vault.create(docPath, "");
  const projLines = (await app.vault.read(projFile)).split("\n");
  projLines.splice(afterFrontMatter(projLines), 0, newTaskLine);
  await app.vault.modify(projFile, projLines.join("\n"));
  const nd = new Date();
  const movedDate = `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, "0")}-${String(nd.getDate()).padStart(2, "0")}`;
  lines.splice(lineNum - 1, 1, `[[${safeTitle}]] (moved: ${movedDate})`);
  await writeFileLines(app, tFile, lines);
  const masterDocName = config.projectsDocument.trim();
  if (masterDocName) {
    const masterPath = masterDocName.endsWith(".md") ? masterDocName : `${masterDocName}.md`;
    let masterFile = app.vault.getAbstractFileByPath(masterPath);
    if (!masterFile) {
      masterFile = await app.vault.create(masterPath, `# ${masterDocName}
`);
    }
    const masterLines = (await app.vault.read(masterFile)).split("\n");
    masterLines.splice(afterFrontMatter(masterLines), 0, `[[${safeTitle}]]`);
    await app.vault.modify(masterFile, masterLines.join("\n"));
  }
  new import_obsidian.Notice(isNew ? `Created "${safeTitle}.md" and moved task.` : `Moved task to existing "${safeTitle}.md".`);
}
var ARCHIVE_CALLOUT_HEADER = "> [!note]- Archived";
async function archiveToSection(app, filePath, mainLineNum, subLines, config, _isTopLevel = true) {
  try {
    let archiveLine = function(idx, tickBox) {
      if (idx < 0 || idx >= lines.length)
        return;
      const parsed = parseTaskLine(lines[idx]);
      parsed.tags = parsed.tags.filter((t) => !config.normKanban.includes(normalizeTag(t)));
      parsed.orderDigits = null;
      parsed.orderState = null;
      if (config.normRecurrent && hasRecurrentAnnotation(lines[idx], config.normRecurrent)) {
        hasRecurrentInBlock = true;
        const repeatSpec = extractRepeatSpec(lines[idx]);
        const completedOn = parsed.doneDate ? new Date(parsed.doneDate + "T00:00:00") : new Date();
        if (parsed.checked !== null)
          parsed.checked = false;
        parsed.doneDate = null;
        parsed.tags.push(config.recurrentColumn);
        parsed.date = repeatSpec ? formatDateAnnotation(addRepeatInterval(completedOn, repeatSpec)) : null;
        lines[idx] = serializeTaskLine(parsed);
        const n = new Date();
        const skipStr = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
        lines[idx] = setSkipDate(lines[idx], skipStr);
      } else {
        if (tickBox && parsed.checked !== null)
          parsed.checked = true;
        lines[idx] = serializeTaskLine(parsed);
      }
    };
    const { tFile, lines } = await readFileLines(app, filePath);
    let hasRecurrentInBlock = false;
    const mainIdx = mainLineNum - 1;
    const endIdx = (maxSubLine(subLines) || mainLineNum) - 1;
    archiveLine(mainIdx, true);
    const recurse = (subs) => {
      for (const sub of subs) {
        archiveLine(sub.line - 1, false);
        if (sub.subs?.length)
          recurse(sub.subs);
      }
    };
    recurse(subLines);
    if (_isTopLevel && !hasRecurrentInBlock) {
      const blockLines = lines.slice(mainIdx, endIdx + 1).map((l) => `> ${l}`);
      lines.splice(mainIdx, endIdx - mainIdx + 1);
      const calloutIdx = lines.findIndex((l) => l.trim() === ARCHIVE_CALLOUT_HEADER);
      if (calloutIdx >= 0) {
        lines.splice(calloutIdx + 1, 0, ...blockLines);
      } else {
        while (lines.length && lines[lines.length - 1].trim() === "")
          lines.pop();
        lines.push("", ARCHIVE_CALLOUT_HEADER, ...blockLines);
      }
    }
    await writeFileLines(app, tFile, lines);
    return true;
  } catch (e) {
    console.error("archiveToSection failed:", e);
    return false;
  }
}
async function promoteSubToChild(app, filePath, subLineNum, parentTag, parentDigits, config, refresh) {
  try {
    const normParent = normalizeTag(parentTag);
    const targetPaths = await getTargetFilePaths(app, config);
    const allItems = await collectItems(app, targetPaths, config);
    const columns = groupByColumns(allItems, config);
    const parentCard = (columns[normParent]?.cards || []).find((c) => c.digits != null && c.digits === parentDigits);
    const prevSibling = parentCard ? { digits: parentCard.digits || "0", len: parentCard.len || 1 } : { digits: parentDigits || "0", len: (parentDigits || "0").length };
    const higher = (columns[normParent]?.cards || []).filter((c) => c.digits != null && compareDigits(c.digits, parentDigits) > 0).sort((a, b) => compareDigits(a.digits, b.digits));
    let newCalc;
    if (higher.length) {
      newCalc = calcMidDigits(prevSibling, higher[0], false);
    } else {
      newCalc = { digits: prevSibling.digits + "9", len: prevSibling.len + 1 };
    }
    const newState = [config.normDone, config.normLater].includes(normParent) ? "collapsed" : "expanded";
    const { tFile, lines } = await readFileLines(app, filePath);
    if (subLineNum < 1 || subLineNum > lines.length)
      return false;
    const parsed = parseTaskLine(lines[subLineNum - 1]);
    if (!parsed.tags.some((t) => normalizeTag(t) === normParent)) {
      parsed.tags.push(parentTag);
    }
    if (parentCard && !parsed.date) {
      const dm = parentCard.item.text.match(/@\d{4}-\d{2}-\d{2}/);
      if (dm)
        parsed.date = dm[0];
    }
    parsed.orderDigits = newCalc.digits;
    parsed.orderState = newState;
    lines[subLineNum - 1] = serializeTaskLine(parsed);
    await writeFileLines(app, tFile, lines);
    new import_obsidian.Notice(`Tagged subtask with ${parentTag.replace(/^#/, "").toUpperCase()}.`);
    requestAnimationFrame(() => setTimeout(refresh, 50));
    return true;
  } catch (e) {
    console.error("promoteSubToChild failed:", e);
    return false;
  }
}
async function getTargetFilePaths(app, config) {
  if (config.allVaultNotes) {
    return app.vault.getMarkdownFiles().map((f) => f.path);
  }
  async function getDescendants(start, visited = /* @__PURE__ */ new Set()) {
    if (visited.has(start))
      return [];
    visited.add(start);
    const cache = app.metadataCache.getCache(start);
    const links = cache?.links || [];
    const children = await Promise.all(
      links.map(async (l) => {
        const resolved = app.metadataCache.getFirstLinkpathDest(l.link, start);
        return resolved ? getDescendants(resolved.path, visited) : [];
      })
    );
    return [start, ...children.flat()];
  }
  const allFiles = app.vault.getMarkdownFiles();
  const allPaths = [];
  for (const name of config.parentPages) {
    const file = allFiles.find(
      (f) => f.basename === name || f.path.endsWith(`${name}.md`)
    );
    if (file)
      allPaths.push(...await getDescendants(file.path));
  }
  return [...new Set(allPaths)];
}
async function collectItems(app, targetFilePaths, config) {
  const allItems = [];
  let discoveryIdx = 0;
  const LIST_RE = /^(\s*)(?:[-*+]|\d+[\.\)]|-\s*\[\s*\])\s+/;
  const CODE_RE = /^[\s]*```/;
  const EMBED_RE = /^[\s]*!\[\[/;
  const LINK_RE = /^[\s]*\[\[/;
  for (const filePath of targetFilePaths) {
    const tFile = app.vault.getAbstractFileByPath(filePath);
    if (!tFile)
      continue;
    let raw;
    try {
      raw = await app.vault.read(tFile);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "string")
      continue;
    let lines = raw.split("\n");
    let start = 0;
    if (lines[0]?.trim() === "---") {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === "---") {
          start = i + 1;
          break;
        }
      }
    }
    lines = lines.slice(start);
    let inCode = false;
    const stack = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (typeof line !== "string")
        continue;
      const trim = line.trim();
      if (!trim || trim.toLowerCase().includes("#exclude"))
        continue;
      if (CODE_RE.test(line)) {
        inCode = !inCode;
        continue;
      }
      if (inCode || EMBED_RE.test(line) || LINK_RE.test(line))
        continue;
      const indent = (line.match(/^(\s*)/) || [""])[0].length;
      const hMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
      if (hMatch) {
        const tags = extractTags(hMatch[2]);
        if (tags.some((t) => matchesKanbanTag(t, config.normKanban))) {
          const parsed2 = parseOrderComment(hMatch[2]);
          while (stack.length && stack[stack.length - 1].indent >= indent) {
            const p = stack.pop();
            if (p.item.tags.some(
              (t) => matchesKanbanTag(t, config.normKanban)
            ))
              allItems.push({ ...p, discoveryIndex: discoveryIdx++ });
          }
          stack.push({
            item: { text: hMatch[2].trim(), tags, line: i + 1 + start, subs: [] },
            source: { path: filePath },
            filePath,
            state: parsed2?.state ?? "collapsed",
            digits: parsed2?.digits ?? null,
            len: parsed2?.len ?? null,
            isPromoted: indent > 0,
            indent,
            hierarchy_level: stack.length
          });
        }
        continue;
      }
      if (!LIST_RE.test(line))
        continue;
      const ownTags = extractTags(line);
      const parsed = parseOrderComment(trim);
      while (stack.length && stack[stack.length - 1].indent >= indent) {
        const p = stack.pop();
        if (p.item.tags.some(
          (t) => matchesKanbanTag(t, config.normKanban)
        ))
          allItems.push({ ...p, discoveryIndex: discoveryIdx++ });
      }
      const entry = {
        item: { text: trim, tags: ownTags, line: i + 1 + start, subs: [] },
        source: { path: filePath },
        filePath,
        state: parsed?.state ?? "collapsed",
        digits: parsed?.digits ?? null,
        len: parsed?.len ?? null,
        isPromoted: stack.length > 0 && ownTags.some(
          (t) => matchesKanbanTag(t, config.normKanban)
        ),
        indent,
        hierarchy_level: stack.length
      };
      if (stack.length && stack[stack.length - 1].indent < indent) {
        stack[stack.length - 1].item.subs.push(entry.item);
      }
      stack.push(entry);
    }
    while (stack.length) {
      const e = stack.pop();
      if (e.item.tags.some((t) => matchesKanbanTag(t, config.normKanban)))
        allItems.push({ ...e, discoveryIndex: discoveryIdx++ });
    }
  }
  function setLevels(node, level = 0) {
    node.hierarchy_level = level;
    node.subs?.forEach((s) => setLevels(s, level + 1));
  }
  return allItems.filter(
    (e) => e.item.tags.some((t) => matchesKanbanTag(t, config.normKanban))
  ).map((e) => {
    setLevels(e.item);
    return {
      ...e,
      multiTag: e.item.tags.map(normalizeTag).filter((t) => config.normKanban.includes(t)).length > 1
    };
  });
}
function groupByColumns(items, config) {
  const columns = Object.fromEntries(
    config.kanban.map((tag) => [
      normalizeTag(tag),
      { rawTag: tag, cards: [] }
    ])
  );
  for (const item of items) {
    const norms = item.item.tags.map(normalizeTag).filter((t) => config.normKanban.includes(t));
    for (const norm of norms) {
      columns[norm].cards.push({ ...item });
    }
  }
  Object.values(columns).forEach((col) => col.cards.sort(compareCardsByDigits));
  return columns;
}
async function assignInitialOrders(app, columns, _config) {
  const multiKeys = /* @__PURE__ */ new Set();
  for (const col of Object.values(columns)) {
    for (const card of col.cards) {
      if (card.multiTag)
        multiKeys.add(`${card.filePath}:${card.item.line}`);
    }
  }
  for (const key of multiKeys) {
    const [fp, ln] = key.split(":");
    const lineNum = parseInt(ln, 10);
    const { lines } = await readFileLines(app, fp);
    const existing = parseOrderComment(lines[lineNum - 1] || "");
    if (!existing || existing.digits !== "0") {
      await updateFileOrderComment(app, fp, lineNum, "0");
      console.warn("Multi-tag card set to 0.0; adjust manually if needed.");
    }
    for (const col of Object.values(columns)) {
      col.cards = col.cards.map(
        (c) => `${c.filePath}:${c.item.line}` === key ? { ...c, digits: "0" } : c
      );
    }
  }
  for (const col of Object.values(columns)) {
    const ordered = col.cards.filter(
      (c) => c.digits != null && !c.multiTag
    );
    const unordered = col.cards.filter((c) => c.digits == null && !c.multiTag).sort((a, b) => a.discoveryIndex - b.discoveryIndex);
    if (!unordered.length)
      continue;
    const highDigits = ordered.length ? ordered[0].digits || "9" : "9";
    const baseLen = ordered.length ? ordered[0].len || highDigits.length : 1;
    const len = baseLen + String(unordered.length + 1).length;
    const highBig = BigInt(highDigits.padEnd(len, "0"));
    const stepBig = highBig / BigInt(unordered.length + 1);
    for (let i = 0; i < unordered.length; i++) {
      const digits = (stepBig * BigInt(i + 1)).toString().padStart(len, "0");
      await updateFileOrderComment(
        app,
        unordered[i].filePath,
        unordered[i].item.line,
        digits,
        "collapsed"
      );
      Object.assign(unordered[i], { digits, len, state: "collapsed" });
    }
    col.cards.sort(compareCardsByDigits);
  }
}
var _dialogDoc = document;
function makeOverlay(id) {
  const doc = _dialogDoc;
  doc.getElementById(id)?.remove();
  const overlay = doc.createElement("div");
  overlay.id = id;
  overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;";
  doc.body.appendChild(overlay);
  const dialog = doc.createElement("div");
  dialog.style.cssText = "background:var(--background-primary);color:var(--kb-dialog-text,var(--text-normal));padding:20px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:300px;max-width:400px;max-height:90vh;overflow-y:auto;text-align:center;";
  overlay.appendChild(dialog);
  const close = () => overlay.remove();
  return { overlay, dialog, close };
}
function inputStyle() {
  return "width:100%;padding:8px;margin-bottom:10px;border:1px solid var(--background-modifier-border);border-radius:4px;box-sizing:border-box;background:var(--background-secondary);color:var(--text-normal);";
}
function dateInputStyle() {
  return "width:auto;max-width:160px;padding:8px;margin:0 auto 10px;display:block;border:1px solid var(--background-modifier-border);border-radius:4px;box-sizing:border-box;background:var(--background-secondary);color:var(--text-normal);";
}
function textareaStyle() {
  return inputStyle() + "min-height:70px;resize:vertical;font-family:inherit;white-space:pre;";
}
var CHECKLIST_MARK = "\u2610";
function formatNoteLines(cardIndent, notesText) {
  if (!notesText || !notesText.trim())
    return [];
  const expanded = notesText.split(CHECKLIST_MARK).join("- [ ] ");
  const rawLines = expanded.replace(/\r\n/g, "\n").split("\n");
  while (rawLines.length && rawLines[0].trim() === "")
    rawLines.shift();
  while (rawLines.length && rawLines[rawLines.length - 1].trim() === "")
    rawLines.pop();
  if (!rawLines.length)
    return [];
  let minIndent = Infinity;
  for (const line of rawLines) {
    if (line.trim() === "")
      continue;
    minIndent = Math.min(minIndent, (line.match(/^(\s*)/) || [""])[0].length);
  }
  if (!isFinite(minIndent))
    minIndent = 0;
  const stack = [];
  return rawLines.map((line) => {
    if (line.trim() === "")
      return "";
    const stripped = line.slice(minIndent);
    const rawIndentLen = (stripped.match(/^(\s*)/) || [""])[0].length;
    const content = stripped.slice(rawIndentLen);
    while (stack.length && stack[stack.length - 1] >= rawIndentLen)
      stack.pop();
    stack.push(rawIndentLen);
    const level = stack.length;
    const bulleted = /^-\s/.test(content) ? content : `- ${content}`;
    return `${cardIndent}${"	".repeat(level)}${bulleted}`;
  });
}
function appendToFirstLine(text, suffix) {
  const idx = text.indexOf("\n");
  if (idx === -1)
    return `${text} ${suffix}`;
  return `${text.slice(0, idx)} ${suffix}${text.slice(idx)}`;
}
function checklistButtonHtml(id, title) {
  const style = "padding:3px 10px;border-radius:12px;border:1px solid var(--background-modifier-border);background:none;cursor:pointer;font-size:1em;line-height:1;display:inline-flex;align-items:center;gap:6px;color:inherit;margin-bottom:10px;";
  return `<button type="button" id="${id}" title="${title}" style="${style}">Insert &#9744;</button>`;
}
function insertChecklistPrefix(textarea) {
  const value = textarea.value;
  const pos = textarea.selectionStart ?? value.length;
  const lineStart = value.lastIndexOf("\n", pos - 1) + 1;
  const lineEnd = (() => {
    const i = value.indexOf("\n", lineStart);
    return i === -1 ? value.length : i;
  })();
  const leadingWs = (value.slice(lineStart, lineEnd).match(/^[ \t]*/) || [""])[0];
  const insertPos = lineStart + leadingWs.length;
  const prefix = CHECKLIST_MARK;
  textarea.value = value.slice(0, insertPos) + prefix + value.slice(insertPos);
  const newPos = Math.max(pos, insertPos) + prefix.length;
  textarea.focus();
  textarea.setSelectionRange(newPos, newPos);
}
function buttonHtml(label, accent) {
  const bg = accent ? "var(--interactive-accent)" : "var(--background-modifier-border)";
  const color = accent ? "var(--text-on-accent)" : "var(--text-normal)";
  return `<button style="padding:8px 16px;background:${bg};color:${color};border:none;border-radius:4px;cursor:pointer;">${label}</button>`;
}
function afterFrontMatter(lines) {
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === "---")
        return i + 1;
    }
  }
  return 0;
}
function showConfirmDialog(message) {
  return new Promise((resolve) => {
    const { dialog, close } = makeOverlay("kanban-confirm-dialog");
    dialog.innerHTML = `
      <p style="margin:0 0 16px;font-size:.95em;">${message}</p>
      <div style="display:flex;gap:10px;justify-content:center;">${buttonHtml("Yes", true)}${buttonHtml("No", false)}</div>`;
    const [yesBtn, noBtn] = dialog.querySelectorAll("button");
    yesBtn.onclick = () => {
      close();
      resolve(true);
    };
    noBtn.onclick = () => {
      close();
      resolve(false);
    };
  });
}
function showInfoDialog(message) {
  const { dialog, close } = makeOverlay("kanban-info-dialog");
  dialog.innerHTML = `
    <p style="margin:0 0 16px;font-size:.95em;">${message}</p>
    <div style="text-align:center;">${buttonHtml("OK", false)}</div>`;
  const [okBtn] = dialog.querySelectorAll("button");
  okBtn.onclick = close;
}
function showInputDialog(title, defaultCreateDoc, onSubmit) {
  const { dialog, close } = makeOverlay("kanban-input-dialog");
  const chk = defaultCreateDoc ? "checked" : "";
  dialog.innerHTML = `<h3 style="margin:0 0 10px;font-size:1.1em;">${title}</h3>
    <input id="k-text" type="text" placeholder="Enter new item text..." style="${inputStyle()}" autofocus>
    <textarea id="k-notes" placeholder="Additional notes (optional)..." style="${textareaStyle()}"></textarea>
    <div style="text-align:left;">${checklistButtonHtml("k-notes-checklist", "Insert checklist item")}</div>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;font-size:.9em;">
      <input id="k-doc" type="checkbox" ${chk}> Create new document
    </label>
    <div id="k-actions" style="display:flex;gap:10px;justify-content:center;">${buttonHtml("Add", true)}${buttonHtml("Cancel", false)}</div>`;
  const [addBtn, cancelBtn] = dialog.querySelectorAll("#k-actions button");
  const input = dialog.querySelector("#k-text");
  const notesInput = dialog.querySelector("#k-notes");
  const checklistBtn = dialog.querySelector("#k-notes-checklist");
  const docCheck = dialog.querySelector("#k-doc");
  const submit = () => {
    const v = input.value.trim();
    const createDoc = docCheck.checked;
    const notes = notesInput.value;
    close();
    if (v)
      onSubmit(v, createDoc, notes);
  };
  addBtn.onclick = submit;
  cancelBtn.onclick = close;
  checklistBtn.onclick = () => insertChecklistPrefix(notesInput);
  input.onkeydown = (e) => {
    if (e.key === "Enter")
      submit();
    if (e.key === "Escape")
      close();
  };
  notesInput.onkeydown = (e) => {
    if (e.key === "Escape")
      close();
  };
  input.focus();
}
function showDateDialog(title, defaultDate, onSubmit, opts = {}) {
  const { withText, defaultCreateDoc } = opts;
  const { dialog, close } = makeOverlay(withText ? "kanban-later-add-dialog" : "kanban-date-dialog");
  const chk = defaultCreateDoc ? "checked" : "";
  const presetBtnStyle = (active) => `padding:4px 10px;border:none;border-radius:12px;cursor:pointer;font-size:.75em;` + (active ? `background:var(--interactive-accent);color:var(--text-on-accent);` : `background:var(--background-modifier-border);color:var(--text-normal);`);
  let selectedPreset = DATE_PRESETS.find(([, , fn]) => fn().toISOString().split("T")[0] === defaultDate)?.[0] ?? null;
  const presetBtnsHtml = DATE_PRESETS.map(
    ([key, label]) => `<button type="button" class="kb-date-preset" data-preset="${key}" style="${presetBtnStyle(key === selectedPreset)}">${label}</button>`
  ).join("");
  dialog.innerHTML = `<h3 style="margin:0 0 10px;font-size:1.1em;">${title}</h3>
    ${withText ? `<input id="k-text" type="text" placeholder="Enter new item text..." style="${inputStyle()}" autofocus>` : ""}
    ${withText ? `<textarea id="k-notes" placeholder="Additional notes (optional)..." style="${textareaStyle()}"></textarea>` : ""}
    ${withText ? `<div style="text-align:left;">${checklistButtonHtml("k-notes-checklist", "Insert checklist item")}</div>` : ""}
    <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-bottom:8px;">${presetBtnsHtml}</div>
    <input id="k-date" type="date" value="${defaultDate}" style="${dateInputStyle()}" ${withText ? "" : "autofocus"}>
    ${withText ? `<label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;font-size:.9em;">
      <input id="k-doc" type="checkbox" ${chk}> Create new document
    </label>` : ""}
    <div id="k-date-actions" style="display:flex;gap:10px;justify-content:center;">${buttonHtml(withText ? "Add" : "Set", true)}${buttonHtml("No date", false)}${buttonHtml("Cancel", false)}</div>`;
  const [actionBtn, noDateBtn, cancelBtn] = dialog.querySelectorAll("#k-date-actions button");
  const textInput = withText ? dialog.querySelector("#k-text") : null;
  const notesInput = withText ? dialog.querySelector("#k-notes") : null;
  const checklistBtn = withText ? dialog.querySelector("#k-notes-checklist") : null;
  const dateInput = dialog.querySelector("#k-date");
  const docCheck = withText ? dialog.querySelector("#k-doc") : null;
  if (checklistBtn && notesInput) {
    checklistBtn.onclick = () => insertChecklistPrefix(notesInput);
  }
  const presetBtns = dialog.querySelectorAll(".kb-date-preset");
  presetBtns.forEach((btn) => {
    const preset = DATE_PRESETS.find(([key]) => key === btn.dataset.preset);
    btn.onclick = () => {
      dateInput.value = preset[2]().toISOString().split("T")[0];
      selectedPreset = preset[0];
      presetBtns.forEach((b) => {
        b.style.cssText = presetBtnStyle(b.dataset.preset === selectedPreset);
      });
    };
  });
  const submit = (useDate) => {
    const t = textInput?.value.trim() ?? "";
    if (withText && !t)
      return;
    const d = useDate ? dateInput.value : "";
    const notes = notesInput?.value ?? "";
    close();
    onSubmit(d ? "@" + d : null, withText ? t : void 0, docCheck?.checked, withText ? notes : void 0);
  };
  actionBtn.onclick = () => submit(true);
  noDateBtn.onclick = () => submit(false);
  cancelBtn.onclick = close;
  [textInput, dateInput].forEach((el) => {
    el?.addEventListener("keydown", (e) => {
      if (e.key === "Enter")
        submit(true);
      if (e.key === "Escape")
        close();
    });
  });
  notesInput?.addEventListener("keydown", (e) => {
    if (e.key === "Escape")
      close();
  });
  (textInput ?? dateInput).focus();
}
function showRecurrentTriggerDialog(onSubmit, existingTriggers = [], existingRepeatSpec = null) {
  const { dialog, close } = makeOverlay("kanban-recurrent-trigger-dialog");
  const WD_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const WD_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MO_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const MO_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const activeWD = new Set(existingTriggers.filter((t) => WD_KEYS.includes(t)));
  const selectedDays = existingTriggers.filter((t) => /^\d{1,2}$/.test(t));
  const selectedMonths = existingTriggers.filter((t) => MO_KEYS.includes(t));
  const activeQuarterly = new Set(
    existingTriggers.filter((t) => t === "quarterly+2" || t === "quarterly+3" || t === "q+2" || t === "q+3").map((t) => t === "q+2" ? "quarterly+2" : t === "q+3" ? "quarterly+3" : t)
  );
  let quarterlyActive = existingTriggers.includes("quarterly") || existingTriggers.includes("q+1");
  const YEAR_SENTINEL = "year1";
  let repeatEnabled = existingRepeatSpec !== null;
  let initRepeatUnit = existingRepeatSpec?.unit === "year" ? "month" : existingRepeatSpec?.unit ?? "week";
  let initRepeatCountVal = existingRepeatSpec?.unit === "year" || existingRepeatSpec?.unit === "month" && existingRepeatSpec.count === 12 ? YEAR_SENTINEL : String(existingRepeatSpec?.count ?? 1);
  const wdStyle = (active) => `height:24px;padding:0 8px;border-radius:12px;border:1px solid var(--background-modifier-border);cursor:pointer;font-size:.75em;display:inline-flex;align-items:center;justify-content:center;` + (active ? `background:var(--interactive-accent);color:var(--text-on-accent);` : `background:none;color:inherit;`);
  const selectedChipStyle = wdStyle(true);
  const wdBtns = WD_KEYS.map(
    (d, i) => `<button type="button" class="kb-wd-btn" data-day="${d}" style="${wdStyle(activeWD.has(d))}">${WD_LABELS[i]}</button>`
  ).join("");
  const dayOpts = `<option value="">Add day\u2026</option>` + Array.from({ length: 30 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("") + `<option value="last_day" disabled>Last day</option>`;
  const moOpts = `<option value="">Add month\u2026</option>` + MO_KEYS.map((m, i) => `<option value="${m}">${MO_LABELS[i]}</option>`).join("");
  const selStyle = `padding:4px 8px;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-secondary);color:inherit;font-size:.8em;`;
  const lblStyle = `font-size:.8em;color:inherit;opacity:.75;`;
  dialog.innerHTML = `
    <h3 style="margin:0 0 12px;font-size:1.1em;">Set recurrence trigger</h3>
    <div style="margin-bottom:12px;">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:.9em;margin-bottom:6px;">
        <input id="k-repeat-enable" type="checkbox" ${repeatEnabled ? "checked" : ""}> Repeat after
      </label>
      <div id="k-repeat-controls" style="display:${repeatEnabled ? "flex" : "none"};gap:6px;align-items:center;">
        <select id="k-repeat-count" style="${selStyle}"></select>
        <select id="k-repeat-unit" style="${selStyle}">
          <option value="day">Days</option>
          <option value="week">Weeks</option>
          <option value="month">Months</option>
        </select>
      </div>
    </div>
    <div style="margin-bottom:12px;">
      <span style="${lblStyle}display:block;margin-bottom:4px;">Weekday</span>
      <div id="k-wd-wrap" style="display:flex;gap:4px;flex-wrap:wrap;">${wdBtns}</div>
    </div>
    <div style="margin-bottom:12px;">
      <span style="${lblStyle}display:block;margin-bottom:4px;">Quarterly</span>
      <div style="display:flex;gap:4px;flex-wrap:wrap;">
        <button type="button" id="k-quarterly-btn" style="${wdStyle(quarterlyActive)}">quarterly</button>
        <button type="button" class="kb-q-btn" data-q="quarterly+2" style="${wdStyle(activeQuarterly.has("quarterly+2"))}">quarterly+2</button>
        <button type="button" class="kb-q-btn" data-q="quarterly+3" style="${wdStyle(activeQuarterly.has("quarterly+3"))}">quarterly+3</button>
      </div>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:6px;">
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="${lblStyle}white-space:nowrap;">Day of month</span>
        <select id="k-dom" style="${selStyle}">${dayOpts}</select>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="${lblStyle}white-space:nowrap;">Month</span>
        <select id="k-month" style="${selStyle}">${moOpts}</select>
      </div>
    </div>
    <div id="k-dom-rows" style="display:flex;flex-wrap:wrap;gap:4px;min-height:4px;margin-bottom:10px;"></div>
    <div id="k-month-rows" style="display:flex;flex-wrap:wrap;gap:4px;min-height:4px;margin-bottom:10px;"></div>
    <p id="k-trigger-err" style="margin:2px 0 8px;font-size:.82em;color:#e03e3e;min-height:1.2em;"></p>
    <div id="k-recur-actions" style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">${buttonHtml("Set", true)}${buttonHtml("No trigger", false)}${buttonHtml("Cancel", false)}</div>`;
  const repeatEnableChk = dialog.querySelector("#k-repeat-enable");
  const repeatControls = dialog.querySelector("#k-repeat-controls");
  const repeatCountSel = dialog.querySelector("#k-repeat-count");
  const repeatUnitSel = dialog.querySelector("#k-repeat-unit");
  const wdWrap = dialog.querySelector("#k-wd-wrap");
  const qWrap = dialog.querySelector(".kb-q-btn").parentElement;
  const domSel = dialog.querySelector("#k-dom");
  const moSel = dialog.querySelector("#k-month");
  const domRows = dialog.querySelector("#k-dom-rows");
  const moRows = dialog.querySelector("#k-month-rows");
  const errEl = dialog.querySelector("#k-trigger-err");
  const [setBtn, noTriggerBtn, cancelBtn] = dialog.querySelectorAll("#k-recur-actions button");
  const renderDomRows = () => {
    domRows.innerHTML = selectedDays.map(
      (d, i) => `<button type="button" class="kb-rm-day" data-idx="${i}" style="${selectedChipStyle}">${d}</button>`
    ).join("");
  };
  const renderMoRows = () => {
    moRows.innerHTML = selectedMonths.map(
      (m, i) => `<button type="button" class="kb-rm-month" data-idx="${i}" style="${selectedChipStyle}">${MO_LABELS[MO_KEYS.indexOf(m)]}</button>`
    ).join("");
  };
  renderDomRows();
  renderMoRows();
  const populateRepeatCountOptions = (unit, selectValue) => {
    let opts;
    if (unit === "day") {
      opts = Array.from({ length: 30 }, (_, i) => [String(i + 1), `${i + 1} day${i > 0 ? "s" : ""}`]);
    } else if (unit === "week") {
      opts = Array.from({ length: 8 }, (_, i) => [String(i + 1), `${i + 1} week${i > 0 ? "s" : ""}`]);
    } else {
      opts = Array.from({ length: 11 }, (_, i) => [String(i + 1), `${i + 1} month${i > 0 ? "s" : ""}`]);
      opts.push([YEAR_SENTINEL, "1 year"]);
    }
    repeatCountSel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    if (selectValue && opts.some(([v]) => v === selectValue))
      repeatCountSel.value = selectValue;
  };
  repeatUnitSel.value = initRepeatUnit;
  populateRepeatCountOptions(initRepeatUnit, initRepeatCountVal);
  const readRepeatSpec = () => {
    const val = repeatCountSel.value;
    if (val === YEAR_SENTINEL)
      return { count: 1, unit: "year" };
    return { count: parseInt(val, 10), unit: repeatUnitSel.value };
  };
  const clearCalendarTriggers = () => {
    activeWD.clear();
    wdWrap.querySelectorAll(".kb-wd-btn").forEach((b) => b.style.cssText = wdStyle(false));
    quarterlyActive = false;
    quarterlyBtn.style.cssText = wdStyle(false);
    activeQuarterly.clear();
    qWrap.querySelectorAll(".kb-q-btn").forEach((b) => b.style.cssText = wdStyle(false));
    selectedDays.length = 0;
    renderDomRows();
    selectedMonths.length = 0;
    renderMoRows();
  };
  const clearRepeatSelection = () => {
    if (!repeatEnableChk.checked)
      return;
    repeatEnableChk.checked = false;
    repeatControls.style.display = "none";
  };
  repeatEnableChk.addEventListener("change", () => {
    if (repeatEnableChk.checked) {
      clearCalendarTriggers();
      repeatControls.style.display = "flex";
    } else {
      repeatControls.style.display = "none";
    }
  });
  repeatUnitSel.addEventListener("change", () => populateRepeatCountOptions(repeatUnitSel.value));
  const quarterlyBtn = dialog.querySelector("#k-quarterly-btn");
  quarterlyBtn.addEventListener("click", () => {
    clearRepeatSelection();
    quarterlyActive = !quarterlyActive;
    quarterlyBtn.style.cssText = wdStyle(quarterlyActive);
  });
  qWrap.addEventListener("click", (e) => {
    const btn = e.target.closest(".kb-q-btn");
    if (!btn)
      return;
    clearRepeatSelection();
    const q = btn.dataset.q;
    if (activeQuarterly.has(q)) {
      activeQuarterly.delete(q);
      btn.style.cssText = wdStyle(false);
    } else {
      activeQuarterly.add(q);
      btn.style.cssText = wdStyle(true);
    }
  });
  wdWrap.addEventListener("click", (e) => {
    const btn = e.target.closest(".kb-wd-btn");
    if (!btn)
      return;
    clearRepeatSelection();
    const day = btn.dataset.day;
    if (activeWD.has(day)) {
      activeWD.delete(day);
      btn.style.cssText = wdStyle(false);
    } else {
      activeWD.add(day);
      btn.style.cssText = wdStyle(true);
    }
  });
  domSel.addEventListener("change", () => {
    const val = domSel.value;
    domSel.value = "";
    if (!val || val === "last_day" || selectedDays.includes(val))
      return;
    clearRepeatSelection();
    selectedDays.push(val);
    selectedDays.sort((a, b) => parseInt(a) - parseInt(b));
    renderDomRows();
  });
  moSel.addEventListener("change", () => {
    const val = moSel.value;
    moSel.value = "";
    if (!val || selectedMonths.includes(val))
      return;
    clearRepeatSelection();
    selectedMonths.push(val);
    selectedMonths.sort((a, b) => MO_KEYS.indexOf(a) - MO_KEYS.indexOf(b));
    renderMoRows();
  });
  domRows.addEventListener("click", (e) => {
    const btn = e.target.closest(".kb-rm-day");
    if (!btn)
      return;
    selectedDays.splice(parseInt(btn.dataset.idx, 10), 1);
    renderDomRows();
  });
  moRows.addEventListener("click", (e) => {
    const btn = e.target.closest(".kb-rm-month");
    if (!btn)
      return;
    selectedMonths.splice(parseInt(btn.dataset.idx, 10), 1);
    renderMoRows();
  });
  const submit = () => {
    if (repeatEnableChk.checked) {
      close();
      const spec = readRepeatSpec();
      const nextDate = formatDateAnnotation(addRepeatInterval(new Date(), spec));
      onSubmit(`${formatRepeatAnnotation(spec)} ${nextDate}`);
      return;
    }
    const tokens = [...activeWD, ...quarterlyActive ? ["quarterly"] : [], ...["quarterly+2", "quarterly+3"].filter((q) => activeQuarterly.has(q)), ...selectedDays, ...selectedMonths];
    if (!tokens.length) {
      errEl.textContent = "Select at least one trigger.";
      return;
    }
    close();
    onSubmit(tokens.map((t) => `@${t}`).join(" "));
  };
  setBtn.onclick = submit;
  noTriggerBtn.onclick = () => {
    close();
    onSubmit("");
  };
  cancelBtn.onclick = close;
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Enter")
      submit();
    if (e.key === "Escape")
      close();
  });
}
function showSubtaskDialog(onSubmit) {
  const { dialog, close } = makeOverlay("kanban-subtask-dialog");
  const prefill = CHECKLIST_MARK;
  dialog.innerHTML = `<h3 style="margin:0 0 10px;font-size:1.1em;">Add subtask</h3>
    <textarea id="k-text" placeholder="Enter subtask text..." style="${textareaStyle()}">${prefill}</textarea>
    <div style="text-align:left;">${checklistButtonHtml("k-text-checklist", "Insert checklist item")}</div>
    <div id="k-actions" style="display:flex;gap:10px;justify-content:center;">${buttonHtml("Add", true)}${buttonHtml("Cancel", false)}</div>`;
  const [addBtn, cancelBtn] = dialog.querySelectorAll("#k-actions button");
  const input = dialog.querySelector("#k-text");
  const checklistBtn = dialog.querySelector("#k-text-checklist");
  const submit = () => {
    const v = input.value;
    close();
    if (v.trim())
      onSubmit(v);
  };
  addBtn.onclick = submit;
  cancelBtn.onclick = close;
  checklistBtn.onclick = () => insertChecklistPrefix(input);
  input.onkeydown = (e) => {
    if (e.key === "Escape")
      close();
  };
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
async function addSubtaskToCard(app, filePath, afterLine, cardLine, text) {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    const cardIndent = (lines[cardLine - 1]?.match(/^(\s*)/) ?? ["", ""])[1];
    const subLines = formatNoteLines(cardIndent, text);
    if (!subLines.length)
      return false;
    lines.splice(afterLine, 0, ...subLines);
    await writeFileLines(app, tFile, lines);
    return true;
  } catch {
    return false;
  }
}
function maxSubLine(subs) {
  let max = 0;
  for (const s of subs ?? []) {
    if (s.line > max)
      max = s.line;
    const m = maxSubLine(s.subs);
    if (m > max)
      max = m;
  }
  return max;
}
function isCheckboxItem(s) {
  return /^[-*+]\s+\[[ xX]\]/.test((s.text ?? "").trim());
}
function isCheckedItem(s) {
  return /^[-*+]\s+\[[xX]\]/.test((s.text ?? "").trim());
}
function hasUnchecked(subs) {
  for (const s of subs ?? []) {
    if (isCheckboxItem(s) && !isCheckedItem(s))
      return true;
    if (s.subs?.length && hasUnchecked(s.subs))
      return true;
  }
  return false;
}
function createCardHTML(item, isMulti, currentNorm, config, vaultName) {
  let display = item.item.text;
  display = display.replace(/\s*%%[\s\S]*?%%\s*/g, " ").replace(/\s*✅\d{4}-\d{2}-\d{2}/, "").trim();
  const tagToRemove = extractTags(display).find(
    (t) => normalizeTag(t) === currentNorm
  );
  if (tagToRemove)
    display = display.split(/\s+/).filter((w) => w !== tagToRemove).join(" ").trim();
  const rawText = display.replace(/^- \[[ xX]\] /, "").replace(/^[-*+]\s+/, "").trim();
  const mainContent = formatInlineEmphasis(linksToHtml(formatCardDateAnnotation(formatTriggerAnnotations(rawText, config.normRecurrent)), vaultName), TITLE_FONT_WEIGHT);
  const hasSubs = item.item.subs.length > 0;
  const isExpanded = item.state === "expanded";
  function hasActiveKanban(subs) {
    for (const s of subs ?? []) {
      if (isCheckboxItem(s) && !isCheckedItem(s)) {
        const tags = s.tags ?? [];
        if (tags.some((t) => config.normActive.includes(normalizeTag(t))))
          return true;
      }
      if (s.subs?.length && hasActiveKanban(s.subs))
        return true;
    }
    return false;
  }
  function allUncheckedInLaterOrRecurrent(subs, inheritedCovered = false) {
    for (const s of subs ?? []) {
      const tags = s.tags ?? [];
      const selfCovered = tags.some((t) => {
        const norm = normalizeTag(t);
        return norm === config.normLater || norm === config.normRecurrent;
      });
      const covered = inheritedCovered || selfCovered;
      if (isCheckboxItem(s) && !isCheckedItem(s) && !covered)
        return false;
      if (s.subs?.length && !allUncheckedInLaterOrRecurrent(s.subs, covered))
        return false;
    }
    return true;
  }
  const isProjectColumn = config.normProject.includes(currentNorm);
  const isDoneColumn = currentNorm === config.normDone;
  const hasUnmanagedWork = isProjectColumn && hasUnchecked(item.item.subs) && !hasActiveKanban(item.item.subs) && !allUncheckedInLaterOrRecurrent(item.item.subs) || isDoneColumn && hasUnchecked(item.item.subs);
  function renderSub(sub, depth) {
    const parentTag = item.item.tags.find((t) => normalizeTag(t) === currentNorm) || "";
    const hasCheckbox = /^- \[[ xX]\] /.test(sub.text);
    const isChecked = /^- \[[xX]\] /.test(sub.text);
    const alreadyTagged = extractTags(sub.text).some(
      (t) => config.normKanban.includes(normalizeTag(t))
    );
    let subText = sub.text.replace(/\s*%%[\s\S]*?%%\s*/g, " ").replace(/\s*✅\d{4}-\d{2}-\d{2}/, "").trim().split(/\s+/).filter((w) => !(w.startsWith("#") && config.normKanban.includes(normalizeTag(w)))).join(" ").trim();
    const subEditRaw = subText.replace(/^- \[[ xX]\] /, "").replace(/^[-*+]\s+/, "").trim();
    subText = formatCardDateAnnotation(formatTriggerAnnotations(subText, config.normRecurrent, false), true);
    const indent = "&nbsp;".repeat(depth * 3);
    const rendered = renderCheckbox(subText, {
      isSub: true,
      showCheckbox: hasCheckbox,
      vaultName,
      enablePromotion: hasCheckbox && !isChecked && !alreadyTagged,
      subLine: sub.line,
      parentTag,
      parentDigits: item.digits
    });
    const subLastLine = maxSubLine(sub.subs) || sub.line;
    return `<div class="kb-sub-row" data-sub-line="${sub.line}" data-sub-last-line="${subLastLine}" data-sub-raw="${subEditRaw.replace(/"/g, "&quot;")}" style="margin:4px 0;line-height:1.5;">${indent}${rendered}</div>`;
  }
  function renderSubTree(subs, depth = 0) {
    return (subs || []).map((sub) => renderSub(sub, depth) + renderSubTree(sub.subs, depth + 1)).join("");
  }
  const addSubBtnStyle = `width:24px;height:24px;border-radius:50%;border:1px solid var(--background-modifier-border);background:none;cursor:pointer;font-size:1.1em;line-height:1;display:inline-flex;align-items:center;justify-content:center;color:inherit;`;
  const addSubBtn = `<button class="kb-add-sub" style="${addSubBtnStyle}">+</button>`;
  const TITLE_LINE_H = 1.5;
  const iconSpacer = (width) => `<span aria-hidden="true" style="float:right;width:${width}px;height:${TITLE_LINE_H}em;"></span>`;
  const titleStyle = `padding:6px 0;font-weight:${TITLE_FONT_WEIGHT};color:var(--kb-text);text-align:left;line-height:${TITLE_LINE_H};`;
  const bodyHTML = hasSubs ? `<div style="position:relative;">
         <div class="card-title" style="${titleStyle}cursor:pointer;"
              onclick="this.closest('.kanban-card').querySelector('details').toggleAttribute('open')">
           ${iconSpacer(18)}${mainContent}
           <span style="position:absolute;top:6px;right:2px;font-size:1.1em;line-height:1;color:var(--kb-accent);user-select:none;">${isExpanded ? "\u25B2" : "\u25BC"}</span>
         </div>
         <details ${isExpanded ? "open" : ""} style="margin:4px 0 0 0;">
           <summary style="display:none;"></summary>
           <div style="padding-left:8px;">${renderSubTree(item.item.subs)}</div>
           <div style="display:flex;justify-content:flex-end;margin-top:4px;">${addSubBtn}</div>
         </details>
       </div>` : `<div style="position:relative;">
         <div class="card-title" style="${titleStyle}">${iconSpacer(26)}${mainContent}</div>
         <button class="kb-add-sub" style="${addSubBtnStyle}position:absolute;top:4px;right:0;">+</button>
       </div>`;
  const border = isMulti ? "background:var(--background-modifier-error-hover);border:1px solid var(--background-modifier-error);" : hasUnmanagedWork ? `border:2px solid var(--kb-children-done);background:color-mix(in srgb,var(--kb-children-done) 20%,var(--kb-card-bg));` : "border:1px solid var(--background-modifier-border);";
  const src = item.source.path.split("/").pop().replace(/\.md$/, "");
  const href = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(item.filePath)}`;
  const badge = `<div style="margin-top:8px;font-size:.8em;color:var(--kb-text);">
    from: <a href="${href}" style="color:var(--kb-link);text-decoration:none;">${src}</a></div>`;
  const lastSubLn = maxSubLine(item.item.subs) || item.item.line;
  return `<div class="kanban-card"
    data-file="${item.filePath}"
    data-line="${item.item.line}"
    data-last-sub-line="${lastSubLn}"
    data-raw="${rawText.replace(/"/g, "&quot;")}"
    data-digits="${item.digits || ""}"
    data-state="${item.state}"
    data-tags='${JSON.stringify(item.item.tags).replace(/'/g, "&#39;")}'
    data-subs='${JSON.stringify(item.item.subs.map((s) => ({ line: s.line, text: s.text, subs: s.subs || [] }))).replace(/'/g, "&#39;")}'
    data-is-promoted="${item.isPromoted || false}"
    style="padding:10px 14px;margin:8px 0;border-radius:10px;background:var(--kb-card-bg);color:var(--kb-text);
           box-shadow:0 2px 8px rgba(0,0,0,.12);${border};cursor:move;position:relative;text-align:left;">
    ${item.indent > 0 ? '<span class="demote-btn" style="position:absolute;top:4px;left:6px;font-size:0.75em;color:var(--kb-accent);line-height:1;cursor:pointer;">&#x25B6;</span>' : ""}
    ${bodyHTML}
    ${badge}
  </div>`;
}
function hexLuminance(hex) {
  const clean = hex.replace(/^#/, "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  if (full.length !== 6)
    return 0.5;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const lin = (c) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function textOnBg(bgHex, lightText, darkText) {
  return hexLuminance(bgHex) > 0.179 ? darkText : lightText;
}
function buildColorCSS(config) {
  const cv = (val, fb) => val && val.trim() ? val.trim() : fb;
  const configuredDarkText = config.colorText && config.colorText.trim() ? config.colorText.trim() : "#1a1a1a";
  const overLimit = cv(config.colorColumnOverLimit, "#5c1a1a");
  const overText = textOnBg(overLimit, "#ffffff", configuredDarkText);
  const perColOverLimitRules = Object.entries(config.columnColors).filter(([, c]) => c).map(([norm, color]) => {
    const text = textOnBg(color, "#ffffff", configuredDarkText);
    return `
      #kanban-wrapper [data-col-container="${norm}"][data-col-overlimit="1"]{background:${color}!important;}
      #kanban-wrapper [data-col-container="${norm}"][data-col-overlimit="1"] h4,
      #kanban-wrapper [data-col-container="${norm}"][data-col-overlimit="1"] .kb-col-count,
      #kanban-wrapper [data-col-container="${norm}"][data-col-overlimit="1"] .kb-col-add-btn{color:${text}!important;}
      #kanban-wrapper [data-col-norm="${norm}"][data-col-overlimit="1"]{background:${color}!important;color:${text}!important;}
    `;
  }).join("");
  return `
    :root{--kb-dialog-text:${cv(config.colorText, "var(--text-normal)")};--kb-dialog-muted:${cv(config.colorText, "var(--text-muted)")}}
    #kanban-wrapper{
      --kb-card-bg:${cv(config.colorCardBg, "var(--background-secondary)")};
      --kb-col-bg:${cv(config.colorColumnBg, "var(--background-secondary)")};
      --kb-text:${cv(config.colorText, "var(--text-normal)")};
      --kb-accent:${cv(config.colorAccent, "var(--interactive-accent)")};
      --kb-link:${cv(config.colorLink, "var(--text-accent)")};
      --kb-family-self:${config.colorFamilySelf};
      --kb-family-parent:${config.colorFamilyParent};
      --kb-family-sibling:${config.colorFamilySibling};
      --kb-children-done:${config.allChildrenDoneColor};
      --kb-date-color:${config.colorDate};
      --kb-date-font:${config.fontDate};
      --kb-bold-color:${cv(config.colorBold, "color-mix(in srgb, var(--kb-text) 75%, black)")};
      --kb-italic-star-color:${cv(config.colorItalicStar, "color-mix(in srgb, var(--kb-text) 85%, white)")};
      --kb-italic-underscore-color:${cv(config.colorItalicUnderscore, "color-mix(in srgb, var(--kb-text) 55%, teal)")};
      color:var(--kb-text);
    }
    #kanban-wrapper [data-col-container]{background:var(--kb-col-bg);}
    #kanban-wrapper [data-col-norm]{background:var(--kb-col-bg);color:var(--kb-text);}
    #kanban-wrapper [data-col-norm][data-col-active="1"]{background:var(--kb-accent);color:var(--text-on-accent);font-weight:600;}
    #kanban-wrapper .kanban-card,.card-title{color:var(--kb-text);}
    #kanban-wrapper [data-col-container][data-col-overlimit="1"]{background:${overLimit}!important;}
    #kanban-wrapper [data-col-container][data-col-overlimit="1"] h4,
    #kanban-wrapper [data-col-container][data-col-overlimit="1"] .kb-col-count,
    #kanban-wrapper [data-col-container][data-col-overlimit="1"] .kb-col-add-btn{color:${overText}!important;}
    #kanban-wrapper [data-col-norm][data-col-overlimit="1"]{background:${overLimit}!important;color:${overText}!important;}
    ${perColOverLimitRules}`;
}
async function tagUntaggedRecurrentCards(app, paths, config) {
  const annotationRe = new RegExp(`@${config.normRecurrent}\\b`, "i");
  const listItemRe = /^(\s*)(?:[-*+]|\d+[.)]\s)/;
  for (const filePath of paths) {
    const tFile = app.vault.getAbstractFileByPath(filePath);
    if (!tFile)
      continue;
    let raw;
    try {
      raw = await app.vault.read(tFile);
    } catch {
      continue;
    }
    const lines = raw.split("\n");
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      if (!annotationRe.test(lines[i]))
        continue;
      const tags = extractTags(lines[i]);
      if (tags.some((t) => config.normKanban.includes(normalizeTag(t))))
        continue;
      const myIndent = (lines[i].match(/^(\s*)/) || [""])[0].length;
      if (myIndent > 0) {
        let skipLine = false;
        for (let j = i - 1; j >= 0; j--) {
          if (!listItemRe.test(lines[j]))
            continue;
          const parentIndent = (lines[j].match(/^(\s*)/) || [""])[0].length;
          if (parentIndent < myIndent) {
            const parentTags = extractTags(lines[j]);
            if (parentTags.some((t) => normalizeTag(t) === config.normRecurrent)) {
              skipLine = true;
            }
            break;
          }
        }
        if (skipLine)
          continue;
      }
      const parsed = parseTaskLine(lines[i]);
      parsed.tags.push(config.recurrentColumn);
      lines[i] = serializeTaskLine(parsed);
      if (!hasValidTriggers(lines[i], config.normRecurrent)) {
        const n = new Date();
        const skipStr = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
        lines[i] = setSkipDate(lines[i], skipStr);
      }
      changed = true;
    }
    if (changed)
      await app.vault.modify(tFile, lines.join("\n"));
  }
}
async function moveCheckedCardsToDone(app, paths, config) {
  if (!config.normDone)
    return;
  for (const filePath of paths) {
    const tFile = app.vault.getAbstractFileByPath(filePath);
    if (!tFile)
      continue;
    let raw;
    try {
      raw = await app.vault.read(tFile);
    } catch {
      continue;
    }
    const lines = raw.split("\n");
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseTaskLine(lines[i]);
      if (parsed.checked !== true)
        continue;
      if (!parsed.tags.some((t) => matchesKanbanTag(t, config.normKanban)))
        continue;
      if (parsed.tags.some((t) => normalizeTag(t) === config.normDone))
        continue;
      parsed.tags = parsed.tags.filter((t) => !matchesKanbanTag(t, config.normKanban));
      parsed.tags.push(config.doneColumn);
      if (!parsed.doneDate) {
        const n = new Date();
        parsed.doneDate = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
      }
      lines[i] = serializeTaskLine(parsed);
      changed = true;
    }
    if (changed)
      await app.vault.modify(tFile, lines.join("\n"));
  }
}
var KANBAN_NARROW_BREAKPOINT = 700;
function isNarrowLayout(width) {
  const isPhone = /iPhone|iPod|(Android.*Mobile)/i.test(navigator.userAgent);
  return isPhone || width < KANBAN_NARROW_BREAKPOINT;
}
async function buildBoard(app, containerEl, config, savedActiveCol) {
  _dialogDoc = containerEl.ownerDocument;
  const vaultName = app.vault.getName();
  const paths = await getTargetFilePaths(app, config);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (config.normRecurrent) {
    await tagUntaggedRecurrentCards(app, paths, config);
  }
  await moveCheckedCardsToDone(app, paths, config);
  let items = await collectItems(app, paths, config);
  const todayStrLater = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const laterToMove = items.filter((i) => {
    if (!i.item.tags.some((t) => normalizeTag(t) === config.normLater))
      return false;
    if (extractSkipDate(i.item.text) === todayStrLater)
      return false;
    if (!isLaterDueToday(i.item.text, today, config.normRecurrent))
      return false;
    const hasDate = !!parseCardDate(i.item.text);
    const hasTriggers = extractTriggerAnnotations(i.item.text, config.normRecurrent).some(isValidTriggerToken);
    if (!hasDate && !hasTriggers && hasDatedSub(i.item.subs))
      return false;
    return true;
  });
  if (laterToMove.length) {
    for (const item of laterToMove)
      await moveToColumn(app, item.filePath, item.item.line, item.item.tags, config.dueColumn, false, config, null, null, null, null, true);
    items = await collectItems(app, paths, config);
  }
  {
    const remainingLater = items.filter(
      (i) => i.item.tags.some((t) => normalizeTag(t) === config.normLater)
    );
    let anyLaterSubTriggered = false;
    for (const i of remainingLater) {
      if (await triggerDatedLaterSubs(app, i.item.subs, i.filePath, config, today))
        anyLaterSubTriggered = true;
    }
    if (anyLaterSubTriggered)
      items = await collectItems(app, paths, config);
  }
  if (config.normRecurrent) {
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const recurrentToMove = items.filter((i) => {
      if (!i.item.tags.some((t) => normalizeTag(t) === config.normRecurrent))
        return false;
      if (!hasRecurrentAnnotation(i.item.text, config.normRecurrent))
        return false;
      if (extractSkipDate(i.item.text) === todayStr)
        return false;
      const repeatDate = parseCardDate(i.item.text);
      if (repeatDate)
        return repeatDate <= today;
      const triggers = extractTriggerAnnotations(i.item.text, config.normRecurrent);
      if (triggers.length === 0)
        return !i.item.subs || i.item.subs.length === 0;
      return matchesTriggerAnnotations(triggers, today);
    });
    if (recurrentToMove.length) {
      for (const item of recurrentToMove)
        await moveToColumn(app, item.filePath, item.item.line, item.item.tags, config.dueColumn, false, config, null, null, null, null, true);
      items = await collectItems(app, paths, config);
    }
    let anySubTriggered = false;
    for (const i of items) {
      if (!i.item.tags.some((t) => normalizeTag(t) === config.normRecurrent))
        continue;
      if (await triggerRecurrentSubs(app, i.item.subs, i.filePath, config, today, todayStr))
        anySubTriggered = true;
    }
    if (anySubTriggered)
      items = await collectItems(app, paths, config);
  }
  const columns = groupByColumns(items, config);
  await assignInitialOrders(app, columns, config);
  const laterColData = columns[config.normLater];
  if (laterColData) {
    laterColData.cards.sort((a, b) => {
      const da = parseCardDate(a.item.text);
      const db = parseCardDate(b.item.text);
      if (!da && !db)
        return 0;
      if (!da)
        return 1;
      if (!db)
        return -1;
      return da.getTime() - db.getTime();
    });
  }
  const boardDoc = containerEl.ownerDocument;
  let _colorCss = boardDoc.getElementById("kanban-color-vars");
  if (!_colorCss) {
    _colorCss = boardDoc.createElement("style");
    _colorCss.id = "kanban-color-vars";
    boardDoc.head.appendChild(_colorCss);
  }
  _colorCss.textContent = buildColorCSS(config);
  let _css = boardDoc.getElementById("kanban-board-styles");
  if (!_css) {
    _css = boardDoc.createElement("style");
    _css.id = "kanban-board-styles";
    boardDoc.head.appendChild(_css);
  }
  _css.textContent = `
      #kanban-scroll::-webkit-scrollbar{height:8px}
      .kanban-card{-webkit-user-select:none;user-select:none;touch-action:none;}
      .drop-zone{touch-action:none;}
      #kanban-wrapper [data-col-container]:last-child .drop-zone{border-right:2px dashed var(--background-modifier-border);}
      .kanban-card.kh-self{outline:4px solid var(--kb-family-self)!important;background:color-mix(in srgb,var(--kb-family-self) 20%,var(--kb-card-bg))!important;}
      .kanban-card.kh-parent{outline:4px solid var(--kb-family-parent)!important;background:color-mix(in srgb,var(--kb-family-parent) 20%,var(--kb-card-bg))!important;}
      .kanban-card.kh-sibling{outline:4px solid var(--kb-family-sibling)!important;background:color-mix(in srgb,var(--kb-family-sibling) 20%,var(--kb-card-bg))!important;}
      @media(max-width:700px){
        #kanban-scroll{flex-direction:column;overflow-x:hidden;}
        #kanban-scroll>div{flex:none!important;width:calc(100% - 16px)!important;max-width:none!important;margin:0 8px 16px!important;}
      }`;
  const wrapper = containerEl.createEl("div", {
    attr: { id: "kanban-wrapper" }
  });
  const scroll = wrapper.createEl("div", {
    attr: {
      id: "kanban-scroll",
      style: "display:flex;overflow-x:auto;gap:0;padding:12px 0;-webkit-overflow-scrolling:touch;"
    }
  });
  const isNarrow = isNarrowLayout(
    wrapper.clientWidth > 0 ? wrapper.clientWidth : window.innerWidth
  );
  wrapper.dataset.narrow = isNarrow ? "1" : "0";
  const allNorms = Object.keys(columns).filter(
    (norm) => norm !== config.normDue || columns[norm].cards.length > 0
  );
  let activeNorm = savedActiveCol && allNorms.includes(savedActiveCol) ? savedActiveCol : config.normStart;
  if (!allNorms.includes(activeNorm))
    activeNorm = allNorms[0];
  if (isNarrow) {
    const tabBar = scroll.createEl("div", {
      attr: {
        style: "display:flex;gap:6px;flex-wrap:wrap;padding:4px 8px 14px;width:100%;box-sizing:border-box;touch-action:none;"
      }
    });
    for (const norm of allNorms) {
      const col = columns[norm];
      const isActive = norm === activeNorm;
      const tab = tabBar.createEl("button", {
        text: col.rawTag.replace(/^#/, "").toUpperCase(),
        attr: {
          style: `min-height:44px;padding:8px 18px;border-radius:22px;
            border:1px solid var(--background-modifier-border);
            font-size:.9em;cursor:pointer;
            transition:transform .1s,outline .1s;touch-action:none;`
        }
      });
      tab.dataset.colNorm = norm;
      tab.dataset.colActive = isActive ? "1" : "0";
      const tabMax = config.columnMaxCards[norm] || 0;
      if (tabMax > 0 && col.cards.length > tabMax) {
        tab.dataset.colOverlimit = "1";
      }
    }
  }
  const colKeys = isNarrow ? [activeNorm] : allNorms;
  for (const norm of colKeys) {
    const col = columns[norm];
    if (!col)
      continue;
    const colStyle = isNarrow ? `width:calc(100% - 16px);margin:0 8px 20px;padding:10px;` : `flex:1;min-width:200px;max-width:260px;padding:10px 0 10px 0;margin:0;display:flex;flex-direction:column;`;
    const colMax = config.columnMaxCards[norm] || 0;
    const colAttr = { style: colStyle, "data-col-container": norm };
    if (colMax > 0 && col.cards.length > colMax)
      colAttr["data-col-overlimit"] = "1";
    const colDiv = scroll.createEl("div", { attr: colAttr });
    const header = colDiv.createEl("div", {
      attr: { style: "display:flex;align-items:center;margin-bottom:10px;padding:0 4px;" }
    });
    header.createEl("h4", {
      text: col.rawTag.replace(/^#/, "").toUpperCase(),
      attr: { style: "margin:0;flex-grow:1;font-weight:bold;color:var(--kb-text);" }
    });
    header.createEl("span", {
      text: String(col.cards.length),
      attr: { class: "kb-col-count", style: "margin-right:6px;font-size:.75em;color:var(--kb-text);background:transparent;border:1px solid var(--background-modifier-border);border-radius:50%;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;" }
    });
    if (norm !== config.normDone) {
      const btn = header.createEl("button", {
        text: "+",
        attr: {
          class: "kb-col-add-btn",
          style: "width:24px;height:24px;border-radius:50%;border:1px solid var(--background-modifier-border);background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--kb-text);"
        }
      });
      btn.dataset.column = norm;
      btn.dataset.tag = col.rawTag;
    } else {
      const btn = header.createEl("button", {
        text: "Archive",
        attr: {
          class: "kb-col-add-btn",
          style: "height:24px;padding:0 8px;border-radius:12px;border:1px solid var(--background-modifier-border);background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.75em;color:var(--kb-text);"
        }
      });
      btn.dataset.column = norm;
    }
    const zone = colDiv.createEl("div", {
      attr: {
        class: `drop-zone drop-zone-${norm}`,
        style: "min-height:200px;border:2px dashed var(--background-modifier-border);border-right:none;border-radius:0;padding:5px;flex-grow:1;display:flex;flex-direction:column;"
      }
    });
    const insertSlot = (idx) => {
      const s = boardDoc.createElement("div");
      s.className = "insert-slot";
      s.style.cssText = "height:0;border-top:2px dashed transparent;width:100%";
      s.dataset.index = String(idx);
      return s;
    };
    if (col.cards.length > 0)
      zone.appendChild(insertSlot(0));
    col.cards.forEach((card, i) => {
      zone.innerHTML += createCardHTML(card, card.multiTag, norm, config, vaultName);
      if (i < col.cards.length - 1)
        zone.appendChild(insertSlot(i + 1));
    });
    zone.appendChild(insertSlot(col.cards.length));
  }
  wrapper.createEl("p", {
    attr: {
      id: "kanban-status",
      style: "margin-top:20px;text-align:center;color:var(--text-muted);font-size:.9em;"
    },
    text: `Found: ${items.length} items`
  });
}
function attachListeners(boardEl, config, app, refresh) {
  const ownerDoc = () => boardEl.ownerDocument;
  let draggedCard = null;
  let currentInsertIndex = -1;
  const cardDataFrom = (el) => {
    const c = el?.closest(".kanban-card");
    if (!c)
      return null;
    return {
      filePath: c.dataset.file,
      lineNum: parseInt(c.dataset.line, 10),
      originalTags: JSON.parse(c.dataset.tags),
      state: c.dataset.state,
      isPromoted: c.dataset.isPromoted === "true",
      subs: c.dataset.subs ? JSON.parse(c.dataset.subs) : [],
      rawText: c.dataset.raw || ""
    };
  };
  const siblingDataFrom = (zone) => Array.from(zone.querySelectorAll(".kanban-card")).map((c) => {
    const digits = c.dataset.digits || "99999";
    return { digits, len: digits.length };
  }).sort((a, b) => compareDigits(a.digits, b.digits));
  const highlightNearestSlot = (zone, clientY) => {
    const rect = zone.getBoundingClientRect();
    const y = clientY - rect.top;
    let nearest = null, minDist = Infinity;
    zone.querySelectorAll(".insert-slot").forEach((slot) => {
      const sr = slot.getBoundingClientRect();
      const dist = Math.abs(sr.top + sr.height / 2 - rect.top - y);
      if (dist < minDist) {
        minDist = dist;
        nearest = slot;
      }
    });
    document.querySelectorAll(".insert-slot").forEach(
      (s) => s.style.borderTopColor = "transparent"
    );
    if (nearest) {
      nearest.style.borderTopColor = "var(--kb-accent)";
      currentInsertIndex = parseInt(nearest.dataset.index, 10);
    }
  };
  const resolveTargetNorm = (zone) => {
    const m = zone.className.match(/drop-zone-([\w-]+)/);
    return m ? m[1] : null;
  };
  const clearHighlights = () => {
    boardEl.querySelectorAll(".kanban-card").forEach(
      (c) => c.classList.remove("kh-self", "kh-parent", "kh-sibling")
    );
  };
  const subsHasLine = (subs, line) => subs.some((s) => s.line === line);
  const subsHasLineDeep = (subs, line) => subs.some((s) => s.line === line || subsHasLineDeep(s.subs || [], line));
  const applyHighlights = (card) => {
    clearHighlights();
    const file = card.dataset.file;
    const allCards = Array.from(boardEl.querySelectorAll(".kanban-card"));
    let topParent = card;
    for (let safety = 0; safety < 20; safety++) {
      const tpLine = parseInt(topParent.dataset.line, 10);
      const parent = allCards.find(
        (o) => o !== topParent && o.dataset.file === file && subsHasLineDeep(JSON.parse(o.dataset.subs || "[]"), tpLine)
      );
      if (!parent)
        break;
      topParent = parent;
    }
    const family = /* @__PURE__ */ new Set([topParent]);
    const queue = [topParent];
    while (queue.length) {
      const curr = queue.shift();
      const subs = JSON.parse(curr.dataset.subs || "[]");
      for (const other of allCards) {
        if (family.has(other) || other.dataset.file !== file)
          continue;
        if (subsHasLineDeep(subs, parseInt(other.dataset.line, 10))) {
          family.add(other);
          queue.push(other);
        }
      }
    }
    const ownSubs = JSON.parse(card.dataset.subs || "[]");
    const children = new Set(
      allCards.filter(
        (o) => o !== card && o.dataset.file === file && subsHasLine(ownSubs, parseInt(o.dataset.line, 10))
      )
    );
    if (family.size === 1 && topParent === card)
      return;
    topParent.classList.add("kh-self");
    for (const member of family) {
      if (member === topParent)
        continue;
      member.classList.add(children.has(member) ? "kh-sibling" : "kh-parent");
    }
  };
  function onMouseOver(e) {
    const card = e.target.closest(".kanban-card");
    if (!card)
      return;
    if (!card.classList.contains("kh-self"))
      applyHighlights(card);
  }
  function onMouseOut(e) {
    const toEl = e.relatedTarget;
    if (!toEl?.closest(".kanban-card"))
      clearHighlights();
  }
  function onCardClick(e) {
    const card = e.target.closest(".kanban-card");
    if (!card)
      return;
    applyHighlights(card);
  }
  async function doMove(card, targetNorm, zone) {
    if (!card)
      return;
    const targetTag = config.kanban.find(
      (t) => normalizeTag(t) === targetNorm
    );
    if (!targetTag)
      return;
    if (config.normProject.includes(targetNorm) && card.subs.length === 0 && !card.isPromoted) {
      const plainTitle = card.rawText.replace(/#[\w-]+/g, "").replace(/\s+/g, " ").trim();
      const confirmed = await showConfirmDialog(`Create a project document for "${plainTitle}"?`);
      if (confirmed) {
        await moveCardToNewDoc(app, card.filePath, card.lineNum, plainTitle, targetTag, config);
        requestAnimationFrame(() => setTimeout(refresh, 50));
        currentInsertIndex = -1;
        return;
      }
    }
    const isDone = targetNorm === config.normDone;
    const newState = "collapsed";
    const siblings = zone ? siblingDataFrom(zone) : [];
    const insertIdx = zone && currentInsertIndex >= 0 ? currentInsertIndex : siblings.length;
    const isMulti = card.originalTags.map(normalizeTag).filter((t) => config.normKanban.includes(t)).length > 1;
    const newCalc = calcInsertOrder(siblings, insertIdx, isMulti);
    const colTitle = targetTag.replace(/^#/, "").replace(/\b\w/g, (l) => l.toUpperCase());
    if (config.normRecurrent && targetNorm === config.normRecurrent) {
      const { lines } = await readFileLines(app, card.filePath);
      const lineTxt = lines[card.lineNum - 1] || "";
      if (!hasValidTriggers(lineTxt, config.normRecurrent)) {
        showRecurrentTriggerDialog(async (trigger) => {
          await moveToColumn(app, card.filePath, card.lineNum, card.originalTags, targetTag, false, config, null, newCalc.digits, newState, trigger);
          requestAnimationFrame(() => setTimeout(refresh, 50));
        }, [], extractRepeatSpec(lineTxt));
        return;
      }
      const ok = await moveToColumn(app, card.filePath, card.lineNum, card.originalTags, targetTag, false, config, null, newCalc.digits, newState);
      if (ok)
        requestAnimationFrame(() => setTimeout(refresh, 50));
    } else if (targetNorm === config.normLater) {
      const { lines } = await readFileLines(app, card.filePath);
      const lineTxt = lines[card.lineNum - 1] || "";
      const dateMatch = lineTxt.replace(/%%[\s\S]*?@\s*\d+\s*[cx]\s*%%/g, "").trim().match(/@(\d{4}-\d{2}-\d{2})/);
      const existing = dateMatch ? new Date(dateMatch[1] + "T00:00:00") : null;
      const defDate = getDefaultDate(existing).toISOString().split("T")[0];
      showDateDialog(
        `Set date for ${colTitle}`,
        defDate,
        async (dateStr) => {
          await moveToColumn(
            app,
            card.filePath,
            card.lineNum,
            card.originalTags,
            targetTag,
            false,
            config,
            dateStr,
            newCalc.digits,
            newState,
            null,
            dateStr === null
          );
          requestAnimationFrame(() => setTimeout(refresh, 50));
        }
      );
    } else {
      const openOnDone = isDone && hasUnchecked(card.subs);
      const ok = await moveToColumn(
        app,
        card.filePath,
        card.lineNum,
        card.originalTags,
        targetTag,
        isDone,
        config,
        null,
        newCalc.digits,
        openOnDone ? "expanded" : newState
      );
      if (ok)
        requestAnimationFrame(() => setTimeout(refresh, 50));
    }
    currentInsertIndex = -1;
  }
  async function onSubCheckClick(e) {
    const cb = e.target.closest(".kb-sub-check");
    if (!cb)
      return;
    e.stopPropagation();
    const card = cb.closest(".kanban-card");
    if (!card)
      return;
    const filePath = card.dataset.file;
    const subLineNum = parseInt(cb.dataset.subLine, 10);
    if (!filePath || isNaN(subLineNum) || subLineNum < 1)
      return;
    const { tFile, lines } = await readFileLines(app, filePath);
    if (subLineNum > lines.length)
      return;
    const parsed = parseTaskLine(lines[subLineNum - 1]);
    if (parsed.checked === null)
      return;
    parsed.checked = !parsed.checked;
    if (parsed.checked) {
      const n = new Date();
      parsed.doneDate = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
    } else {
      parsed.doneDate = null;
    }
    lines[subLineNum - 1] = serializeTaskLine(parsed);
    await writeFileLines(app, tFile, lines);
    refresh();
  }
  async function onAddSubClick(e) {
    const btn = e.target.closest(".kb-add-sub");
    if (!btn)
      return;
    e.stopPropagation();
    const card = btn.closest(".kanban-card");
    if (!card)
      return;
    const filePath = card.dataset.file;
    const cardLine = parseInt(card.dataset.line, 10);
    const afterLine = parseInt(card.dataset.lastSubLine, 10);
    const tags = JSON.parse(card.dataset.tags || "[]");
    const normTags = tags.map(normalizeTag);
    const isLater = normTags.some((t) => t === config.normLater);
    const isRecurrent = !!(config.normRecurrent && normTags.some((t) => t === config.normRecurrent));
    const doAdd = async (text) => {
      if (await addSubtaskToCard(app, filePath, afterLine, cardLine, text))
        requestAnimationFrame(() => setTimeout(refresh, 50));
    };
    showSubtaskDialog(async (text) => {
      if (isLater) {
        const defDate = getDefaultDate().toISOString().split("T")[0];
        showDateDialog("Set date for subtask", defDate, async (dateStr) => {
          await doAdd(dateStr ? appendToFirstLine(text, dateStr) : text);
        });
      } else if (isRecurrent) {
        showRecurrentTriggerDialog(async (triggerStr) => {
          const n = new Date();
          const skipStr = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
          const triggerPart = triggerStr ? ` ${triggerStr}` : "";
          await doAdd(appendToFirstLine(text, `@${config.normRecurrent}${triggerPart} %% @skip:${skipStr} %%`));
        });
      } else {
        await doAdd(text);
      }
    });
  }
  async function onPromoteClick(e) {
    const icon = e.target.closest(".promote-icon");
    if (!icon)
      return;
    e.stopPropagation();
    const card = icon.closest(".kanban-card");
    if (!card)
      return;
    await promoteSubToChild(
      app,
      card.dataset.file,
      parseInt(icon.dataset.line, 10),
      icon.dataset.parentTag,
      icon.dataset.parentDigits || "0",
      config,
      refresh
    );
  }
  async function onDemoteClick(e) {
    const btn = e.target.closest(".demote-btn");
    if (!btn)
      return;
    e.stopPropagation();
    const card = btn.closest(".kanban-card");
    if (!card)
      return;
    const filePath = card.dataset.file;
    const lineNum = parseInt(card.dataset.line, 10);
    const { tFile, lines } = await readFileLines(app, filePath);
    if (lineNum < 1 || lineNum > lines.length)
      return;
    const parsed = parseTaskLine(lines[lineNum - 1]);
    parsed.tags = parsed.tags.filter((t) => !config.normKanban.includes(normalizeTag(t)));
    lines[lineNum - 1] = serializeTaskLine(parsed);
    if (config.normRecurrent && hasRecurrentAnnotation(lines[lineNum - 1], config.normRecurrent)) {
      const n = new Date();
      const skipStr = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
      lines[lineNum - 1] = setSkipDate(lines[lineNum - 1], skipStr);
    }
    await writeFileLines(app, tFile, lines);
    refresh();
  }
  async function onDateLabelClick(e) {
    const span = e.target.closest(".kb-date-label");
    if (!span)
      return;
    e.stopPropagation();
    const card = span.closest(".kanban-card");
    if (!card)
      return;
    const currentDateStr = span.dataset.date || "";
    const existing = currentDateStr ? new Date(currentDateStr + "T00:00:00") : null;
    const defDate = (existing && !isNaN(existing.getTime()) ? existing : getDefaultDate()).toISOString().split("T")[0];
    showDateDialog("Change date", defDate, async (dateStr) => {
      await updateCardDate(app, card.dataset.file, parseInt(card.dataset.line, 10), dateStr);
      requestAnimationFrame(() => setTimeout(refresh, 50));
    });
  }
  async function onTriggerLabelClick(e) {
    const span = e.target.closest(".kb-trigger-label");
    if (!span)
      return;
    e.stopPropagation();
    const card = span.closest(".kanban-card");
    if (!card)
      return;
    const rawText = card.dataset.raw || "";
    const existing = extractTriggerAnnotations(rawText, config.normRecurrent);
    showRecurrentTriggerDialog(async (newTriggerStr) => {
      await updateCardTriggers(app, card.dataset.file, parseInt(card.dataset.line, 10), config.normRecurrent, newTriggerStr);
      requestAnimationFrame(() => setTimeout(refresh, 50));
    }, existing, extractRepeatSpec(rawText));
  }
  async function onDblClick(e) {
    if (e.target.closest("a,button,.promote-icon,.demote-btn,.kb-date-label,.kb-trigger-label"))
      return;
    const titleDiv = e.target.closest(".card-title");
    if (!titleDiv)
      return;
    const card = titleDiv.closest(".kanban-card");
    if (!card)
      return;
    if (isNarrowNow()) {
      showCardMenu(card);
      return;
    }
    await startTitleEdit(card, titleDiv);
  }
  async function startTitleEdit(card, titleDivArg) {
    const titleDiv = titleDivArg ?? card.querySelector(".card-title");
    if (!titleDiv)
      return;
    if (titleDiv.querySelector(".card-edit-input"))
      return;
    const raw = card.dataset.raw || "";
    const filePath = card.dataset.file;
    const lineNum = parseInt(card.dataset.line, 10);
    const savedHTML = titleDiv.innerHTML;
    const input = ownerDoc().createElement("textarea");
    input.value = raw;
    input.className = "card-edit-input";
    input.rows = 1;
    input.style.cssText = `
      width:100%;box-sizing:border-box;
      background:var(--background-primary);
      color:var(--text-normal);
      border:none;border-bottom:2px solid var(--kb-accent);
      outline:none;padding:2px 0;font-size:inherit;font-weight:600;
      font-family:inherit;border-radius:0;
      resize:none;overflow:hidden;line-height:inherit;display:block;`;
    const autoResize = () => {
      input.style.height = "0px";
      input.style.height = input.scrollHeight + "px";
    };
    const arrow = titleDiv.querySelector("span[style*='position:absolute']");
    titleDiv.innerHTML = "";
    titleDiv.appendChild(input);
    if (arrow)
      titleDiv.appendChild(arrow);
    titleDiv.onclick = null;
    const finishEdit = async (save) => {
      if (!titleDiv.contains(input))
        return;
      const newText = input.value.trim();
      if (card.querySelector("details")) {
        titleDiv.onclick = function() {
          this.closest(".kanban-card")?.querySelector("details")?.toggleAttribute("open");
        };
      }
      if (save && !newText) {
        const lastLine = parseInt(card.dataset.lastSubLine || `${lineNum}`, 10);
        await deleteLineRange(app, filePath, lineNum, lastLine);
        requestAnimationFrame(() => setTimeout(refresh, 50));
      } else if (save && newText !== raw) {
        card.dataset.raw = newText;
        await editCardText(app, filePath, lineNum, newText);
        requestAnimationFrame(() => setTimeout(refresh, 50));
      } else {
        titleDiv.innerHTML = savedHTML;
      }
    };
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        await finishEdit(true);
      }
      if (e.key === "Escape")
        await finishEdit(false);
    });
    input.addEventListener("input", autoResize);
    input.addEventListener("blur", () => finishEdit(true));
    input.addEventListener("dblclick", (e) => e.stopPropagation());
    requestAnimationFrame(() => requestAnimationFrame(() => {
      autoResize();
      input.focus();
      input.select();
    }));
  }
  async function onSubDblClick(e) {
    if (e.target.closest("a,button,.promote-icon,.demote-btn,.kb-date-label,.kb-trigger-label,.kb-sub-check"))
      return;
    const subRow = e.target.closest(".kb-sub-row");
    if (!subRow)
      return;
    const card = subRow.closest(".kanban-card");
    if (!card)
      return;
    if (subRow.querySelector(".card-edit-input"))
      return;
    const raw = subRow.dataset.subRaw || "";
    const filePath = card.dataset.file;
    const lineNum = parseInt(subRow.dataset.subLine, 10);
    if (isNaN(lineNum))
      return;
    const savedHTML = subRow.innerHTML;
    const input = ownerDoc().createElement("textarea");
    input.value = raw;
    input.className = "card-edit-input";
    input.rows = 1;
    input.style.cssText = `
      width:100%;box-sizing:border-box;
      background:var(--background-primary);
      color:var(--text-normal);
      border:none;border-bottom:2px solid var(--kb-accent);
      outline:none;padding:2px 0;font-size:inherit;font-weight:inherit;
      font-family:inherit;border-radius:0;
      resize:none;overflow:hidden;line-height:inherit;display:block;`;
    const autoResize = () => {
      input.style.height = "0px";
      input.style.height = input.scrollHeight + "px";
    };
    subRow.innerHTML = "";
    subRow.appendChild(input);
    const finishEdit = async (save) => {
      if (!subRow.contains(input))
        return;
      const newText = input.value.trim();
      if (save && !newText) {
        const lastLine = parseInt(subRow.dataset.subLastLine || `${lineNum}`, 10);
        await deleteLineRange(app, filePath, lineNum, lastLine);
        requestAnimationFrame(() => setTimeout(refresh, 50));
      } else if (save && newText !== raw) {
        subRow.dataset.subRaw = newText;
        await editCardText(app, filePath, lineNum, newText);
        requestAnimationFrame(() => setTimeout(refresh, 50));
      } else {
        subRow.innerHTML = savedHTML;
      }
    };
    input.addEventListener("keydown", async (e2) => {
      if (e2.key === "Enter") {
        e2.preventDefault();
        await finishEdit(true);
      }
      if (e2.key === "Escape")
        await finishEdit(false);
    });
    input.addEventListener("input", autoResize);
    input.addEventListener("blur", () => finishEdit(true));
    input.addEventListener("dblclick", (e2) => e2.stopPropagation());
    requestAnimationFrame(() => requestAnimationFrame(() => {
      autoResize();
      input.focus();
      input.select();
    }));
  }
  async function onToggle(e) {
    const details = e.target;
    if (details.tagName !== "DETAILS")
      return;
    const card = details.closest(".kanban-card");
    if (!card)
      return;
    const newState = details.open ? "expanded" : "collapsed";
    await updateFileOrderComment(
      app,
      card.dataset.file,
      parseInt(card.dataset.line, 10),
      card.dataset.digits || "00000",
      newState
    );
    card.dataset.state = newState;
  }
  let touchCard = null;
  let ghost = null;
  let isTouchDrag = false;
  let touchTimer = null;
  let selectedCard = null;
  let colPickerOverlay = null;
  const DRAG_DELAY = 450, MOVE_THRESHOLD = 8;
  let touchStartX = 0, touchStartY = 0;
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panScrollStart = 0;
  let panScrollTopStart = 0;
  const isNarrowNow = () => {
    const w = document.getElementById("kanban-wrapper");
    return w ? w.dataset.narrow === "1" : false;
  };
  const closeColPicker = () => {
    colPickerOverlay?.remove();
    colPickerOverlay = null;
  };
  const clearSelection = () => {
    closeColPicker();
    if (selectedCard) {
      selectedCard.style.outline = "";
      selectedCard.style.transform = "";
      selectedCard = null;
      draggedCard = null;
    }
    boardEl.querySelectorAll("[data-col-norm]").forEach((t) => {
      t.style.outline = "";
      t.style.transform = "";
      t.style.background = "";
    });
  };
  const showCardMenu = (card) => {
    closeColPicker();
    const savedCard = cardDataFrom(card);
    selectedCard = card;
    card.style.outline = "2px solid var(--kb-accent)";
    card.style.transform = "scale(1.02)";
    const doc = ownerDoc();
    const overlay = doc.createElement("div");
    overlay.id = "kanban-col-picker";
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:flex-end;justify-content:center;";
    doc.body.appendChild(overlay);
    colPickerOverlay = overlay;
    const sheet = doc.createElement("div");
    sheet.style.cssText = "background:var(--background-primary);color:var(--text-normal);padding:16px 16px 32px;border-radius:16px 16px 0 0;width:100%;max-width:480px;box-shadow:0 -4px 24px rgba(0,0,0,.2);";
    overlay.appendChild(sheet);
    const title = doc.createElement("p");
    title.textContent = "Move to column";
    title.style.cssText = "margin:0 0 14px;font-size:.9em;font-weight:600;text-align:center;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;";
    sheet.appendChild(title);
    const list = doc.createElement("div");
    list.style.cssText = "display:flex;flex-direction:column;gap:8px;";
    sheet.appendChild(list);
    const tabs = Array.from(boardEl.querySelectorAll("[data-col-norm]"));
    for (const tab of tabs) {
      const norm = tab.dataset.colNorm;
      const label = tab.textContent || norm.toUpperCase();
      const cc = config.columnColors?.[norm] || "";
      const btn = doc.createElement("button");
      btn.textContent = label;
      btn.style.cssText = `padding:14px 16px;border-radius:10px;border:1px solid var(--background-modifier-border);background:${cc ? `color-mix(in srgb,${cc} 20%,var(--background-secondary))` : "var(--background-secondary)"};color:var(--text-normal);font-size:1em;cursor:pointer;text-align:left;font-weight:500;`;
      btn.addEventListener("click", async () => {
        closeColPicker();
        clearSelection();
        touchCard = null;
        currentInsertIndex = -1;
        await doMove(savedCard, norm, null);
      });
      list.appendChild(btn);
    }
    const editBtn = doc.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.style.cssText = "margin-top:12px;padding:14px;border-radius:10px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);width:100%;cursor:pointer;font-size:1em;font-weight:500;";
    editBtn.addEventListener("click", () => {
      closeColPicker();
      clearSelection();
      touchCard = null;
      startTitleEdit(card);
    });
    sheet.appendChild(editBtn);
    const deleteBtn = doc.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.style.cssText = "margin-top:8px;padding:14px;border-radius:10px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-error, #e03e3e);width:100%;cursor:pointer;font-size:1em;font-weight:500;";
    deleteBtn.addEventListener("click", async () => {
      closeColPicker();
      clearSelection();
      touchCard = null;
      const confirmed = await showConfirmDialog("Delete this card?");
      if (!confirmed)
        return;
      const filePath = card.dataset.file;
      const lineNum = parseInt(card.dataset.line, 10);
      const lastLine = parseInt(card.dataset.lastSubLine || `${lineNum}`, 10);
      await deleteLineRange(app, filePath, lineNum, lastLine);
      requestAnimationFrame(() => setTimeout(refresh, 50));
    });
    sheet.appendChild(deleteBtn);
    const cancelBtn = doc.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = "margin-top:12px;padding:14px;border-radius:10px;border:1px solid var(--background-modifier-border);background:none;color:var(--text-muted);width:100%;cursor:pointer;font-size:1em;";
    cancelBtn.addEventListener("click", () => {
      clearSelection();
      touchCard = null;
    });
    sheet.appendChild(cancelBtn);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        clearSelection();
        touchCard = null;
      }
    });
  };
  const clearTouch = () => {
    if (touchTimer)
      clearTimeout(touchTimer);
    isTouchDrag = false;
    isPanning = false;
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    boardEl.querySelectorAll(".kanban-card").forEach(
      (c) => c.style.opacity = "1"
    );
    boardEl.querySelectorAll(".drop-zone").forEach(
      (z) => z.style.borderColor = "var(--background-modifier-border)"
    );
    boardEl.querySelectorAll(".insert-slot").forEach(
      (s) => s.style.borderTopColor = "transparent"
    );
    clearSelection();
    touchCard = null;
    draggedCard = null;
    currentInsertIndex = -1;
  };
  const collapseCardEl = (el) => {
    el.querySelector("details")?.removeAttribute("open");
    const titleSpan = el.querySelector(".card-title span");
    if (titleSpan)
      titleSpan.textContent = "\u25BC";
  };
  const makeGhost = (card) => {
    const rect = card.getBoundingClientRect();
    const g = card.cloneNode(true);
    collapseCardEl(g);
    Object.assign(g.style, {
      position: "fixed",
      left: rect.left + "px",
      top: rect.top + "px",
      width: rect.width + "px",
      opacity: ".75",
      pointerEvents: "none",
      zIndex: "10001",
      borderRadius: "10px",
      boxShadow: "0 8px 24px rgba(0,0,0,.25)",
      transition: "none"
    });
    ownerDoc().body.appendChild(g);
    return g;
  };
  const targetFromPoint = (x, y) => {
    if (ghost)
      ghost.style.display = "none";
    const el = ownerDoc().elementFromPoint(x, y);
    if (ghost)
      ghost.style.display = "";
    return {
      zone: el?.closest(".drop-zone"),
      tabNorm: el?.closest("[data-col-norm]")?.dataset.colNorm ?? null
    };
  };
  function onTouchStart(e) {
    if (e.touches.length !== 1) {
      clearTouch();
      return;
    }
    if (boardEl.querySelector(".card-edit-input"))
      return;
    if (e.target.closest("button,a,input,textarea,.promote-icon,.demote-btn"))
      return;
    const card = e.target.closest(".kanban-card");
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    if (!card) {
      if (isNarrowNow())
        return;
      isPanning = true;
      panStartX = e.touches[0].clientX;
      panStartY = e.touches[0].clientY;
      const scrollEl = ownerDoc().getElementById("kanban-scroll");
      panScrollStart = scrollEl ? scrollEl.scrollLeft : 0;
      const vertEl = boardEl.closest(".view-content") ?? ownerDoc().documentElement;
      panScrollTopStart = vertEl.scrollTop;
      return;
    }
    touchCard = card;
    draggedCard = cardDataFrom(card);
    touchTimer = setTimeout(() => {
      if (!isTouchDrag) {
        isTouchDrag = true;
        ghost = makeGhost(card);
        collapseCardEl(card);
        card.style.opacity = ".35";
      }
    }, DRAG_DELAY);
  }
  function onTouchMove(e) {
    if (isPanning && e.touches.length === 1) {
      const t = e.touches[0];
      const scrollEl = ownerDoc().getElementById("kanban-scroll");
      if (scrollEl)
        scrollEl.scrollLeft = panScrollStart - (t.clientX - panStartX);
      const vertEl = boardEl.closest(".view-content") ?? ownerDoc().documentElement;
      vertEl.scrollTop = panScrollTopStart - (t.clientY - panStartY);
      e.preventDefault();
      return;
    }
    if (!touchCard || e.touches.length !== 1)
      return;
    const { clientX, clientY } = e.touches[0];
    const dx = Math.abs(clientX - touchStartX);
    const dy = Math.abs(clientY - touchStartY);
    if (!isTouchDrag) {
      if (dy > dx * 2 && dy > MOVE_THRESHOLD) {
        clearTouch();
        return;
      }
      if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) {
        if (touchTimer)
          clearTimeout(touchTimer);
        isTouchDrag = true;
        if (!ghost)
          ghost = makeGhost(touchCard);
        collapseCardEl(touchCard);
        touchCard.style.opacity = ".35";
      }
    }
    if (!isTouchDrag)
      return;
    ghost.style.left = clientX - ghost.offsetWidth / 2 + "px";
    ghost.style.top = clientY - ghost.offsetHeight / 2 - 20 + "px";
    const { zone, tabNorm } = targetFromPoint(clientX, clientY);
    boardEl.querySelectorAll(".drop-zone").forEach(
      (z) => z.style.borderColor = "var(--background-modifier-border)"
    );
    boardEl.querySelectorAll("[data-col-norm]").forEach((t) => {
      t.style.outline = "";
      t.style.transform = "";
    });
    if (zone) {
      zone.style.borderColor = "var(--kb-accent)";
      highlightNearestSlot(zone, clientY);
    } else if (tabNorm) {
      const tab = boardEl.querySelector(
        `[data-col-norm="${tabNorm}"]`
      );
      if (tab) {
        tab.style.outline = "2px solid var(--kb-accent)";
        tab.style.transform = "scale(1.08)";
      }
    }
    e.preventDefault();
  }
  async function onTouchEnd(e) {
    if (touchTimer)
      clearTimeout(touchTimer);
    if (isPanning) {
      isPanning = false;
      return;
    }
    const { clientX, clientY } = e.changedTouches[0];
    if (!isTouchDrag || !draggedCard) {
      clearTouch();
      return;
    }
    const { zone, tabNorm } = targetFromPoint(clientX, clientY);
    const savedCard = draggedCard;
    const savedInsertIdx = currentInsertIndex;
    clearTouch();
    if (zone) {
      const norm = resolveTargetNorm(zone);
      if (norm) {
        currentInsertIndex = savedInsertIdx;
        await doMove(savedCard, norm, zone);
        currentInsertIndex = -1;
      }
    } else if (tabNorm) {
      await doMove(savedCard, tabNorm, null);
    }
    e.preventDefault();
  }
  let mouseCard = null;
  let isMouseDrag = false;
  let mouseStartX = 0, mouseStartY = 0;
  const clearMouseDrag = () => {
    isMouseDrag = false;
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    if (mouseCard) {
      mouseCard.style.opacity = "1";
      mouseCard = null;
    }
    draggedCard = null;
    ownerDoc().body.style.userSelect = "";
    boardEl.querySelectorAll(".drop-zone").forEach(
      (z) => z.style.borderColor = "var(--background-modifier-border)"
    );
    boardEl.querySelectorAll(".insert-slot").forEach(
      (s) => s.style.borderTopColor = "transparent"
    );
    currentInsertIndex = -1;
    ownerDoc().removeEventListener("mousemove", onMouseMove);
    ownerDoc().removeEventListener("mouseup", onMouseUp);
  };
  function onMouseDown(e) {
    if (e.button !== 0)
      return;
    if (boardEl.querySelector(".card-edit-input"))
      return;
    if (e.target.closest("button,a,input,.promote-icon,.demote-btn"))
      return;
    const card = e.target.closest(".kanban-card");
    if (!card)
      return;
    mouseCard = card;
    draggedCard = cardDataFrom(card);
    mouseStartX = e.clientX;
    mouseStartY = e.clientY;
    ownerDoc().addEventListener("mousemove", onMouseMove);
    ownerDoc().addEventListener("mouseup", onMouseUp);
  }
  function onMouseMove(e) {
    if (!mouseCard)
      return;
    const dx = Math.abs(e.clientX - mouseStartX);
    const dy = Math.abs(e.clientY - mouseStartY);
    if (!isMouseDrag) {
      if (dx < MOVE_THRESHOLD && dy < MOVE_THRESHOLD)
        return;
      isMouseDrag = true;
      ghost = makeGhost(mouseCard);
      collapseCardEl(mouseCard);
      mouseCard.style.opacity = ".35";
      ownerDoc().body.style.userSelect = "none";
    }
    ghost.style.left = e.clientX - ghost.offsetWidth / 2 + "px";
    ghost.style.top = e.clientY - ghost.offsetHeight / 2 - 20 + "px";
    const { zone, tabNorm } = targetFromPoint(e.clientX, e.clientY);
    boardEl.querySelectorAll(".drop-zone").forEach(
      (z) => z.style.borderColor = "var(--background-modifier-border)"
    );
    boardEl.querySelectorAll("[data-col-norm]").forEach((t) => {
      t.style.outline = "";
      t.style.transform = "";
    });
    if (zone) {
      zone.style.borderColor = "var(--kb-accent)";
      highlightNearestSlot(zone, e.clientY);
    } else if (tabNorm) {
      const tab = boardEl.querySelector(`[data-col-norm="${tabNorm}"]`);
      if (tab) {
        tab.style.outline = "2px solid var(--kb-accent)";
        tab.style.transform = "scale(1.08)";
      }
    }
  }
  async function onMouseUp(e) {
    ownerDoc().removeEventListener("mousemove", onMouseMove);
    ownerDoc().removeEventListener("mouseup", onMouseUp);
    if (!isMouseDrag || !draggedCard) {
      clearMouseDrag();
      return;
    }
    const { zone, tabNorm } = targetFromPoint(e.clientX, e.clientY);
    const savedCard = draggedCard;
    const savedInsertIdx = currentInsertIndex;
    clearMouseDrag();
    if (zone) {
      const norm = resolveTargetNorm(zone);
      if (norm) {
        currentInsertIndex = savedInsertIdx;
        await doMove(savedCard, norm, zone);
        currentInsertIndex = -1;
      }
    } else if (tabNorm) {
      await doMove(savedCard, tabNorm, null);
    }
  }
  let isMidPan = false;
  let midPanStartX = 0;
  let midPanStartY = 0;
  let midPanScrollLeft = 0;
  let midPanScrollTop = 0;
  function onMidMouseDown(e) {
    if (e.button !== 1)
      return;
    e.preventDefault();
    isMidPan = true;
    midPanStartX = e.clientX;
    midPanStartY = e.clientY;
    const scrollEl = ownerDoc().getElementById("kanban-scroll");
    midPanScrollLeft = scrollEl ? scrollEl.scrollLeft : 0;
    const vertEl = boardEl.closest(".view-content") ?? ownerDoc().documentElement;
    midPanScrollTop = vertEl.scrollTop;
    ownerDoc().body.style.cursor = "grabbing";
    ownerDoc().addEventListener("mousemove", onMidMouseMove);
    ownerDoc().addEventListener("mouseup", onMidMouseUp);
  }
  function onMidMouseMove(e) {
    if (!isMidPan)
      return;
    const scrollEl = ownerDoc().getElementById("kanban-scroll");
    if (scrollEl)
      scrollEl.scrollLeft = midPanScrollLeft - (e.clientX - midPanStartX);
    const vertEl = boardEl.closest(".view-content") ?? ownerDoc().documentElement;
    vertEl.scrollTop = midPanScrollTop - (e.clientY - midPanStartY);
  }
  function onMidMouseUp(e) {
    if (e.button !== 1)
      return;
    isMidPan = false;
    ownerDoc().body.style.cursor = "";
    ownerDoc().removeEventListener("mousemove", onMidMouseMove);
    ownerDoc().removeEventListener("mouseup", onMidMouseUp);
  }
  function onTabClick(e) {
    if (selectedCard)
      return;
    const tab = e.target.closest("button[data-col-norm]");
    if (!tab)
      return;
    const wrapper = ownerDoc().getElementById("kanban-wrapper");
    if (wrapper)
      wrapper.dataset.activeCol = tab.dataset.colNorm;
    refresh();
  }
  async function onAddClick(e) {
    const btn = e.target.closest("button[data-column]");
    if (!btn)
      return;
    if (btn.dataset.column === config.normDone)
      return;
    const tag = btn.dataset.tag;
    const norm = btn.dataset.column;
    const title = `Add to ${tag.replace(/^#/, "").toUpperCase()} Column`;
    const isProject = config.normProject.includes(norm);
    if (norm === config.normLater) {
      const defDate = getDefaultDate().toISOString().split("T")[0];
      showDateDialog(title, defDate, async (dateStr, text, createDoc, notes) => {
        if (text && await addNewItem(app, config.newTaskInsert, tag, text, dateStr, config, !!createDoc, notes))
          requestAnimationFrame(() => setTimeout(refresh, 50));
      }, { withText: true, defaultCreateDoc: isProject });
    } else if (config.normRecurrent && norm === config.normRecurrent) {
      showInputDialog(title, isProject, (text, createDoc, notes) => {
        showRecurrentTriggerDialog(async (triggerStr) => {
          const n = new Date();
          const skipStr = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
          const triggerPart = triggerStr ? ` ${triggerStr}` : "";
          const annotated = `${text} @${config.normRecurrent}${triggerPart} %% @skip:${skipStr} %%`;
          if (await addNewItem(app, config.newTaskInsert, tag, annotated, null, config, createDoc, notes))
            requestAnimationFrame(() => setTimeout(refresh, 50));
        });
      });
    } else {
      showInputDialog(title, isProject, async (text, createDoc, notes) => {
        if (await addNewItem(app, config.newTaskInsert, tag, text, null, config, createDoc, notes))
          requestAnimationFrame(() => setTimeout(refresh, 50));
      });
    }
  }
  async function onArchiveClick(e) {
    const btn = e.target.closest("button[data-column]");
    if (!btn || btn.dataset.column !== config.normDone)
      return;
    const zone = btn.closest("[data-col-container]")?.querySelector(".drop-zone");
    if (!zone)
      return;
    const cards = Array.from(zone.querySelectorAll(".kanban-card")).sort((a, b) => parseInt(b.dataset.line, 10) - parseInt(a.dataset.line, 10));
    let count = 0;
    let opened = 0;
    for (const card of cards) {
      let subs = [];
      try {
        subs = JSON.parse(card.dataset.subs || "[]");
      } catch {
      }
      const alreadyOpen = card.dataset.state === "expanded";
      if (hasUnchecked(subs) && !alreadyOpen) {
        await updateFileOrderComment(
          app,
          card.dataset.file,
          parseInt(card.dataset.line, 10),
          card.dataset.digits || "00000",
          "expanded"
        );
        card.dataset.state = "expanded";
        card.querySelector("details")?.setAttribute("open", "");
        opened++;
        continue;
      }
      const ok = await archiveToSection(
        app,
        card.dataset.file,
        parseInt(card.dataset.line, 10),
        subs,
        config,
        card.dataset.isPromoted !== "true"
      );
      if (ok)
        count++;
    }
    if (count || opened) {
      const parts = [];
      if (count)
        parts.push(`Archived ${count} item${count === 1 ? "" : "s"}.`);
      if (opened)
        parts.push(`Opened ${opened} card${opened === 1 ? "" : "s"} with open subtasks.`);
      new import_obsidian.Notice(parts.join(" "));
      requestAnimationFrame(() => setTimeout(refresh, 50));
    }
  }
  function onObsidianLinkClick(e) {
    const anchor = e.target.closest("a");
    if (!anchor)
      return;
    const href = anchor.getAttribute("href") ?? "";
    if (!href.startsWith("obsidian://open"))
      return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const url = new URL(href);
      const file = url.searchParams.get("file") ?? "";
      const section = url.searchParams.get("section") ?? "";
      const linktext = (section ? `${file}#${section}` : file).replace(/\.md$/, "");
      let mainLeaf = null;
      app.workspace.iterateRootLeaves((leaf) => {
        if (!mainLeaf)
          mainLeaf = leaf;
      });
      if (mainLeaf)
        app.workspace.setActiveLeaf(mainLeaf, { focus: true });
      app.workspace.openLinkText(linktext, "", false);
    } catch {
    }
  }
  boardEl.addEventListener("click", onObsidianLinkClick, true);
  boardEl.addEventListener("mousedown", onMouseDown);
  boardEl.addEventListener("mousedown", onMidMouseDown);
  boardEl.addEventListener("mouseover", onMouseOver);
  boardEl.addEventListener("mouseout", onMouseOut);
  boardEl.addEventListener("click", onSubCheckClick);
  boardEl.addEventListener("click", onDateLabelClick);
  boardEl.addEventListener("click", onTriggerLabelClick);
  boardEl.addEventListener("click", onCardClick);
  boardEl.addEventListener("click", onAddSubClick);
  boardEl.addEventListener("click", onPromoteClick);
  boardEl.addEventListener("click", onDemoteClick);
  boardEl.addEventListener("click", onTabClick);
  boardEl.addEventListener("click", onAddClick);
  boardEl.addEventListener("click", onArchiveClick);
  boardEl.addEventListener("dblclick", onDblClick);
  boardEl.addEventListener("dblclick", onSubDblClick);
  boardEl.addEventListener("toggle", onToggle, true);
  boardEl.addEventListener("touchstart", onTouchStart, { passive: true });
  boardEl.addEventListener("touchmove", onTouchMove, { passive: false });
  boardEl.addEventListener("touchend", onTouchEnd, { passive: false });
  boardEl.addEventListener("touchcancel", clearTouch, { passive: true });
  return () => {
    boardEl.removeEventListener("click", onObsidianLinkClick, true);
    boardEl.removeEventListener("mousedown", onMouseDown);
    boardEl.removeEventListener("mousedown", onMidMouseDown);
    ownerDoc().removeEventListener("mousemove", onMouseMove);
    ownerDoc().removeEventListener("mouseup", onMouseUp);
    ownerDoc().removeEventListener("mousemove", onMidMouseMove);
    ownerDoc().removeEventListener("mouseup", onMidMouseUp);
    boardEl.removeEventListener("mouseover", onMouseOver);
    boardEl.removeEventListener("mouseout", onMouseOut);
    boardEl.removeEventListener("click", onSubCheckClick);
    boardEl.removeEventListener("click", onDateLabelClick);
    boardEl.removeEventListener("click", onTriggerLabelClick);
    boardEl.removeEventListener("click", onCardClick);
    boardEl.removeEventListener("click", onAddSubClick);
    boardEl.removeEventListener("click", onPromoteClick);
    boardEl.removeEventListener("click", onDemoteClick);
    boardEl.removeEventListener("click", onTabClick);
    boardEl.removeEventListener("click", onAddClick);
    boardEl.removeEventListener("click", onArchiveClick);
    boardEl.removeEventListener("dblclick", onDblClick);
    boardEl.removeEventListener("dblclick", onSubDblClick);
    boardEl.removeEventListener("toggle", onToggle, true);
    boardEl.removeEventListener("touchstart", onTouchStart);
    boardEl.removeEventListener("touchmove", onTouchMove);
    boardEl.removeEventListener("touchend", onTouchEnd);
    boardEl.removeEventListener("touchcancel", clearTouch);
  };
}

// src/KanbanView.ts
var VIEW_TYPE_KANBAN = "kanban-board-view";
var KanbanView = class extends import_obsidian2.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.isRefreshing = false;
    this.debounceTimer = null;
    this.midnightTimer = null;
    this.listenerCleanup = null;
    this.resizeObserver = null;
    this.resizeDebounceTimer = null;
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_KANBAN;
  }
  getDisplayText() {
    return "Kanban Board";
  }
  getIcon() {
    return "layout-kanban";
  }
  async onOpen() {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf === this.leaf)
          this.scheduleRefresh(100);
      })
    );
    this.scheduleMidnightRefresh();
    this.resizeObserver = new ResizeObserver(() => this.scheduleResizeCheck());
    this.resizeObserver.observe(this.contentEl);
    await this.renderBoard();
  }
  async onClose() {
    if (this.debounceTimer)
      clearTimeout(this.debounceTimer);
    if (this.midnightTimer)
      clearTimeout(this.midnightTimer);
    if (this.resizeDebounceTimer)
      clearTimeout(this.resizeDebounceTimer);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.listenerCleanup?.();
  }
  // Called from action handlers (promote, demote, archive, drop) to force an immediate re-render.
  async refresh() {
    await this.renderBoard();
  }
  scheduleMidnightRefresh() {
    if (this.midnightTimer)
      clearTimeout(this.midnightTimer);
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    this.midnightTimer = setTimeout(() => {
      this.renderBoard();
      this.scheduleMidnightRefresh();
    }, next.getTime() - now.getTime());
  }
  scheduleRefresh(delay) {
    if (this.isRefreshing)
      return;
    if (this.debounceTimer)
      clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.renderBoard(), delay);
  }
  // Debounce resize events, then re-render only if single/multi column mode actually needs to change
  scheduleResizeCheck() {
    if (this.resizeDebounceTimer)
      clearTimeout(this.resizeDebounceTimer);
    this.resizeDebounceTimer = setTimeout(() => {
      const wrapper = this.contentEl.querySelector("#kanban-wrapper");
      if (!wrapper)
        return;
      const width = wrapper.clientWidth > 0 ? wrapper.clientWidth : this.contentEl.clientWidth;
      const shouldBeNarrow = isNarrowLayout(width);
      const isCurrentlyNarrow = wrapper.dataset.narrow === "1";
      if (shouldBeNarrow !== isCurrentlyNarrow)
        this.scheduleRefresh(0);
    }, 150);
  }
  async renderBoard() {
    if (this.isRefreshing)
      return;
    this.isRefreshing = true;
    const container = this.contentEl;
    const oldScroll = container.querySelector("#kanban-scroll");
    const scrollLeft = oldScroll?.scrollLeft ?? 0;
    const savedActiveCol = container.querySelector("#kanban-wrapper")?.dataset.activeCol ?? null;
    this.listenerCleanup?.();
    this.listenerCleanup = null;
    container.empty();
    try {
      const error = validateConfig(this.plugin.settings);
      if (error) {
        this.renderError(container, error);
        return;
      }
      const config = buildConfig(this.plugin.settings);
      await buildBoard(this.app, container, config, savedActiveCol);
      const boardEl = container.querySelector("#kanban-wrapper");
      if (boardEl) {
        this.listenerCleanup = attachListeners(
          boardEl,
          config,
          this.app,
          () => this.renderBoard()
        );
      }
      const newScroll = container.querySelector("#kanban-scroll");
      if (newScroll && scrollLeft)
        newScroll.scrollLeft = scrollLeft;
    } catch (e) {
      console.error("Kanban render error:", e);
      this.renderError(container, e.message ?? String(e));
    } finally {
      this.isRefreshing = false;
    }
  }
  renderError(container, message) {
    container.createEl("h3", { text: "Kanban Configuration Error" });
    container.createEl("p", { text: message });
    container.createEl("p", {
      text: "Open Settings \u2192 Kanban Board to configure the plugin."
    });
    container.createEl("pre", {
      text: `Example settings:
  Kanban columns: #todo, #inprogress, #later, #done
  Done column:    #done
  Default column: #todo
  Later column:   #later
  New task insert: Tasks`
    });
  }
};

// src/main.ts
var DEFAULT_SETTINGS = {
  kanban: ["#todo", "#inprogress", "#today", "#later", "#due", "#done", "#recurrent"],
  doneColumn: "#done",
  startColumn: "#today",
  dueColumn: "#due",
  laterColumn: "#later",
  recurrentColumn: "#recurrent",
  newTaskInsert: "Tasks",
  parentPages: [],
  allVaultNotes: true,
  allChildrenDoneColor: "#e03e3e",
  projectColumns: [],
  activeColumns: ["#next", "#important", "#today"],
  projectsDocument: "",
  columnColors: [],
  columnMaxCards: [],
  colorColumnOverLimit: "#5c1a1a",
  colorCardBg: "",
  colorColumnBg: "",
  colorText: "",
  colorAccent: "",
  colorLink: "",
  colorFamilySelf: "#e03e3e",
  colorFamilyParent: "#2db55d",
  colorFamilySibling: "#4a90d9",
  colorDate: "",
  fontDate: "",
  colorBold: "",
  colorItalicStar: "",
  colorItalicUnderscore: ""
};
var KanbanPlugin = class extends import_obsidian3.Plugin {
  constructor() {
    super(...arguments);
    this.usingDesktopFallback = false;
  }
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE_KANBAN, (leaf) => new KanbanView(leaf, this));
    this.addRibbonIcon(
      "layout-kanban",
      "Open Kanban Board",
      () => this.activateView()
    );
    this.addCommand({
      id: "open-kanban-board",
      name: "Open Kanban Board",
      callback: () => this.activateView()
    });
    this.addCommand({
      id: "open-kanban-window",
      name: "Open Kanban Board in new window",
      callback: () => this.activateViewInWindow()
    });
    this.registerObsidianProtocolHandler(
      "open-kanban",
      () => this.activateView()
    );
    this.registerObsidianProtocolHandler(
      "open-kanban-window",
      () => this.activateViewInWindow()
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.injectNewTabButton())
    );
    this.app.workspace.onLayoutReady(() => this.injectNewTabButton());
    this.addSettingTab(new KanbanSettingTab(this.app, this));
  }
  injectNewTabButton() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.getViewState().type !== "empty")
        return;
      const container = leaf.view.containerEl.querySelector(".empty-state-container");
      if (!container || container.querySelector(".kanban-new-tab-btn"))
        return;
      const btn = container.createEl("button", {
        text: "Open Kanban Board",
        cls: "empty-state-action kanban-new-tab-btn"
      });
      btn.addEventListener("click", () => this.activateView());
    });
  }
  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_KANBAN);
  }
  async activateViewInWindow() {
    const { workspace } = this.app;
    const rootLeaves = /* @__PURE__ */ new Set();
    workspace.iterateRootLeaves((leaf2) => rootLeaves.add(leaf2));
    const popoutLeaf = workspace.getLeavesOfType(VIEW_TYPE_KANBAN).find((leaf2) => !rootLeaves.has(leaf2));
    if (popoutLeaf) {
      workspace.revealLeaf(popoutLeaf);
      return;
    }
    const leaf = import_obsidian3.Platform.isMobile ? workspace.getLeaf(true) : workspace.openPopoutLeaf();
    await leaf.setViewState({ type: VIEW_TYPE_KANBAN, active: true });
    workspace.revealLeaf(leaf);
  }
  async activateView() {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_KANBAN);
    if (leaves.length > 0) {
      workspace.revealLeaf(leaves[0]);
      return;
    }
    const leaf = workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_KANBAN, active: true });
    workspace.revealLeaf(leaf);
  }
  async loadSettings() {
    let data = await this.loadData();
    this.usingDesktopFallback = false;
    if (!data && import_obsidian3.Platform.isMobile) {
      try {
        const raw = await this.app.vault.adapter.read(".obsidian/plugins/kanban-board/data.json");
        data = JSON.parse(raw);
        this.usingDesktopFallback = true;
      } catch {
      }
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshOpenBoards();
  }
  refreshOpenBoards() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_KANBAN).forEach((leaf) => {
      leaf.view.refresh();
    });
  }
};
var KanbanSettingTab = class extends import_obsidian3.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.ignoreWarning = false;
    this.plugin = plugin;
  }
  // The due column is hidden while empty, so a settings change touching it would
  // otherwise leave it invisible. Drop an explanatory card in it and refresh so the
  // user can immediately see the column (and the note) reflecting the change.
  async touchDueColumn() {
    await addDueColumnExplanationCard(this.app, buildConfig(this.plugin.settings));
    this.plugin.refreshOpenBoards();
  }
  async display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Kanban Board Settings" });
    if (import_obsidian3.Platform.isMobile) {
      const mobilePath = ".obsidian-mobile/plugins/kanban-board/data.json";
      const hasMobileSettings = await this.app.vault.adapter.exists(mobilePath);
      if (!hasMobileSettings && !this.ignoreWarning) {
        if (this.plugin.usingDesktopFallback) {
          containerEl.createEl("p", { text: "Settings are loaded from the desktop app. Please use the desktop app to change parameters." });
          containerEl.createEl("p", { text: "Pressing Ignore will create a separate mobile settings file seeded from the desktop. These settings may diverge over time." });
        } else {
          containerEl.createEl("p", { text: "No settings found on this device. The desktop settings have not synced yet. The Kanban board will not work until they arrive." });
          containerEl.createEl("p", { text: "Wait for iCloud to sync, then restart the app. Alternatively, press Ignore to configure settings manually on this device." });
        }
        new import_obsidian3.Setting(containerEl).addButton((btn) => {
          btn.setButtonText("Ignore");
          btn.buttonEl.addClass("mod-warning");
          btn.onClick(async () => {
            await this.plugin.saveSettings();
            this.ignoreWarning = true;
            this.display();
          });
        });
        return;
      }
      if (hasMobileSettings) {
        new import_obsidian3.Setting(containerEl).setName("Mobile settings").setDesc(
          "This device has its own settings that may differ from the desktop. Deleting them will cause this app to use the desktop settings instead, keeping everything in sync. Restart the app after deleting."
        ).addButton((btn) => {
          btn.setButtonText("Delete mobile settings");
          btn.buttonEl.addClass("mod-warning");
          btn.onClick(async () => {
            await this.app.vault.adapter.remove(mobilePath);
            this.display();
          });
        });
      }
    }
    new import_obsidian3.Setting(containerEl).setName("Kanban columns").setDesc("Comma-separated column tags, in display order (e.g. #todo, #inprogress, #later, #done)").addText(
      (text) => text.setPlaceholder("#todo, #inprogress, #later, #done").setValue(this.plugin.settings.kanban.join(", ")).onChange(async (value) => {
        this.plugin.settings.kanban = value.split(",").map((t) => t.trim()).filter(Boolean);
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Done column").setDesc("Tag for the done column \u2014 tasks moved here get their checkbox checked").addText(
      (text) => text.setPlaceholder("#done").setValue(this.plugin.settings.doneColumn).onChange(async (value) => {
        this.plugin.settings.doneColumn = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Start column in single row view").setDesc("Tag for the column shown by default when the board is displayed as a single column (narrow/mobile view)").addText(
      (text) => text.setPlaceholder("#today").setValue(this.plugin.settings.startColumn).onChange(async (value) => {
        this.plugin.settings.startColumn = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Target column for due later and recurrent tasks").setDesc(
      "Tag for the column where past-due/undated #later tasks and triggered #recurrent tasks are moved to (e.g. #due). This column is hidden whenever it has no cards, and reappears automatically once the board moves a card into it."
    ).addText(
      (text) => text.setPlaceholder("#due").setValue(this.plugin.settings.dueColumn).onChange(async (value) => {
        this.plugin.settings.dueColumn = value.trim();
        await this.plugin.saveSettings();
        await this.touchDueColumn();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Later column").setDesc("Tag for the scheduled / later column \u2014 shows a date picker on drop").addText(
      (text) => text.setPlaceholder("#later").setValue(this.plugin.settings.laterColumn).onChange(async (value) => {
        this.plugin.settings.laterColumn = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Recurrent column").setDesc("Tag for the recurrent column. Cards with a matching @annotation and no other kanban tag are automatically placed here. Must be included in 'Kanban columns'.").addText(
      (text) => text.setPlaceholder("#recurrent").setValue(this.plugin.settings.recurrentColumn).onChange(async (value) => {
        this.plugin.settings.recurrentColumn = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Project columns").setDesc(
      "Comma-separated tags for columns where adding a new card automatically offers to create a linked Obsidian note. When a card is added in one of these columns, the 'Create new document' checkbox in the add dialog is pre-checked. The new note is created in the vault root and the card text becomes a wiki link [[Note Title]] pointing to it."
    ).addText(
      (text) => text.setPlaceholder("#todo, #inprogress").setValue((this.plugin.settings.projectColumns || []).join(", ")).onChange(async (value) => {
        this.plugin.settings.projectColumns = value.split(",").map((t) => t.trim()).filter(Boolean);
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Active columns").setDesc(
      "Comma-separated tags for columns considered 'active' work. A project card is highlighted as unmanaged work only when none of its sub-tasks are in one of these columns, and not all of its sub-tasks are in the Later or Recurrent columns."
    ).addText(
      (text) => text.setPlaceholder("#next, #important, #today").setValue((this.plugin.settings.activeColumns || []).join(", ")).onChange(async (value) => {
        this.plugin.settings.activeColumns = value.split(",").map((t) => t.trim()).filter(Boolean);
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Project master document").setDesc(
      "Note where [[Project name]] links are collected when adding a card with 'Create new document' checked. Each new project link is prepended here (newest on top). Leave blank to disable."
    ).addText(
      (text) => text.setPlaceholder("Projects").setValue(this.plugin.settings.projectsDocument).onChange(async (value) => {
        this.plugin.settings.projectsDocument = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("New task insert document").setDesc(
      'Note (and optional heading) where the + button inserts new tasks, e.g. "Tasks" or "Tasks#Inbox"'
    ).addText(
      (text) => text.setPlaceholder("Tasks").setValue(this.plugin.settings.newTaskInsert).onChange(async (value) => {
        this.plugin.settings.newTaskInsert = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Scan all vault notes").setDesc(
      "When enabled, every note in the vault is scanned for kanban-tagged tasks. When disabled, only notes linked from Parent pages are scanned."
    ).addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.allVaultNotes).onChange(async (value) => {
        this.plugin.settings.allVaultNotes = value;
        await this.plugin.saveSettings();
        this.display();
      })
    );
    if (!this.plugin.settings.allVaultNotes) {
      new import_obsidian3.Setting(containerEl).setName("Parent pages").setDesc(
        "Comma-separated note names. Tasks are collected from these notes and all notes they link to."
      ).addText(
        (text) => text.setPlaceholder("Dashboard, Projects").setValue(this.plugin.settings.parentPages.join(", ")).onChange(async (value) => {
          this.plugin.settings.parentPages = value.split(",").map((t) => t.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        })
      );
    }
    containerEl.createEl("h3", { text: "Colors" });
    containerEl.createEl("p", {
      text: "Theme-override fields show a \u21BA button to revert to the Obsidian theme default.",
      attr: { style: "color:var(--text-muted);font-size:.85em;margin-top:-6px;" }
    });
    const themeColor = (name, desc, get, set, fallback) => {
      new import_obsidian3.Setting(containerEl).setName(name).setDesc(desc + (get() ? "" : " (using theme default)")).addColorPicker(
        (cp) => cp.setValue(get() || fallback).onChange(async (value) => {
          set(value);
          await this.plugin.saveSettings();
        })
      ).addExtraButton(
        (btn) => btn.setIcon("rotate-ccw").setTooltip("Reset to theme default").onClick(async () => {
          set("");
          await this.plugin.saveSettings();
          this.display();
        })
      );
    };
    const fixedColor = (name, desc, get, set) => {
      new import_obsidian3.Setting(containerEl).setName(name).setDesc(desc).addColorPicker(
        (cp) => cp.setValue(get()).onChange(async (value) => {
          set(value);
          await this.plugin.saveSettings();
        })
      );
    };
    themeColor(
      "Card background",
      "Background color of each card.",
      () => this.plugin.settings.colorCardBg,
      (v) => {
        this.plugin.settings.colorCardBg = v;
      },
      "#1e1e1e"
    );
    themeColor(
      "Column background",
      "Default background for columns without a per-column color.",
      () => this.plugin.settings.colorColumnBg,
      (v) => {
        this.plugin.settings.colorColumnBg = v;
      },
      "#1e1e1e"
    );
    themeColor(
      "Font color",
      "Text color for cards, column headers, and tabs.",
      () => this.plugin.settings.colorText,
      (v) => {
        this.plugin.settings.colorText = v;
      },
      "#ffffff"
    );
    themeColor(
      "Bold color (**text**)",
      "Color for card title text wrapped in **double asterisks**. Default: slightly darker than card text.",
      () => this.plugin.settings.colorBold,
      (v) => {
        this.plugin.settings.colorBold = v;
      },
      "#b3b3b3"
    );
    themeColor(
      "Italic color (*text*)",
      "Color for card title text wrapped in single *asterisks*. Default: slightly lighter than card text.",
      () => this.plugin.settings.colorItalicStar,
      (v) => {
        this.plugin.settings.colorItalicStar = v;
      },
      "#eeeeee"
    );
    themeColor(
      "Italic color (_text_)",
      "Color for card title text wrapped in _underscores_. Default: teal-shifted card text.",
      () => this.plugin.settings.colorItalicUnderscore,
      (v) => {
        this.plugin.settings.colorItalicUnderscore = v;
      },
      "#4d9e99"
    );
    themeColor(
      "Accent / symbol color",
      "Color for \u25B6 promote, \u25B2/\u25BC expand, active column tab, and drag highlight.",
      () => this.plugin.settings.colorAccent,
      (v) => {
        this.plugin.settings.colorAccent = v;
      },
      "#7f6df2"
    );
    themeColor(
      "Link color",
      "Color for wiki links and URL badges on cards.",
      () => this.plugin.settings.colorLink,
      (v) => {
        this.plugin.settings.colorLink = v;
      },
      "#7f6df2"
    );
    themeColor(
      "Date color",
      "Color for date annotations on cards (e.g. 'Jun 24', 'next Mon').",
      () => this.plugin.settings.colorDate,
      (v) => {
        this.plugin.settings.colorDate = v;
      },
      "#7ab8e8"
    );
    new import_obsidian3.Setting(containerEl).setName("Date font").setDesc("Font family for date annotations. Default: monospace.").addText(
      (t) => t.setPlaceholder("monospace").setValue(this.plugin.settings.fontDate || "").onChange(async (v) => {
        this.plugin.settings.fontDate = v;
        await this.plugin.saveSettings();
      })
    );
    fixedColor(
      "Family highlight \u2014 self",
      "Outline color for the hovered card in family highlight mode.",
      () => this.plugin.settings.colorFamilySelf,
      (v) => {
        this.plugin.settings.colorFamilySelf = v;
      }
    );
    fixedColor(
      "Family highlight \u2014 parent",
      "Outline color for the parent card in family highlight mode.",
      () => this.plugin.settings.colorFamilyParent,
      (v) => {
        this.plugin.settings.colorFamilyParent = v;
      }
    );
    fixedColor(
      "Family highlight \u2014 siblings",
      "Outline color for sibling cards in family highlight mode.",
      () => this.plugin.settings.colorFamilySibling,
      (v) => {
        this.plugin.settings.colorFamilySibling = v;
      }
    );
    fixedColor(
      "Unmanaged work \u2014 highlight",
      "Border color for cards that have unchecked sub-tasks not tracked as kanban cards.",
      () => this.plugin.settings.allChildrenDoneColor,
      (v) => {
        this.plugin.settings.allChildrenDoneColor = v;
      }
    );
    fixedColor(
      "Column over-limit warning",
      "Background color for a column that has more cards than its configured maximum. Shared by all columns.",
      () => this.plugin.settings.colorColumnOverLimit,
      (v) => {
        this.plugin.settings.colorColumnOverLimit = v;
      }
    );
    containerEl.createEl("h4", { text: "Per-column settings" });
    containerEl.createEl("p", {
      text: 'For each column: a background color (\u21BA removes the custom color) and an optional max card count. When a column exceeds its max, it turns the warning color above. Toggle "No limit" to disable the cap.',
      attr: { style: "color:var(--text-muted);font-size:.85em;margin-top:-6px;" }
    });
    this.plugin.settings.kanban.forEach((tag, i) => {
      const currentColor = (this.plugin.settings.columnColors || [])[i] || "";
      const currentMax = (this.plugin.settings.columnMaxCards || [])[i] || 0;
      const isDueColumn = normalizeTag(tag) === normalizeTag(this.plugin.settings.dueColumn);
      let numberInputEl;
      const settingGroup = containerEl.createDiv({ cls: "setting-group" });
      const settingItems = settingGroup.createDiv({ cls: "setting-items" });
      new import_obsidian3.Setting(settingItems).setName(tag.replace(/^#/, "").toUpperCase()).addColorPicker(
        (cp) => cp.setValue(currentColor || "#1e1e1e").onChange(async (value) => {
          if (!this.plugin.settings.columnColors)
            this.plugin.settings.columnColors = [];
          this.plugin.settings.columnColors[i] = value;
          await this.plugin.saveSettings();
          if (isDueColumn)
            await this.touchDueColumn();
        })
      ).addExtraButton(
        (btn) => btn.setIcon("rotate-ccw").setTooltip("Remove custom color").onClick(async () => {
          if (!this.plugin.settings.columnColors)
            this.plugin.settings.columnColors = [];
          this.plugin.settings.columnColors[i] = "";
          await this.plugin.saveSettings();
          if (isDueColumn)
            await this.touchDueColumn();
          this.display();
        })
      );
      new import_obsidian3.Setting(settingItems).setName("Max cards").addToggle(
        (toggle) => toggle.setTooltip("No limit").setValue(currentMax === 0).onChange(async (noLimit) => {
          numberInputEl.disabled = noLimit;
          numberInputEl.style.opacity = noLimit ? "0.4" : "1";
          if (!this.plugin.settings.columnMaxCards)
            this.plugin.settings.columnMaxCards = [];
          if (noLimit) {
            this.plugin.settings.columnMaxCards[i] = 0;
          } else {
            const n = parseInt(numberInputEl.value.trim(), 10);
            this.plugin.settings.columnMaxCards[i] = Number.isFinite(n) && n > 0 ? n : 1;
            numberInputEl.value = String(this.plugin.settings.columnMaxCards[i]);
          }
          await this.plugin.saveSettings();
          if (isDueColumn)
            await this.touchDueColumn();
        })
      ).addText((text) => {
        numberInputEl = text.inputEl;
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.style.width = "5em";
        const noLimit = currentMax === 0;
        text.inputEl.disabled = noLimit;
        text.inputEl.style.opacity = noLimit ? "0.4" : "1";
        text.setValue(currentMax > 0 ? String(currentMax) : "").onChange(async (value) => {
          if (!this.plugin.settings.columnMaxCards)
            this.plugin.settings.columnMaxCards = [];
          const n = parseInt(value.trim(), 10);
          this.plugin.settings.columnMaxCards[i] = Number.isFinite(n) && n > 0 ? n : 1;
          await this.plugin.saveSettings();
          if (isDueColumn)
            await this.touchDueColumn();
        });
      });
    });
    new import_obsidian3.Setting(containerEl).setName("Open board").addButton(
      (btn) => btn.setButtonText("Open Kanban Board").onClick(() => {
        this.plugin.activateView();
      })
    );
  }
};
