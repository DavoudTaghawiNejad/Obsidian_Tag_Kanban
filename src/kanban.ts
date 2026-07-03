/**
 * kanban.ts — Core board logic.
 *
 * All Dataview (dv.*) calls have been replaced with native Obsidian API calls:
 *   dv.pages()           → app.vault.getMarkdownFiles()
 *   dv.page(path)        → app.metadataCache.getCache(path)
 *   dv.io.load(path)     → app.vault.read(tFile)
 *   app.vault.read/modify → same (these were already native)
 *   dv.container         → containerEl parameter passed in
 *   new Notice(...)      → same (global in plugin context)
 */

import { App, Notice, TFile, TFolder } from "obsidian";
import { KanbanSettings } from "./main";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

export interface KanbanConfig {
  kanban: string[];
  parentPages: string[];
  allVaultNotes: boolean;
  doneColumn: string;
  todayColumn: string;
  laterColumn: string;
  recurrentColumn: string;
  newTaskInsert: string;
  normKanban: string[];
  normDone: string;
  normToday: string;
  normLater: string;
  normRecurrent: string;
  normProject: string[];
  normActive: string[];
  projectsDocument: string;
  allChildrenDoneColor: string;
  allCheckedColor: string;
  // Colors (empty string → fall back to Obsidian theme variable)
  columnColors: Record<string, string>;
  // Per-column max card count keyed by normalized tag. 0 = no limit.
  columnMaxCards: Record<string, number>;
  // Shared warning background for columns that exceed their max card count.
  colorColumnOverLimit: string;
  colorCardBg: string;
  colorColumnBg: string;
  colorText: string;
  colorAccent: string;
  colorLink: string;
  colorFamilySelf: string;
  colorFamilyParent: string;
  colorFamilySibling: string;
  colorDate: string;
  fontDate: string;
}

export function buildConfig(settings: KanbanSettings): KanbanConfig {
  const normKanban = settings.kanban.map(normalizeTag);
  return {
    kanban: settings.kanban,
    parentPages: settings.parentPages,
    allVaultNotes: settings.allVaultNotes,
    doneColumn: settings.doneColumn,
    todayColumn: settings.todayColumn,
    laterColumn: settings.laterColumn,
    newTaskInsert: settings.newTaskInsert,
    normKanban,
    normDone: normalizeTag(settings.doneColumn),
    normToday: normalizeTag(settings.todayColumn),
    normLater: normalizeTag(settings.laterColumn),
    recurrentColumn: settings.recurrentColumn || "#recurrent",
    normRecurrent: normalizeTag(settings.recurrentColumn || "#recurrent"),
    normProject: (settings.projectColumns || []).map(normalizeTag),
    normActive: (settings.activeColumns && settings.activeColumns.length
      ? settings.activeColumns
      : ["#next", "#important", "#today"]
    ).map(normalizeTag),
    projectsDocument: settings.projectsDocument || "",
    allChildrenDoneColor: settings.allChildrenDoneColor,
    allCheckedColor: settings.allCheckedColor || "#2db55d",
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
  };
}

export function validateConfig(settings: KanbanSettings): string | null {
  const normKanban = settings.kanban.map(normalizeTag);
  const normDone = normalizeTag(settings.doneColumn);
  const normToday = normalizeTag(settings.todayColumn);
  const normLater = normalizeTag(settings.laterColumn);

  if (!settings.kanban.length) return "Missing/empty 'Kanban columns' setting.";
  if (!settings.doneColumn || !normKanban.includes(normDone))
    return "'Done column' must match one of the Kanban columns.";
  if (!settings.todayColumn || !normKanban.includes(normToday))
    return "'Today column' must match one of the Kanban columns.";
  if (!settings.laterColumn || !normKanban.includes(normLater))
    return "'Later column' must match one of the Kanban columns.";
  if (normToday === normLater)
    return "'Today column' and 'Later column' must be different.";
  if (!settings.allVaultNotes && !settings.parentPages.length)
    return "Add at least one 'Parent page', or enable 'Scan all vault notes'.";
  if (!settings.newTaskInsert)
    return "Missing 'New task insert location' — set a note name in settings.";
  return null;
}

// ─── TAG UTILITIES ────────────────────────────────────────────────────────────

const normalizeTag = (tag: string): string =>
  (tag || "").trim().replace(/^#/, "").replace(/_$/, "").toLowerCase();

const matchesKanbanTag = (raw: string, normList: string[]): boolean =>
  normList.includes(normalizeTag(raw));

function extractTags(text: string): string[] {
  const cleaned = text
    .replace(/`[^`]*`/g, "")
    .replace(/["'""][^"'""]*["'""]/g, "");
  return cleaned.match(/(?<!\w)#\w+/g) || [];
}

// ─── ORDER-COMMENT PARSING ────────────────────────────────────────────────────
// Format: %% @<digits><c|x> %%   c = collapsed, x = expanded

interface OrderInfo {
  order: number;
  digits: string;
  state: "expanded" | "collapsed";
  len: number;
}

function parseOrderComment(text: string): OrderInfo | null {
  const m = text.match(/%% @(\d+)(\w) %%/);
  if (!m) return null;
  const stateChar = m[2].toLowerCase();
  const state =
    stateChar === "x" ? "expanded" : stateChar === "c" ? "collapsed" : null;
  if (!state) return null;
  const order = parseFloat("0." + m[1]);
  return order > 0 && order < 1
    ? { order, digits: m[1], state, len: m[1].length }
    : null;
}

// ─── TASK LINE PARSE / SERIALIZE ─────────────────────────────────────────────

interface TaskLine {
  indent: string;
  bullet: string;                              // "-", "*", "+" or ""
  checked: boolean | null;                     // null = no checkbox syntax
  text: string;                                // bare content without tags/date/order
  tags: string[];                              // all #tags in original order
  date: string | null;                         // "@YYYY-MM-DD" or null
  doneDate: string | null;                     // "%% YYYY-MM-DD %%" comment
  orderDigits: string | null;
  orderState: "expanded" | "collapsed" | null;
  skipDate: string | null;                     // "%% @skip:YYYY-MM-DD %%" comment
}

function parseTaskLine(raw: string): TaskLine {
  const indent = (raw.match(/^(\s*)/) || ["", ""])[1];
  let rest = raw.slice(indent.length);

  // Order comment
  let orderDigits: string | null = null;
  let orderState: "expanded" | "collapsed" | null = null;
  const om = rest.match(/%% @(\d+)(\w) %%/);
  if (om) {
    orderDigits = om[1];
    orderState = om[2].toLowerCase() === "x" ? "expanded" : "collapsed";
  }
  // Skip date — preserve across parse/serialize round-trips
  let skipDate: string | null = null;
  const sm = rest.match(/%% @skip:(\d{4}-\d{2}-\d{2}) %%/);
  if (sm) skipDate = sm[1];
  rest = rest.replace(/\s*%%[\s\S]*?%%/g, "").trim();

  // Date annotation (@YYYY-MM-DD)
  let date: string | null = null;
  const dm = rest.match(/(^|\s)(@\d{4}-\d{2}-\d{2})\b/);
  if (dm) date = dm[2];
  rest = rest.replace(/\s*(?:^|\s)@\d{4}-\d{2}-\d{2}\b/g, "").trim();

  // Done date (✅YYYY-MM-DD)
  let doneDate: string | null = null;
  const ddm = rest.match(/✅(\d{4}-\d{2}-\d{2})/);
  if (ddm) doneDate = ddm[1];
  rest = rest.replace(/\s*✅\d{4}-\d{2}-\d{2}/, "").trim();

  // Bullet + optional checkbox
  let bullet = "";
  let checked: boolean | null = null;
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

  const tags = (rest.match(/(?<!\w)#\w+/g) || []);
  const text = rest.replace(/\s*(?<!\w)#\w+/g, "").trim();

  return { indent, bullet, checked, text, tags, date, doneDate, orderDigits, orderState, skipDate };
}

function serializeTaskLine(t: TaskLine): string {
  const parts: string[] = [];

  if (t.bullet) {
    parts.push(t.checked !== null ? `${t.bullet} [${t.checked ? "x" : " "}]` : t.bullet);
  }
  if (t.text) parts.push(t.text);
  parts.push(...t.tags);
  if (t.date) parts.push(t.date);
  if (t.doneDate) parts.push(`✅${t.doneDate}`);
  if (t.orderDigits && t.orderState !== null) {
    parts.push(`%% @${t.orderDigits}${t.orderState === "expanded" ? "x" : "c"} %%`);
  }
  if (t.skipDate) {
    parts.push(`%% @skip:${t.skipDate} %%`);
  }

  return t.indent + parts.join(" ");
}

async function updateFileOrderComment(
  app: App,
  filePath: string,
  lineNum: number,
  newDigits: string | null,
  newState: "expanded" | "collapsed" | null = null
): Promise<boolean> {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    if (lineNum < 1 || lineNum > lines.length) return false;

    const parsed = parseTaskLine(lines[lineNum - 1]);
    const digits = newDigits ?? parsed.orderDigits;
    if (!digits) return false;

    const state: "expanded" | "collapsed" = newState ?? parsed.orderState ?? "collapsed";

    // Skip write if already correct — avoids triggering a vault.modify refresh loop.
    if (parsed.orderDigits === digits && parsed.orderState === state) return true;

    parsed.orderDigits = digits;
    parsed.orderState = state;
    lines[lineNum - 1] = serializeTaskLine(parsed);
    await app.vault.modify(tFile, lines.join("\n"));
    return true;
  } catch (e: any) {
    console.error("updateFileOrderComment failed:", e);
    return false;
  }
}

// ─── ORDER ARITHMETIC (BigInt midpoints) ─────────────────────────────────────

interface SiblingData {
  order: number;
  digits: string;
  len: number;
}

function calcMidDigits(prev: SiblingData, next: SiblingData | null, isEnd: boolean) {
  const l = Math.max(prev.len || 1, next?.len || 1);
  const a = BigInt(prev.digits.padEnd(l, "0"));
  const b = isEnd
    ? 10n ** BigInt(l)
    : BigInt((next!.digits || "0").padEnd(l, "0"));
  const sum = a + b;
  const mid = sum / 2n;
  if (sum % 2n === 0n) {
    return {
      order: parseFloat("0." + mid.toString().padStart(l, "0")),
      digits: mid.toString().padStart(l, "0"),
      len: l,
    };
  }
  const digs = (mid * 10n + 5n).toString().padStart(l + 1, "0");
  return { order: parseFloat("0." + digs), digits: digs, len: l + 1 };
}

function calcInsertOrder(
  siblingData: SiblingData[],
  insertIndex: number,
  isMulti = false
) {
  const n = siblingData.length;
  if (insertIndex === 0 || isMulti) {
    return n === 0
      ? { order: 0.5, digits: "5", len: 1 }
      : calcMidDigits({ digits: "0", len: 1, order: 0 }, siblingData[0], false);
  }
  if (insertIndex >= n) return calcMidDigits(siblingData[n - 1], null, true);
  return calcMidDigits(siblingData[insertIndex - 1], siblingData[insertIndex], false);
}

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────

function parseCardDate(text: string): Date | null {
  const m = text.match(/@(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const d = new Date(m[1] + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}

// ─── RECURRENT TRIGGER HELPERS ───────────────────────────────────────────────

const TRIGGER_WEEKDAYS_SHORT = ['sun','mon','tue','wed','thu','fri','sat'];
const TRIGGER_WEEKDAYS_FULL  = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const TRIGGER_MONTHS_SHORT   = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const TRIGGER_MONTHS_FULL    = ['january','february','march','april','may','june','july','august','september','october','november','december'];

function hasRecurrentAnnotation(text: string, normRecurrent: string): boolean {
  return new RegExp(`@${normRecurrent}\\b`, 'i').test(text);
}

// Extracts @word and @1-2-digit-number annotations, skipping @YYYY-MM-DD and @recurrent itself.
// Supports underscores in words (e.g. @last_day).
function extractTriggerAnnotations(text: string, normRecurrent: string): string[] {
  const matches = text.match(/@([a-zA-Z][a-zA-Z_]*(?:[+-]\d+)?|\d{1,2})\b/g) || [];
  return matches
    .map((m: string) => m.slice(1).toLowerCase())
    .filter((m: string) => m !== normRecurrent);
}

function lastDayOfMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function matchesTriggerAnnotations(triggers: string[], today: Date): boolean {
  if (!triggers.length) return false;
  const todayWeekday = today.getDay();
  const todayDate    = today.getDate();
  const todayMonth   = today.getMonth();
  const lastDay      = lastDayOfMonth(today);

  for (const t of triggers) {
    if (t === 'last_day') { if (todayDate === lastDay) return true; continue; }
    if (t === 'quarterly' || t === 'q+1') { if (todayDate === 1 && [0, 3, 6, 9].includes(todayMonth)) return true; continue; }
    if (t === 'quarterly+2' || t === 'q+2') { if (todayDate === 1 && [1, 4, 7, 10].includes(todayMonth)) return true; continue; }
    if (t === 'quarterly+3' || t === 'q+3') { if (todayDate === 1 && [2, 5, 8, 11].includes(todayMonth)) return true; continue; }

    const wdShort = TRIGGER_WEEKDAYS_SHORT.indexOf(t);
    if (wdShort !== -1) { if (wdShort === todayWeekday) return true; continue; }

    const wdFull = TRIGGER_WEEKDAYS_FULL.indexOf(t);
    if (wdFull !== -1) { if (wdFull === todayWeekday) return true; continue; }

    const mShort = TRIGGER_MONTHS_SHORT.indexOf(t);
    if (mShort !== -1) { if (mShort === todayMonth && todayDate === 1) return true; continue; }

    const mFull = TRIGGER_MONTHS_FULL.indexOf(t);
    if (mFull !== -1) { if (mFull === todayMonth && todayDate === 1) return true; continue; }

    // Day-of-month: clamp to last day of month when the day doesn't exist this month
    if (/^\d{1,2}$/.test(t)) {
      const dayNum = parseInt(t, 10);
      if (dayNum >= 1 && dayNum <= 31) {
        const effectiveDay = Math.min(dayNum, lastDay);
        if (effectiveDay === todayDate) return true;
      }
    }
  }
  return false;
}

function isValidTriggerToken(t: string): boolean {
  if (t === 'last_day') return true;
  if (t === 'quarterly' || t === 'quarterly+2' || t === 'quarterly+3' || t === 'q+1' || t === 'q+2' || t === 'q+3') return true;
  return TRIGGER_WEEKDAYS_SHORT.includes(t) ||
    TRIGGER_WEEKDAYS_FULL.includes(t) ||
    TRIGGER_MONTHS_SHORT.includes(t) ||
    TRIGGER_MONTHS_FULL.includes(t) ||
    (/^\d{1,2}$/.test(t) && parseInt(t, 10) >= 1 && parseInt(t, 10) <= 31);
}

function hasValidTriggers(text: string, normRecurrent: string): boolean {
  return extractTriggerAnnotations(text, normRecurrent).some(isValidTriggerToken);
}

function extractSkipDate(rawLine: string): string | null {
  const m = rawLine.match(/%% @skip:(\d{4}-\d{2}-\d{2}) %%/);
  return m ? m[1] : null;
}

function setSkipDate(line: string, dateStr: string): string {
  const cleaned = line.replace(/\s*%% @skip:\d{4}-\d{2}-\d{2} %%/g, "").trimEnd();
  return `${cleaned} %% @skip:${dateStr} %%`;
}

async function addTagAndSkipDate(app: App, filePath: string, lineNum: number, tag: string, dateStr: string): Promise<void> {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    const idx = lineNum - 1;
    if (idx < 0 || idx >= lines.length) return;
    const parsed = parseTaskLine(lines[idx]);
    if (!parsed.tags.includes(tag)) parsed.tags.push(tag);
    lines[idx] = serializeTaskLine(parsed);
    lines[idx] = setSkipDate(lines[idx], dateStr);
    await writeFileLines(app, tFile, lines);
  } catch { /* ignore */ }
}

async function addTagAndClearDate(app: App, filePath: string, lineNum: number, tag: string): Promise<void> {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    const idx = lineNum - 1;
    if (idx < 0 || idx >= lines.length) return;
    const parsed = parseTaskLine(lines[idx]);
    if (!parsed.tags.includes(tag)) parsed.tags.push(tag);
    parsed.date = null;
    lines[idx] = serializeTaskLine(parsed);
    await writeFileLines(app, tFile, lines);
  } catch { /* ignore */ }
}

// Adds #today and removes the date from every subtask of a #later card whose @YYYY-MM-DD has arrived.
async function triggerDatedLaterSubs(
  app: App, subs: any[], filePath: string, config: KanbanConfig, today: Date
): Promise<boolean> {
  if (!subs || !subs.length) return false;
  let changed = false;
  for (const sub of subs) {
    if (!sub.tags.some((t: string) => config.normKanban.includes(normalizeTag(t)))) {
      const d = parseCardDate(sub.text);
      if (d && d <= today) {
        await addTagAndClearDate(app, filePath, sub.line, config.todayColumn);
        changed = true;
      }
    }
    if (sub.subs?.length)
      if (await triggerDatedLaterSubs(app, sub.subs, filePath, config, today)) changed = true;
  }
  return changed;
}

// Adds #today + skip date to every untriggered subtask whose @recurrent trigger fires today.
async function triggerRecurrentSubs(
  app: App, subs: any[], filePath: string, config: KanbanConfig, today: Date, todayStr: string
): Promise<boolean> {
  if (!subs || !subs.length) return false;
  let changed = false;
  for (const sub of subs) {
    if (!sub.tags.some((t: string) => config.normKanban.includes(normalizeTag(t)))) {
      if (
        hasRecurrentAnnotation(sub.text, config.normRecurrent) &&
        matchesTriggerAnnotations(extractTriggerAnnotations(sub.text, config.normRecurrent), today) &&
        extractSkipDate(sub.text) !== todayStr
      ) {
        await addTagAndSkipDate(app, filePath, sub.line, config.todayColumn, todayStr);
        changed = true;
      }
    }
    if (sub.subs?.length)
      if (await triggerRecurrentSubs(app, sub.subs, filePath, config, today, todayStr)) changed = true;
  }
  return changed;
}

function hasDatedSub(subs: any[]): boolean {
  if (!subs?.length) return false;
  for (const sub of subs) {
    if (parseCardDate(sub.text)) return true;
    if (hasDatedSub(sub.subs)) return true;
  }
  return false;
}

// For #later: full-date ≤ today, OR trigger fires, OR undated+untriggered (move to today).
function isLaterDueToday(text: string, today: Date, normRecurrent: string): boolean {
  const d = parseCardDate(text);
  if (d) return d <= today;
  const triggers = extractTriggerAnnotations(text, normRecurrent).filter(isValidTriggerToken);
  if (triggers.length) return matchesTriggerAnnotations(triggers, today);
  return true;
}


function getNextMonday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const diff = (8 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d;
}

function getTomorrow(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d;
}

function getNextWeekend(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const diff = (6 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d;
}

function getNextMonth(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setMonth(d.getMonth() + 1);
  return d;
}

const DATE_PRESETS: [key: string, label: string, fn: () => Date][] = [
  ["tomorrow", "Tomorrow", getTomorrow],
  ["weekend", "Next weekend", getNextWeekend],
  ["monday", "Next monday", getNextMonday],
  ["month", "Next month", getNextMonth],
];

function getDefaultDate(existing: Date | null = null): Date {
  if (!(existing instanceof Date) || isNaN(existing.getTime()))
    return getNextMonday();
  const c = new Date(existing);
  c.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return c <= today ? getNextMonday() : c;
}

// ─── DATE FORMATTING ─────────────────────────────────────────────────────────

const TRIGGER_LINE_STYLE = `display:block;font-size:.8em;color:var(--kb-date-color);font-family:var(--kb-date-font);margin-top:2px;`;

// Collapses mon-fri (+ sat/sun) trigger labels into "week day" / "week day+sat" /
// "week day+sun" / "every day" so a full weekday recurrence doesn't list all 5-7 days.
function collapseWeekdayLabels(triggers: string[]): void {
  const weekdayIndex = (label: string): number => {
    const s = TRIGGER_WEEKDAYS_SHORT.indexOf(label);
    return s !== -1 ? s : TRIGGER_WEEKDAYS_FULL.indexOf(label);
  };

  let firstPos = -1;
  const present = new Set<number>();
  triggers.forEach((label, i) => {
    const idx = weekdayIndex(label);
    if (idx !== -1) {
      present.add(idx);
      if (firstPos === -1) firstPos = i;
    }
  });

  const hasAllWeekdays = [1, 2, 3, 4, 5].every((i) => present.has(i));
  if (!hasAllWeekdays) return;

  let combined: string;
  if (present.has(0) && present.has(6)) combined = 'every day';
  else if (present.has(6)) combined = 'week day+sat';
  else if (present.has(0)) combined = 'week day+sun';
  else combined = 'week day';

  for (let i = triggers.length - 1; i >= 0; i--) {
    if (weekdayIndex(triggers[i]) !== -1) triggers.splice(i, 1);
  }
  triggers.splice(firstPos, 0, combined);
}

function formatTriggerAnnotations(text: string, normRecurrent: string, clickable = true): string {
  if (!normRecurrent) return text;

  let hasRecurrent = false;
  const triggers: string[] = [];

  text = text.replace(new RegExp(`@${normRecurrent}\\b`, 'gi'), () => { hasRecurrent = true; return ''; });
  text = text.replace(/@([a-zA-Z][a-zA-Z_]*(?:[+-]\d+)?|\d{1,2})\b/g, (match, token) => {
    const t = token.toLowerCase();
    if (!isValidTriggerToken(t)) return match;
    const label = t === 'last_day' ? 'last day' : t;
    triggers.push(label);
    return '';
  });
  text = text.replace(/\s{2,}/g, ' ').trim();

  collapseWeekdayLabels(triggers);

  if (triggers.length) {
    const label = `↻ ${triggers.join('·')}`;
    const spanStyle = clickable
      ? `${TRIGGER_LINE_STYLE}cursor:pointer;text-decoration:underline dotted;`
      : TRIGGER_LINE_STYLE.replace('display:block', 'display:inline');
    const spanClass = clickable ? `class="kb-trigger-label" ` : '';
    text += `<span ${spanClass}style="${spanStyle}">${label}</span>`;
  }

  return text;
}

function stripTriggerAnnotations(text: string, normRecurrent: string): string {
  if (!normRecurrent) return text;
  text = text.replace(new RegExp(`@(${normRecurrent})\\b`, 'gi'), '$1');
  text = text.replace(/@([a-zA-Z][a-zA-Z_]*(?:[+-]\d+)?|\d{1,2})\b/g, (match, token) => {
    const t = token.toLowerCase();
    if (isValidTriggerToken(t) || /^quarterly([+-]\d+)?$/.test(t)) return token;
    return match;
  });
  return text;
}

function formatCardDateAnnotation(text: string, inline = false): string {
  return text.replace(/@(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => {
    const dateVal = new Date(Number(y), Number(m) - 1, Number(d));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((dateVal.getTime() - today.getTime()) / 86400000);

    let label: string;
    if (diffDays === 0) label = "today";
    else if (diffDays === 1) label = "tomorrow";
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

// ─── LINK CONVERSION ─────────────────────────────────────────────────────────

function linksToHtml(text: string, vaultName: string): string {
  // 1. Wiki links  [[Note]]  [[Note#Section]]  [[Note|Alias]]
  text = text.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_, path: string, alias: string) => {
      let filePath = path.includes("#") ? path.split("#")[0] : path;
      if (!filePath.endsWith(".md")) filePath += ".md";
      const section = path.includes("#") ? path.split("#")[1] : "";
      let href = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePath)}`;
      if (section) href += `&section=${encodeURIComponent(section)}`;
      const noteName = filePath.split("/").pop()!.replace(/\.md$/, "");
      const label = (alias || noteName)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<a href="${href}" style="color:var(--kb-link);text-decoration:underline dotted;text-underline-offset:2px;">${label}</a>`;
    }
  );

  // 2. Markdown links  [label](url)
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_, label: string, url: string) => {
      const title = label.replace(/"/g, "&quot;");
      return `<a href="${url}" target="_blank" rel="noopener" title="${title}" style="display:inline-block;padding:0 5px;border-radius:4px;border:1px solid var(--kb-link);color:var(--kb-link);text-decoration:none;font-size:.8em;line-height:1.6;vertical-align:middle;">🔗</a>`;
    }
  );

  // 3. Bare URLs — handles both <https://…> autolinks (strips the <>) and plain URLs
  text = text.replace(/<(https?:\/\/[^\s<>"]+)>|(?<!href=")(https?:\/\/[^\s<>"]+)/g, (_, bracketed, bare) => {
    const url = bracketed ?? bare;
    const title = url.replace(/"/g, "&quot;");
    return `<a href="${url}" target="_blank" rel="noopener" title="${title}" style="display:inline-block;padding:0 5px;border-radius:4px;border:1px solid var(--kb-link);color:var(--kb-link);text-decoration:none;font-size:.8em;line-height:1.6;vertical-align:middle;">🔗</a>`;
  });

  return text;
}

// ─── CHECKBOX / BULLET RENDERING ─────────────────────────────────────────────

function renderCheckbox(
  text: string,
  opts: {
    isSub?: boolean;
    showCheckbox?: boolean;
    vaultName?: string | null;
    enablePromotion?: boolean;
    subLine?: number | null;
    parentTag?: string | null;
    parentOrder?: number | null;
  } = {}
): string {
  const {
    isSub = false,
    showCheckbox = true,
    vaultName = null,
    enablePromotion = false,
    subLine = null,
    parentTag = null,
    parentOrder = null,
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
    cbHtml = showCheckbox
      ? `<input type="checkbox" disabled style="margin-right:5px;">`
      : "• ";
  }

  if (vaultName) content = linksToHtml(content, vaultName);

  const promoteHtml =
    enablePromotion && isSub && subLine && parentTag && parentOrder !== null
      ? `<span class="promote-icon" style="margin-left:6px;font-size:1.2em;cursor:pointer;color:var(--kb-accent);"
           data-line="${subLine}" data-parent-tag="${parentTag}" data-parent-order="${parentOrder}">&#9655</span>`
      : "";

  return `${cbHtml}${content}${promoteHtml}`;
}

// ─── FILE OPERATIONS ──────────────────────────────────────────────────────────

async function readFileLines(
  app: App,
  filePath: string
): Promise<{ tFile: TFile; lines: string[] }> {
  const tFile = app.vault.getAbstractFileByPath(filePath) as TFile | null;
  if (!tFile) throw new Error(`File not found: ${filePath}`);
  return { tFile, lines: (await app.vault.read(tFile)).split("\n") };
}

async function writeFileLines(app: App, tFile: TFile, lines: string[]) {
  await app.vault.modify(tFile, lines.join("\n"));
}

async function updateCardDate(app: App, filePath: string, lineNum: number, newDateStr: string | null): Promise<void> {
  const { tFile, lines } = await readFileLines(app, filePath);
  if (lineNum < 1 || lineNum > lines.length) return;
  const parsed = parseTaskLine(lines[lineNum - 1]);
  parsed.date = newDateStr;
  lines[lineNum - 1] = serializeTaskLine(parsed);
  await writeFileLines(app, tFile, lines);
}

async function updateCardTriggers(
  app: App, filePath: string, lineNum: number,
  normRecurrent: string, newTriggerStr: string
): Promise<void> {
  const { tFile, lines } = await readFileLines(app, filePath);
  if (lineNum < 1 || lineNum > lines.length) return;
  const parsed = parseTaskLine(lines[lineNum - 1]);
  // Remove old trigger tokens but keep @recurrent annotation
  parsed.text = parsed.text.replace(/@([a-zA-Z][a-zA-Z_]*(?:[+-]\d+)?|\d{1,2})\b/g, (match, token) => {
    const t = token.toLowerCase();
    if (t === normRecurrent) return match;
    return isValidTriggerToken(t) ? '' : match;
  }).replace(/\s{2,}/g, ' ').trim();
  // Append new triggers (avoid duplicates)
  for (const tok of newTriggerStr.trim().split(/\s+/)) {
    if (!tok) continue;
    const key = tok.replace(/^@/, '');
    if (!new RegExp(`@${key}\\b`, 'i').test(parsed.text)) parsed.text = parsed.text.trimEnd() + ' ' + tok;
  }
  lines[lineNum - 1] = serializeTaskLine(parsed);
  const n = new Date();
  const skipStr = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
  lines[lineNum - 1] = setSkipDate(lines[lineNum - 1], skipStr);
  await writeFileLines(app, tFile, lines);
}

async function editCardText(
  app: App,
  filePath: string,
  lineNum: number,
  newText: string
): Promise<boolean> {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    if (lineNum < 1 || lineNum > lines.length) return false;
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
    if (tags) parts.push(tags);
    if (orderComment) parts.push(orderComment);
    lines[lineNum - 1] = parts.join(" ");

    await writeFileLines(app, tFile, lines);
    return true;
  } catch (e: any) {
    console.error("editCardText failed:", e);
    return false;
  }
}

async function moveToColumn(
  app: App,
  filePath: string,
  lineNum: number,
  originalTags: string[],
  targetTag: string,
  isDone: boolean,
  config: KanbanConfig,
  dateStrToAppend: string | null = null,
  newDigits: string | null = null,
  newState: "expanded" | "collapsed" | null = null,
  triggerAnnotation: string | null = null,
  clearDate: boolean = false
): Promise<boolean> {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);

    const sortedOrig = originalTags.slice().sort().join(",");
    let idx = -1;
    const lineCandidate = lines[lineNum - 1];
    if (
      lineCandidate &&
      extractTags(lineCandidate).slice().sort().join(",") === sortedOrig
    ) {
      idx = lineNum - 1;
    } else {
      idx = lines.findIndex(
        (l) => extractTags(l).slice().sort().join(",") === sortedOrig
      );
    }
    if (idx === -1) throw new Error("Line not found by tag fingerprint");

    const parsed = parseTaskLine(lines[idx]);

    parsed.tags = parsed.tags.filter((t) => !config.normKanban.includes(normalizeTag(t)));
    parsed.tags.push(targetTag);

    if (config.normRecurrent && normalizeTag(targetTag) === config.normRecurrent) {
      const annRe = new RegExp(`@${config.normRecurrent}\\b`, 'i');
      if (!annRe.test(parsed.text)) parsed.text += ` @${config.normRecurrent}`;
      if (triggerAnnotation) {
        for (const tok of triggerAnnotation.trim().split(/\s+/)) {
          const tokRe = new RegExp(`@${tok.replace(/^@/, '')}\\b`, 'i');
          if (!tokRe.test(parsed.text)) parsed.text += ` ${tok}`;
        }
      }
    }

    if (parsed.checked !== null) parsed.checked = isDone;
    if (clearDate) parsed.date = null;
    if (dateStrToAppend) parsed.date = dateStrToAppend;
    if (isDone) {
      const n = new Date();
      parsed.doneDate = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`;
    } else {
      parsed.doneDate = null;
    }

    if (newDigits !== null) {
      parsed.orderDigits = newDigits;
      parsed.orderState =
        newState ??
        ([config.normDone, config.normLater].includes(normalizeTag(targetTag))
          ? "collapsed"
          : "expanded");
    }

    lines[idx] = serializeTaskLine(parsed);
    const n = new Date();
    const skipStr = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
    if (config.normRecurrent && normalizeTag(targetTag) === config.normRecurrent) {
      lines[idx] = setSkipDate(lines[idx], skipStr);
    }
    if (normalizeTag(targetTag) === config.normLater && !parsed.date) {
      lines[idx] = setSkipDate(lines[idx], skipStr);
    }
    await writeFileLines(app, tFile, lines);
    return true;
  } catch (e: any) {
    console.error("moveToColumn failed:", e);
    return false;
  }
}

async function addNewItem(
  app: App,
  rawInsertTarget: string,
  columnTag: string,
  userText: string,
  dateStr: string | null,
  config: KanbanConfig,
  createDoc = false
): Promise<boolean> {
  try {
    if (!userText?.trim()) return false;

    let cardText = userText.trim();

    if (createDoc) {
      // ── "Create new document" path ───────────────────────────────────────────
      // Task goes into the new project doc; a [[link]] is added to the master doc.
      const safeTitle = cardText
        .replace(/\s*%%[\s\S]*?%%/g, "")
        .replace(/@\S+/g, "")
        .replace(/[\\/:*?"<>|#\[\]]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const docPath = `${safeTitle}.md`;

      let projFile = app.vault.getAbstractFileByPath(docPath) as TFile | null;
      if (!projFile) {
        projFile = await app.vault.create(docPath, "");
        showInfoDialog(`Created new note "${safeTitle}.md".`);
      }

      let newLine = `- [ ] ${cardText} ${columnTag}`;
      if (dateStr) newLine += ` ${dateStr}`;
      {
        const n = new Date();
        const skipStr = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
        if (config.normRecurrent && normalizeTag(columnTag) === config.normRecurrent
            && !hasValidTriggers(newLine, config.normRecurrent) && !extractSkipDate(newLine)) {
          newLine = setSkipDate(newLine, skipStr);
        }
        if (normalizeTag(columnTag) === config.normLater && !dateStr) {
          newLine = setSkipDate(newLine, skipStr);
        }
      }
      const projLines = (await app.vault.read(projFile)).split("\n");
      projLines.splice(afterFrontMatter(projLines), 0, newLine);
      await app.vault.modify(projFile, projLines.join("\n"));

      const masterDocName = config.projectsDocument.trim();
      if (masterDocName) {
        const masterPath = masterDocName.endsWith(".md") ? masterDocName : `${masterDocName}.md`;
        let masterFile = app.vault.getAbstractFileByPath(masterPath) as TFile | null;
        if (!masterFile) {
          masterFile = await app.vault.create(masterPath, `# ${masterDocName}\n`);
        }
        const masterLines = (await app.vault.read(masterFile)).split("\n");
        masterLines.splice(afterFrontMatter(masterLines), 0, `[[${safeTitle}]]`);
        await app.vault.modify(masterFile, masterLines.join("\n"));
      }

      new Notice(`Added "${userText}" to ${safeTitle}.`);
      return true;
    }

    // ── Normal path ────────────────────────────────────────────────────────
    // Later/Recurrent: {baseName}/{ColumnName}.md — one undated running doc per column
    // Everything else: {baseName}/{baseName}-YYYY-MM.md — monthly document
    // {baseName}/{baseName}.md — index linking to each target doc (newest on top)
    const baseName = rawInsertTarget.trim().split("#")[0].replace(/\.md$/, "").trim();
    const dirPath = baseName;
    const indexPath = `${dirPath}/${baseName}.md`;

    if (!(app.vault.getAbstractFileByPath(dirPath) instanceof TFolder)) {
      await app.vault.createFolder(dirPath);
    }

    const normColumn = normalizeTag(columnTag);
    const isLater = normColumn === config.normLater;
    const isRecurrent = !!config.normRecurrent && normColumn === config.normRecurrent;

    let targetFileName: string;
    if (isLater) targetFileName = "Later";
    else if (isRecurrent) targetFileName = "Recurrent";
    else {
      const now = new Date();
      const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      targetFileName = `${baseName}-${monthStr}`;
    }
    const targetPath = `${dirPath}/${targetFileName}.md`;

    let targetFile = app.vault.getAbstractFileByPath(targetPath) as TFile | null;
    if (!targetFile) {
      targetFile = await app.vault.create(targetPath, `# ${targetFileName}\n`);
    }

    // Add link to index only if not already present
    const linkLine = `[[${targetFileName}]]`;
    let indexFile = app.vault.getAbstractFileByPath(indexPath) as TFile | null;
    if (!indexFile) {
      await app.vault.create(indexPath, linkLine + "\n");
    } else {
      const idxLines = (await app.vault.read(indexFile)).split("\n");
      if (!idxLines.some(l => l.trim() === linkLine)) {
        idxLines.splice(afterFrontMatter(idxLines), 0, linkLine);
        await app.vault.modify(indexFile, idxLines.join("\n"));
      }
    }

    let newLine = `- [ ] ${cardText} ${columnTag}`;
    if (dateStr) newLine += ` ${dateStr}`;
    {
      const n = new Date();
      const skipStr = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
      if (isRecurrent && !hasValidTriggers(newLine, config.normRecurrent) && !extractSkipDate(newLine)) {
        newLine = setSkipDate(newLine, skipStr);
      }
      if (isLater && !dateStr) {
        newLine = setSkipDate(newLine, skipStr);
      }
    }
    const targetLines = (await app.vault.read(targetFile)).split("\n");
    let insertAt = afterFrontMatter(targetLines);
    if (targetLines[insertAt]?.match(/^#\s/)) insertAt++;
    targetLines.splice(insertAt, 0, newLine);
    await app.vault.modify(targetFile, targetLines.join("\n"));

    new Notice(`Added "${userText}" to ${columnTag.replace(/^#/, "").toUpperCase()}.`);
    return true;
  } catch (e: any) {
    console.error("addNewItem failed:", e);
    new Notice(`Failed to add item: ${e.message}`);
    return false;
  }
}

async function moveCardToNewDoc(
  app: App,
  filePath: string,
  lineNum: number,
  plainTitle: string,
  targetTag: string,
  config: KanbanConfig
) {
  const safeTitle = plainTitle.replace(/[\\/:*?"<>|#\[\]]/g, " ").replace(/\s+/g, " ").trim();
  const docPath = `${safeTitle}.md`;

  const { tFile, lines } = await readFileLines(app, filePath);

  // Build task line for new document with target tag, strip ordering
  const parsed = parseTaskLine(lines[lineNum - 1]);
  parsed.tags = parsed.tags.filter((t) => !config.normKanban.includes(normalizeTag(t)));
  parsed.tags.push(targetTag);
  parsed.orderDigits = null;
  parsed.orderState = null;
  const newTaskLine = serializeTaskLine(parsed);

  // Create or update the project document
  let projFile = app.vault.getAbstractFileByPath(docPath) as TFile | null;
  const isNew = !projFile;
  if (!projFile) projFile = await app.vault.create(docPath, "");
  const projLines = (await app.vault.read(projFile)).split("\n");
  projLines.splice(afterFrontMatter(projLines), 0, newTaskLine);
  await app.vault.modify(projFile, projLines.join("\n"));

  // Remove card line from source, insert [[link]] in its place
  const nd = new Date();
  const movedDate = `${nd.getFullYear()}-${String(nd.getMonth()+1).padStart(2,"0")}-${String(nd.getDate()).padStart(2,"0")}`;
  lines.splice(lineNum - 1, 1, `[[${safeTitle}]] (moved: ${movedDate})`);
  await writeFileLines(app, tFile, lines);

  // Add [[link]] to master document
  const masterDocName = config.projectsDocument.trim();
  if (masterDocName) {
    const masterPath = masterDocName.endsWith(".md") ? masterDocName : `${masterDocName}.md`;
    let masterFile = app.vault.getAbstractFileByPath(masterPath) as TFile | null;
    if (!masterFile) {
      masterFile = await app.vault.create(masterPath, `# ${masterDocName}\n`);
    }
    const masterLines = (await app.vault.read(masterFile)).split("\n");
    masterLines.splice(afterFrontMatter(masterLines), 0, `[[${safeTitle}]]`);
    await app.vault.modify(masterFile, masterLines.join("\n"));
  }

  new Notice(isNew ? `Created "${safeTitle}.md" and moved task.` : `Moved task to existing "${safeTitle}.md".`);
}

const ARCHIVE_CALLOUT_HEADER = "> [!note]- Archived";

async function archiveToSection(
  app: App,
  filePath: string,
  mainLineNum: number,
  subLines: any[],
  config: KanbanConfig,
  _isTopLevel = true
): Promise<boolean> {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);

    // Recurring cards reset back to active below; if any line in this block
    // recurs, leave the whole block where it is instead of archiving it.
    let hasRecurrentInBlock = false;

    function archiveLine(idx: number, tickBox: boolean) {
      if (idx < 0 || idx >= lines.length) return;
      const parsed = parseTaskLine(lines[idx]);
      parsed.tags = parsed.tags.filter((t) => !config.normKanban.includes(normalizeTag(t)));
      parsed.orderDigits = null;
      parsed.orderState = null;
      if (config.normRecurrent && hasRecurrentAnnotation(lines[idx], config.normRecurrent)) {
        hasRecurrentInBlock = true;
        // Reset recurrent card: uncheck, clear done-date, restore #recurrent tag
        if (parsed.checked !== null) parsed.checked = false;
        parsed.doneDate = null;
        parsed.tags.push(config.recurrentColumn);
        lines[idx] = serializeTaskLine(parsed);
        const n = new Date();
        const skipStr = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
        lines[idx] = setSkipDate(lines[idx], skipStr);
      } else {
        if (tickBox && parsed.checked !== null) parsed.checked = true;
        lines[idx] = serializeTaskLine(parsed);
      }
    }

    const mainIdx = mainLineNum - 1;
    const endIdx = (maxSubLine(subLines) || mainLineNum) - 1;

    archiveLine(mainIdx, true);
    const recurse = (subs: any[]) => {
      for (const sub of subs) {
        archiveLine(sub.line - 1, false);
        if (sub.subs?.length) recurse(sub.subs);
      }
    };
    recurse(subLines);

    if (_isTopLevel && !hasRecurrentInBlock) {
      // Move the whole card + its descendants into a collapsible "Archived"
      // callout at the end of the document, creating it if needed. The "-"
      // after the callout type makes it foldable and collapsed by default.
      const blockLines = lines.slice(mainIdx, endIdx + 1).map((l) => `> ${l}`);
      lines.splice(mainIdx, endIdx - mainIdx + 1);

      const calloutIdx = lines.findIndex((l) => l.trim() === ARCHIVE_CALLOUT_HEADER);
      if (calloutIdx >= 0) {
        lines.splice(calloutIdx + 1, 0, ...blockLines);
      } else {
        while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
        lines.push("", ARCHIVE_CALLOUT_HEADER, ...blockLines);
      }
    }

    await writeFileLines(app, tFile, lines);
    return true;
  } catch (e: any) {
    console.error("archiveToSection failed:", e);
    return false;
  }
}

async function promoteSubToChild(
  app: App,
  filePath: string,
  subLineNum: number,
  parentTag: string,
  parentOrder: number,
  config: KanbanConfig,
  refresh: () => void
): Promise<boolean> {
  try {
    const normParent = normalizeTag(parentTag);

    // Compute order from current board state BEFORE modifying the file
    const targetPaths = await getTargetFilePaths(app, config);
    const allItems = await collectItems(app, targetPaths, config);
    const columns = groupByColumns(allItems, config);

    const parentCard = (columns[normParent]?.cards || [])
      .find((c: any) => c.order !== null && Math.abs(c.order - parentOrder) < 1e-10);

    const prevSibling = parentCard
      ? { digits: parentCard.digits || "0", len: parentCard.len || 1, order: parentOrder }
      : { digits: parentOrder.toString().split(".")[1] || "0", len: (parentOrder.toString().split(".")[1] || "0").length, order: parentOrder };

    const higher = (columns[normParent]?.cards || [])
      .filter((c: any) => c.order !== null && c.order > parentOrder)
      .sort((a: any, b: any) => a.order - b.order);

    let newCalc: { digits: string; len: number };
    if (higher.length) {
      newCalc = calcMidDigits(prevSibling, higher[0], false);
    } else {
      const fallback = Math.min(0.999, parentOrder + 0.1);
      newCalc = { digits: fallback.toFixed(Math.max(prevSibling.len, 3)).split(".")[1], len: Math.max(prevSibling.len, 3) };
    }

    const newState: "expanded" | "collapsed" = [config.normDone, config.normLater].includes(normParent)
      ? "collapsed" : "expanded";

    // Write tag + order in a single file write
    const { tFile, lines } = await readFileLines(app, filePath);
    if (subLineNum < 1 || subLineNum > lines.length) return false;

    const parsed = parseTaskLine(lines[subLineNum - 1]);
    if (!parsed.tags.some((t) => normalizeTag(t) === normParent)) {
      parsed.tags.push(parentTag);
    }
    if (parentCard && !parsed.date) {
      const dm = parentCard.item.text.match(/@\d{4}-\d{2}-\d{2}/);
      if (dm) parsed.date = dm[0];
    }
    parsed.orderDigits = newCalc.digits;
    parsed.orderState = newState;
    lines[subLineNum - 1] = serializeTaskLine(parsed);
    await writeFileLines(app, tFile, lines);

    new Notice(`Tagged subtask with ${parentTag.replace(/^#/, "").toUpperCase()}.`);
    requestAnimationFrame(() => setTimeout(refresh, 50));
    return true;
  } catch (e: any) {
    console.error("promoteSubToChild failed:", e);
    return false;
  }
}

// ─── DATA COLLECTION ──────────────────────────────────────────────────────────

export async function getTargetFilePaths(
  app: App,
  config: KanbanConfig
): Promise<string[]> {
  if (config.allVaultNotes) {
    return app.vault.getMarkdownFiles().map((f) => f.path);
  }

  async function getDescendants(
    start: string,
    visited = new Set<string>()
  ): Promise<string[]> {
    if (visited.has(start)) return [];
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
  const allPaths: string[] = [];
  for (const name of config.parentPages) {
    const file = allFiles.find(
      (f) => f.basename === name || f.path.endsWith(`${name}.md`)
    );
    if (file) allPaths.push(...(await getDescendants(file.path)));
  }
  return [...new Set(allPaths)];
}

export async function collectItems(
  app: App,
  targetFilePaths: string[],
  config: KanbanConfig
): Promise<any[]> {
  const allItems: any[] = [];
  let discoveryIdx = 0;

  const LIST_RE = /^(\s*)(?:[-*+]|\d+[\.\)]|-\s*\[\s*\])\s+/;
  const CODE_RE = /^[\s]*```/;
  const EMBED_RE = /^[\s]*!\[\[/;
  const LINK_RE = /^[\s]*\[\[/;

  for (const filePath of targetFilePaths) {
    const tFile = app.vault.getAbstractFileByPath(filePath) as TFile | null;
    if (!tFile) continue;

    let raw: string;
    try {
      raw = await app.vault.read(tFile);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "string") continue;

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
    const stack: any[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (typeof line !== "string") continue;
      const trim = line.trim();
      if (!trim || trim.toLowerCase().includes("#exclude")) continue;
      if (CODE_RE.test(line)) {
        inCode = !inCode;
        continue;
      }
      if (inCode || EMBED_RE.test(line) || LINK_RE.test(line)) continue;

      const indent = (line.match(/^(\s*)/) || [""])[0].length;

      // Headings with kanban tags
      const hMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
      if (hMatch) {
        const tags = extractTags(hMatch[2]);
        if (tags.some((t: string) => matchesKanbanTag(t, config.normKanban))) {
          const parsed = parseOrderComment(hMatch[2]);
          while (
            stack.length &&
            stack[stack.length - 1].indent >= indent
          ) {
            const p = stack.pop();
            if (
              p.item.tags.some((t: string) =>
                matchesKanbanTag(t, config.normKanban)
              )
            )
              allItems.push({ ...p, discoveryIndex: discoveryIdx++ });
          }
          stack.push({
            item: { text: hMatch[2].trim(), tags, line: i + 1 + start, subs: [] },
            source: { path: filePath },
            filePath,
            order: parsed?.order ?? null,
            state: parsed?.state ?? "collapsed",
            digits: parsed?.digits ?? null,
            len: parsed?.len ?? null,
            isPromoted: indent > 0,
            indent,
            hierarchy_level: stack.length,
          });
        }
        continue;
      }

      if (!LIST_RE.test(line)) continue;

      const ownTags = extractTags(line);
      const parsed = parseOrderComment(trim);

      while (
        stack.length &&
        stack[stack.length - 1].indent >= indent
      ) {
        const p = stack.pop();
        if (
          p.item.tags.some((t: string) =>
            matchesKanbanTag(t, config.normKanban)
          )
        )
          allItems.push({ ...p, discoveryIndex: discoveryIdx++ });
      }

      const entry: any = {
        item: { text: trim, tags: ownTags, line: i + 1 + start, subs: [] },
        source: { path: filePath },
        filePath,
        order: parsed?.order ?? null,
        state: parsed?.state ?? "collapsed",
        digits: parsed?.digits ?? null,
        len: parsed?.len ?? null,
        isPromoted: stack.length > 0 && ownTags.some((t: string) =>
          matchesKanbanTag(t, config.normKanban)
        ),
        indent,
        hierarchy_level: stack.length,
      };

      if (stack.length && stack[stack.length - 1].indent < indent) {
        stack[stack.length - 1].item.subs.push(entry.item);
      }

      stack.push(entry);
    }

    while (stack.length) {
      const e = stack.pop();
      if (
        e.item.tags.some((t: string) => matchesKanbanTag(t, config.normKanban))
      )
        allItems.push({ ...e, discoveryIndex: discoveryIdx++ });
    }
  }

  function setLevels(node: any, level = 0) {
    node.hierarchy_level = level;
    node.subs?.forEach((s: any) => setLevels(s, level + 1));
  }

  return allItems
    .filter((e) =>
      e.item.tags.some((t: string) => matchesKanbanTag(t, config.normKanban))
    )
    .map((e) => {
      setLevels(e.item);
      return {
        ...e,
        multiTag:
          e.item.tags
            .map(normalizeTag)
            .filter((t: string) => config.normKanban.includes(t)).length > 1,
      };
    });
}

export function groupByColumns(items: any[], config: KanbanConfig) {
  const columns: Record<string, { rawTag: string; cards: any[] }> =
    Object.fromEntries(
      config.kanban.map((tag) => [
        normalizeTag(tag),
        { rawTag: tag, cards: [] },
      ])
    );

  for (const item of items) {
    const norms = item.item.tags
      .map(normalizeTag)
      .filter((t: string) => config.normKanban.includes(t));
    for (const norm of norms) {
      columns[norm].cards.push({ ...item });
    }
  }

  const cmp = (a: any, b: any) => {
    const oa = a.order ?? 999,
      ob = b.order ?? 999;
    return Math.abs(oa - ob) < 1e-10
      ? (a.discoveryIndex || 0) - (b.discoveryIndex || 0)
      : oa - ob;
  };
  Object.values(columns).forEach((col) => col.cards.sort(cmp));
  return columns;
}

async function assignInitialOrders(
  app: App,
  columns: Record<string, { rawTag: string; cards: any[] }>,
  _config: KanbanConfig
) {
  const multiKeys = new Set<string>();
  for (const col of Object.values(columns)) {
    for (const card of col.cards) {
      if (card.multiTag) multiKeys.add(`${card.filePath}:${card.item.line}`);
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
      col.cards = col.cards.map((c: any) =>
        `${c.filePath}:${c.item.line}` === key
          ? { ...c, order: 0, digits: "0" }
          : c
      );
    }
  }

  for (const col of Object.values(columns)) {
    const ordered = col.cards.filter(
      (c: any) => c.order !== null && !c.multiTag
    );
    const unordered = col.cards
      .filter((c: any) => c.order === null && !c.multiTag)
      .sort((a: any, b: any) => a.discoveryIndex - b.discoveryIndex);
    if (!unordered.length) continue;

    const high = ordered.length ? ordered[0].order : 0.9;
    const maxLen = ordered.length ? ordered[0].len || 1 : 1;
    const spacing = high / (unordered.length + 1);

    for (let i = 0; i < unordered.length; i++) {
      const order = (i + 1) * spacing;
      const digits = order.toFixed(maxLen).split(".")[1];
      await updateFileOrderComment(
        app,
        unordered[i].filePath,
        unordered[i].item.line,
        digits,
        "collapsed"
      );
      Object.assign(unordered[i], { order, digits, len: maxLen, state: "collapsed" });
    }

    const cmp = (a: any, b: any) =>
      (a.order ?? 999) - (b.order ?? 999) ||
      (a.discoveryIndex || 0) - (b.discoveryIndex || 0);
    col.cards.sort(cmp);
  }
}

// ─── DIALOG HELPERS ───────────────────────────────────────────────────────────

let _dialogDoc: Document = document;

function makeOverlay(id: string) {
  const doc = _dialogDoc;
  doc.getElementById(id)?.remove();
  const overlay = doc.createElement("div");
  overlay.id = id;
  overlay.style.cssText =
    "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;";
  doc.body.appendChild(overlay);
  const dialog = doc.createElement("div");
  dialog.style.cssText =
    "background:var(--background-primary);color:var(--kb-dialog-text,var(--text-normal));padding:20px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:300px;max-width:400px;text-align:center;";
  overlay.appendChild(dialog);
  const close = () => overlay.remove();
  return { overlay, dialog, close };
}

function inputStyle() {
  return "width:100%;padding:8px;margin-bottom:10px;border:1px solid var(--background-modifier-border);border-radius:4px;box-sizing:border-box;background:var(--background-secondary);color:var(--text-normal);";
}

function buttonHtml(label: string, accent: boolean) {
  const bg = accent ? "var(--interactive-accent)" : "var(--background-modifier-border)";
  const color = accent ? "var(--text-on-accent)" : "var(--text-normal)";
  return `<button style="padding:8px 16px;background:${bg};color:${color};border:none;border-radius:4px;cursor:pointer;">${label}</button>`;
}

function afterFrontMatter(lines: string[]): number {
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === "---") return i + 1;
    }
  }
  return 0;
}

function showConfirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { dialog, close } = makeOverlay("kanban-confirm-dialog");
    dialog.innerHTML = `
      <p style="margin:0 0 16px;font-size:.95em;">${message}</p>
      <div style="display:flex;gap:10px;justify-content:center;">${buttonHtml("Yes", true)}${buttonHtml("No", false)}</div>`;
    const [yesBtn, noBtn] = dialog.querySelectorAll("button");
    yesBtn.onclick = () => { close(); resolve(true); };
    noBtn.onclick = () => { close(); resolve(false); };
  });
}

function showInfoDialog(message: string) {
  const { dialog, close } = makeOverlay("kanban-info-dialog");
  dialog.innerHTML = `
    <p style="margin:0 0 16px;font-size:.95em;">${message}</p>
    <div style="text-align:center;">${buttonHtml("OK", false)}</div>`;
  const [okBtn] = dialog.querySelectorAll("button");
  okBtn.onclick = close;
}


function showInputDialog(title: string, defaultCreateDoc: boolean, onSubmit: (v: string, createDoc: boolean) => void) {
  const { dialog, close } = makeOverlay("kanban-input-dialog");
  const chk = defaultCreateDoc ? "checked" : "";
  dialog.innerHTML = `<h3 style="margin:0 0 10px;font-size:1.1em;">${title}</h3>
    <input id="k-text" type="text" placeholder="Enter new item text..." style="${inputStyle()}" autofocus>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;font-size:.9em;">
      <input id="k-doc" type="checkbox" ${chk}> Create new document
    </label>
    <div style="display:flex;gap:10px;justify-content:center;">${buttonHtml("Add", true)}${buttonHtml("Cancel", false)}</div>`;

  const [addBtn, cancelBtn] = dialog.querySelectorAll("button");
  const input = dialog.querySelector("#k-text") as HTMLInputElement;
  const docCheck = dialog.querySelector("#k-doc") as HTMLInputElement;
  const submit = () => {
    const v = input.value.trim();
    const createDoc = docCheck.checked;
    close();
    if (v) onSubmit(v, createDoc);
  };
  addBtn.onclick = submit;
  cancelBtn.onclick = close;
  input.onkeydown = (e) => {
    if (e.key === "Enter") submit();
    if (e.key === "Escape") close();
  };
  input.focus();
}

// Shared date-picker dialog for #later cards. Pass opts.withText to also collect
// item text + "create new document" (the "add card to Later" flow); omit it for a
// plain date-only picker (move-to-Later, change date, subtask date).
function showDateDialog(
  title: string,
  defaultDate: string,
  onSubmit: (dateStr: string | null, text?: string, createDoc?: boolean) => void,
  opts: { withText?: boolean; defaultCreateDoc?: boolean } = {}
) {
  const { withText, defaultCreateDoc } = opts;
  const { dialog, close } = makeOverlay(withText ? "kanban-later-add-dialog" : "kanban-date-dialog");
  const chk = defaultCreateDoc ? "checked" : "";
  const presetBtnStyle = (active: boolean) =>
    `padding:4px 10px;border:none;border-radius:12px;cursor:pointer;font-size:.75em;` +
    (active
      ? `background:var(--interactive-accent);color:var(--text-on-accent);`
      : `background:var(--background-modifier-border);color:var(--text-normal);`);
  let selectedPreset: string | null =
    DATE_PRESETS.find(([, , fn]) => fn().toISOString().split("T")[0] === defaultDate)?.[0] ?? null;
  const presetBtnsHtml = DATE_PRESETS.map(
    ([key, label]) => `<button type="button" class="kb-date-preset" data-preset="${key}" style="${presetBtnStyle(key === selectedPreset)}">${label}</button>`
  ).join("");

  dialog.innerHTML = `<h3 style="margin:0 0 10px;font-size:1.1em;">${title}</h3>
    ${withText ? `<input id="k-text" type="text" placeholder="Enter new item text..." style="${inputStyle()}" autofocus>` : ""}
    <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-bottom:8px;">${presetBtnsHtml}</div>
    <input id="k-date" type="date" value="${defaultDate}" style="${inputStyle()}" ${withText ? "" : "autofocus"}>
    ${withText ? `<label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;font-size:.9em;">
      <input id="k-doc" type="checkbox" ${chk}> Create new document
    </label>` : ""}
    <div id="k-date-actions" style="display:flex;gap:10px;justify-content:center;">${buttonHtml(withText ? "Add" : "Set", true)}${buttonHtml("No date", false)}${buttonHtml("Cancel", false)}</div>`;

  const [actionBtn, noDateBtn, cancelBtn] = dialog.querySelectorAll<HTMLButtonElement>("#k-date-actions button");
  const textInput = withText ? (dialog.querySelector("#k-text") as HTMLInputElement) : null;
  const dateInput = dialog.querySelector("#k-date") as HTMLInputElement;
  const docCheck = withText ? (dialog.querySelector("#k-doc") as HTMLInputElement) : null;

  const presetBtns = dialog.querySelectorAll<HTMLButtonElement>(".kb-date-preset");
  presetBtns.forEach((btn) => {
    const preset = DATE_PRESETS.find(([key]) => key === btn.dataset.preset)!;
    btn.onclick = () => {
      dateInput.value = preset[2]().toISOString().split("T")[0];
      selectedPreset = preset[0];
      presetBtns.forEach((b) => { b.style.cssText = presetBtnStyle(b.dataset.preset === selectedPreset); });
    };
  });

  const submit = (useDate: boolean) => {
    const t = textInput?.value.trim() ?? "";
    if (withText && !t) return;
    const d = useDate ? dateInput.value : "";
    close();
    onSubmit(d ? "@" + d : null, withText ? t : undefined, docCheck?.checked);
  };
  actionBtn.onclick = () => submit(true);
  noDateBtn.onclick = () => submit(false);
  cancelBtn.onclick = close;
  [textInput, dateInput].forEach((el) => {
    el?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit(true);
      if (e.key === "Escape") close();
    });
  });
  (textInput ?? dateInput).focus();
}

function showRecurrentTriggerDialog(onSubmit: (trigger: string) => void, existingTriggers: string[] = []) {
  const { dialog, close } = makeOverlay("kanban-recurrent-trigger-dialog");

  const WD_KEYS   = ['sun','mon','tue','wed','thu','fri','sat'];
  const WD_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MO_KEYS   = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const MO_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const activeWD       = new Set(existingTriggers.filter(t => WD_KEYS.includes(t)));
  const selectedDays   = existingTriggers.filter(t => /^\d{1,2}$/.test(t));
  const selectedMonths = existingTriggers.filter(t => MO_KEYS.includes(t));
  const activeQuarterly = new Set<string>(
    existingTriggers
      .filter(t => t === 'quarterly+2' || t === 'quarterly+3' || t === 'q+2' || t === 'q+3')
      .map(t => t === 'q+2' ? 'quarterly+2' : t === 'q+3' ? 'quarterly+3' : t)
  );
  let quarterlyActive = existingTriggers.includes('quarterly') || existingTriggers.includes('q+1');

  const wdStyle = (active: boolean) =>
    `height:24px;padding:0 8px;border-radius:12px;border:1px solid var(--background-modifier-border);cursor:pointer;font-size:.75em;display:inline-flex;align-items:center;justify-content:center;` +
    (active ? `background:var(--interactive-accent);color:var(--text-on-accent);` : `background:none;color:inherit;`);

  const selectedChipStyle = wdStyle(true);

  const wdBtns = WD_KEYS.map((d, i) =>
    `<button type="button" class="kb-wd-btn" data-day="${d}" style="${wdStyle(activeWD.has(d))}">${WD_LABELS[i]}</button>`
  ).join('');

  const dayOpts = `<option value="">Add day…</option>` +
    Array.from({length: 30}, (_, i) => `<option value="${i+1}">${i+1}</option>`).join('') +
    `<option value="last_day" disabled>Last day</option>`;

  const moOpts = `<option value="">Add month…</option>` +
    MO_KEYS.map((m, i) => `<option value="${m}">${MO_LABELS[i]}</option>`).join('');

  const selStyle = `padding:4px 8px;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-secondary);color:inherit;font-size:.8em;`;
  const lblStyle = `font-size:.8em;color:inherit;opacity:.75;`;

  dialog.innerHTML = `
    <h3 style="margin:0 0 12px;font-size:1.1em;">Set recurrence trigger</h3>
    <div style="margin-bottom:12px;">
      <span style="${lblStyle}display:block;margin-bottom:4px;">Weekday</span>
      <div id="k-wd-wrap" style="display:flex;gap:4px;flex-wrap:wrap;">${wdBtns}</div>
    </div>
    <div style="margin-bottom:12px;">
      <span style="${lblStyle}display:block;margin-bottom:4px;">Quarterly</span>
      <div style="display:flex;gap:4px;flex-wrap:wrap;">
        <button type="button" id="k-quarterly-btn" style="${wdStyle(quarterlyActive)}">quarterly</button>
        <button type="button" class="kb-q-btn" data-q="quarterly+2" style="${wdStyle(activeQuarterly.has('quarterly+2'))}">quarterly+2</button>
        <button type="button" class="kb-q-btn" data-q="quarterly+3" style="${wdStyle(activeQuarterly.has('quarterly+3'))}">quarterly+3</button>
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

  const wdWrap   = dialog.querySelector("#k-wd-wrap") as HTMLElement;
  const qWrap    = dialog.querySelector(".kb-q-btn")!.parentElement as HTMLElement;
  const domSel   = dialog.querySelector("#k-dom") as HTMLSelectElement;
  const moSel        = dialog.querySelector("#k-month") as HTMLSelectElement;
  const domRows      = dialog.querySelector("#k-dom-rows") as HTMLElement;
  const moRows       = dialog.querySelector("#k-month-rows") as HTMLElement;
  const errEl        = dialog.querySelector("#k-trigger-err") as HTMLElement;
  const [setBtn, noTriggerBtn, cancelBtn] = dialog.querySelectorAll<HTMLButtonElement>("#k-recur-actions button");

  const renderDomRows = () => {
    domRows.innerHTML = selectedDays.map((d, i) =>
      `<button type="button" class="kb-rm-day" data-idx="${i}" style="${selectedChipStyle}">${d}</button>`
    ).join('');
  };

  const renderMoRows = () => {
    moRows.innerHTML = selectedMonths.map((m, i) =>
      `<button type="button" class="kb-rm-month" data-idx="${i}" style="${selectedChipStyle}">${MO_LABELS[MO_KEYS.indexOf(m)]}</button>`
    ).join('');
  };

  renderDomRows();
  renderMoRows();

  // Quarterly toggle (plain)
  const quarterlyBtn = dialog.querySelector("#k-quarterly-btn") as HTMLButtonElement;
  quarterlyBtn.addEventListener("click", () => {
    quarterlyActive = !quarterlyActive;
    quarterlyBtn.style.cssText = wdStyle(quarterlyActive);
  });

  // quarterly+2 / quarterly+3 toggles
  qWrap.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest(".kb-q-btn") as HTMLButtonElement | null;
    if (!btn) return;
    const q = btn.dataset.q!;
    if (activeQuarterly.has(q)) { activeQuarterly.delete(q); btn.style.cssText = wdStyle(false); }
    else                        { activeQuarterly.add(q);    btn.style.cssText = wdStyle(true);  }
  });

  // Weekday toggle
  wdWrap.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest(".kb-wd-btn") as HTMLButtonElement | null;
    if (!btn) return;
    const day = btn.dataset.day!;
    if (activeWD.has(day)) { activeWD.delete(day); btn.style.cssText = wdStyle(false); }
    else                   { activeWD.add(day);    btn.style.cssText = wdStyle(true);  }
  });

  // Day-of-month: selecting appends a row
  domSel.addEventListener("change", () => {
    const val = domSel.value;
    domSel.value = "";
    if (!val || val === 'last_day' || selectedDays.includes(val)) return;
    selectedDays.push(val);
    selectedDays.sort((a, b) => parseInt(a) - parseInt(b));
    renderDomRows();
  });

  // Month: selecting appends a row
  moSel.addEventListener("change", () => {
    const val = moSel.value;
    moSel.value = "";
    if (!val || selectedMonths.includes(val)) return;
    selectedMonths.push(val);
    selectedMonths.sort((a, b) => MO_KEYS.indexOf(a) - MO_KEYS.indexOf(b));
    renderMoRows();
  });

  // Remove rows via event delegation
  domRows.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest(".kb-rm-day") as HTMLButtonElement | null;
    if (!btn) return;
    selectedDays.splice(parseInt(btn.dataset.idx!, 10), 1);
    renderDomRows();
  });

  moRows.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest(".kb-rm-month") as HTMLButtonElement | null;
    if (!btn) return;
    selectedMonths.splice(parseInt(btn.dataset.idx!, 10), 1);
    renderMoRows();
  });

  const submit = () => {
    const tokens = [...activeWD, ...(quarterlyActive ? ['quarterly'] : []), ...['quarterly+2','quarterly+3'].filter(q => activeQuarterly.has(q)), ...selectedDays, ...selectedMonths];
    if (!tokens.length) { errEl.textContent = "Select at least one trigger."; return; }
    close();
    onSubmit(tokens.map(t => `@${t}`).join(" "));
  };

  setBtn.onclick = submit;
  noTriggerBtn.onclick = () => { close(); onSubmit(""); };
  cancelBtn.onclick = close;
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
    if (e.key === "Escape") close();
  });
}

function showSubtaskDialog(onSubmit: (text: string) => void) {
  const { dialog, close } = makeOverlay("kanban-subtask-dialog");
  dialog.innerHTML = `<h3 style="margin:0 0 10px;font-size:1.1em;">Add subtask</h3>
    <input id="k-text" type="text" placeholder="Enter subtask text..." style="${inputStyle()}" autofocus>
    <div style="display:flex;gap:10px;justify-content:center;">${buttonHtml("Add", true)}${buttonHtml("Cancel", false)}</div>`;
  const [addBtn, cancelBtn] = dialog.querySelectorAll("button");
  const input = dialog.querySelector("#k-text") as HTMLInputElement;
  const submit = () => { const v = input.value.trim(); close(); if (v) onSubmit(v); };
  addBtn.onclick = submit;
  cancelBtn.onclick = close;
  input.onkeydown = (e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") close(); };
  input.focus();
}

async function addSubtaskToCard(
  app: App, filePath: string, afterLine: number, cardLine: number, text: string
): Promise<boolean> {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    const cardIndent = (lines[cardLine - 1]?.match(/^(\s*)/) ?? ["",""])[1];
    lines.splice(afterLine, 0, `${cardIndent}  - [ ] ${text}`);
    await writeFileLines(app, tFile, lines);
    return true;
  } catch { return false; }
}

function maxSubLine(subs: any[]): number {
  let max = 0;
  for (const s of subs ?? []) {
    if (s.line > max) max = s.line;
    const m = maxSubLine(s.subs);
    if (m > max) max = m;
  }
  return max;
}

// ─── CARD HTML ────────────────────────────────────────────────────────────────

function createCardHTML(
  item: any,
  isMulti: boolean,
  currentNorm: string,
  config: KanbanConfig,
  vaultName: string
): string {
  let display = item.item.text;
  display = display.replace(/\s*%%[\s\S]*?%%/g, "").replace(/\s*✅\d{4}-\d{2}-\d{2}/, "").trim();
  const tagToRemove = extractTags(display).find(
    (t: string) => normalizeTag(t) === currentNorm
  );
  if (tagToRemove)
    display = display
      .split(/\s+/)
      .filter((w: string) => w !== tagToRemove)
      .join(" ")
      .trim();

  const rawText = display
    .replace(/^- \[[ xX]\] /, "")
    .replace(/^[-*+]\s+/, "")
    .trim();
  const mainContent = linksToHtml(formatCardDateAnnotation(formatTriggerAnnotations(rawText, config.normRecurrent)), vaultName);

  const hasSubs = item.item.subs.length > 0; // structural (any subs at all, for expand/collapse)
  const isExpanded = item.state === "expanded";

  // Only checkbox items (- [ ] or - [x]) are tasks; plain bullet points are not.
  function isCheckboxItem(s: any): boolean {
    return /^[-*+]\s+\[[ xX]\]/.test((s.text ?? "").trim());
  }
  function isCheckedItem(s: any): boolean {
    return /^[-*+]\s+\[[xX]\]/.test((s.text ?? "").trim());
  }
  // Any checkbox descendant (checked or unchecked).
  function hasAnyCheckbox(subs: any[]): boolean {
    for (const s of subs ?? []) {
      if (isCheckboxItem(s)) return true;
      if (s.subs?.length && hasAnyCheckbox(s.subs)) return true;
    }
    return false;
  }
  // Any unchecked checkbox descendant.
  function hasUnchecked(subs: any[]): boolean {
    for (const s of subs ?? []) {
      if (isCheckboxItem(s) && !isCheckedItem(s)) return true;
      if (s.subs?.length && hasUnchecked(s.subs)) return true;
    }
    return false;
  }
  // Any unchecked descendant that has a tag in the configured "active" column group.
  function hasActiveKanban(subs: any[]): boolean {
    for (const s of subs ?? []) {
      if (isCheckboxItem(s) && !isCheckedItem(s)) {
        const tags: string[] = s.tags ?? [];
        if (tags.some((t: string) => config.normActive.includes(normalizeTag(t)))) return true;
      }
      if (s.subs?.length && hasActiveKanban(s.subs)) return true;
    }
    return false;
  }
  // True when every unchecked descendant is tagged Later/Recurrent, or is itself
  // a descendant of a sub-task tagged Later/Recurrent (inheritedCovered).
  function allUncheckedInLaterOrRecurrent(subs: any[], inheritedCovered = false): boolean {
    for (const s of subs ?? []) {
      const tags: string[] = s.tags ?? [];
      const selfCovered = tags.some((t: string) => {
        const norm = normalizeTag(t);
        return norm === config.normLater || norm === config.normRecurrent;
      });
      const covered = inheritedCovered || selfCovered;
      if (isCheckboxItem(s) && !isCheckedItem(s) && !covered) return false;
      if (s.subs?.length && !allUncheckedInLaterOrRecurrent(s.subs, covered)) return false;
    }
    return true;
  }

  const hasCheckboxSubs = hasAnyCheckbox(item.item.subs);
  // Green: has checkboxes and all are checked.
  const allSubsChecked   = hasCheckboxSubs && !hasUnchecked(item.item.subs);
  // Red: only in project columns — has unchecked checkboxes, none in an active column, and not all deferred to Later/Recurrent.
  const isProjectColumn  = config.normProject.includes(currentNorm);
  const hasUnmanagedWork = isProjectColumn && hasCheckboxSubs && hasUnchecked(item.item.subs)
    && !hasActiveKanban(item.item.subs) && !allUncheckedInLaterOrRecurrent(item.item.subs);

  function renderSub(sub: any, depth: number): string {
    const parentTag =
      item.item.tags.find((t: string) => normalizeTag(t) === currentNorm) || "";
    const hasCheckbox = /^- \[[ xX]\] /.test(sub.text);
    const isChecked = /^- \[[xX]\] /.test(sub.text);
    const alreadyTagged = extractTags(sub.text).some((t: string) =>
      config.normKanban.includes(normalizeTag(t))
    );
    let subText = sub.text
      .replace(/\s*%%[\s\S]*?%%/g, "")
      .replace(/\s*✅\d{4}-\d{2}-\d{2}/, "")
      .trim()
      .split(/\s+/)
      .filter((w: string) => !(w.startsWith('#') && config.normKanban.includes(normalizeTag(w))))
      .join(" ")
      .trim();
    subText = formatCardDateAnnotation(formatTriggerAnnotations(subText, config.normRecurrent, false), true);
    const indent = "&nbsp;".repeat(depth * 3);
    const rendered = renderCheckbox(subText, {
      isSub: true,
      showCheckbox: hasCheckbox,
      vaultName,
      enablePromotion: hasCheckbox && !isChecked && !alreadyTagged,
      subLine: sub.line,
      parentTag,
      parentOrder: item.order,
    });
    return `<div style="margin:4px 0;line-height:1.5;">${indent}${rendered}</div>`;
  }

  function renderSubTree(subs: any[], depth = 0): string {
    return (subs || [])
      .map((sub: any) => renderSub(sub, depth) + renderSubTree(sub.subs, depth + 1))
      .join("");
  }

  const addSubBtnStyle = `width:24px;height:24px;border-radius:50%;border:1px solid var(--background-modifier-border);background:none;cursor:pointer;font-size:1.1em;line-height:1;display:inline-flex;align-items:center;justify-content:center;color:inherit;`;
  const addSubBtn = `<button class="kb-add-sub" style="${addSubBtnStyle}">+</button>`;

  const bodyHTML = hasSubs
    ? `<div style="position:relative;">
         <div class="card-title" style="padding:6px 32px 6px 0;font-weight:600;cursor:pointer;color:var(--kb-text);"
              onclick="this.closest('.kanban-card').querySelector('details').toggleAttribute('open')">
           ${mainContent}
           <span style="position:absolute;top:6px;right:8px;font-size:1.4em;color:var(--kb-accent);user-select:none;">${isExpanded ? "▲" : "▼"}</span>
         </div>
         <details ${isExpanded ? "open" : ""} style="margin:4px 0 0 0;">
           <summary style="display:none;"></summary>
           <div style="padding-left:8px;">${renderSubTree(item.item.subs)}</div>
           <div style="display:flex;justify-content:flex-end;margin-top:4px;">${addSubBtn}</div>
         </details>
       </div>`
    : `<div style="position:relative;">
         <div class="card-title" style="padding:6px 36px 6px 0;font-weight:600;color:var(--kb-text);">${mainContent}</div>
         <button class="kb-add-sub" style="${addSubBtnStyle}position:absolute;top:4px;right:0;">+</button>
       </div>`;

  const border = isMulti
    ? "background:var(--background-modifier-error-hover);border:1px solid var(--background-modifier-error);"
    : hasUnmanagedWork
      ? `border:2px solid var(--kb-children-done);background:color-mix(in srgb,var(--kb-children-done) 20%,var(--kb-card-bg));`
      : allSubsChecked
        ? `border:2px solid var(--kb-all-checked);background:color-mix(in srgb,var(--kb-all-checked) 20%,var(--kb-card-bg));`
        : "border:1px solid var(--background-modifier-border);";

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
    data-order="${item.order || ""}"
    data-digits="${item.digits || ""}"
    data-state="${item.state}"
    data-tags='${JSON.stringify(item.item.tags).replace(/'/g, "&#39;")}'
    data-subs='${JSON.stringify(item.item.subs.map((s: any) => ({ line: s.line, text: s.text, subs: s.subs || [] }))).replace(/'/g, "&#39;")}'
    data-is-promoted="${item.isPromoted || false}"
    style="padding:10px 14px;margin:8px 0;border-radius:10px;background:var(--kb-card-bg);color:var(--kb-text);
           box-shadow:0 2px 8px rgba(0,0,0,.12);${border};cursor:move;position:relative;">
    ${item.indent > 0 ? '<span class="demote-btn" style="position:absolute;top:4px;left:6px;font-size:0.75em;color:var(--kb-accent);line-height:1;cursor:pointer;">&#x25B6;</span>' : ''}
    ${bodyHTML}
    ${badge}
  </div>`;
}

// ─── BOARD BUILD ─────────────────────────────────────────────────────────────

function hexLuminance(hex: string): number {
  const clean = hex.replace(/^#/, "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  if (full.length !== 6) return 0.5;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function textOnBg(bgHex: string, lightText: string, darkText: string): string {
  return hexLuminance(bgHex) > 0.179 ? darkText : lightText;
}

function buildColorCSS(config: KanbanConfig): string {
  const cv = (val: string, fb: string) => (val && val.trim()) ? val.trim() : fb;
  const configuredDarkText = (config.colorText && config.colorText.trim()) ? config.colorText.trim() : "#1a1a1a";
  const overLimit = cv(config.colorColumnOverLimit, "#5c1a1a");
  const overText = textOnBg(overLimit, "#ffffff", configuredDarkText);
  // Per-column color only applies while that column is over its max card count —
  // it overrides the shared warning color for that specific column.
  const perColOverLimitRules = Object.entries(config.columnColors)
    .filter(([, c]) => c)
    .map(([norm, color]) => {
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
    :root{--kb-dialog-text:${cv(config.colorText,"var(--text-normal)")};--kb-dialog-muted:${cv(config.colorText,"var(--text-muted)")}}
    #kanban-wrapper{
      --kb-card-bg:${cv(config.colorCardBg,"var(--background-secondary)")};
      --kb-col-bg:${cv(config.colorColumnBg,"var(--background-secondary)")};
      --kb-text:${cv(config.colorText,"var(--text-normal)")};
      --kb-accent:${cv(config.colorAccent,"var(--interactive-accent)")};
      --kb-link:${cv(config.colorLink,"var(--text-accent)")};
      --kb-family-self:${config.colorFamilySelf};
      --kb-family-parent:${config.colorFamilyParent};
      --kb-family-sibling:${config.colorFamilySibling};
      --kb-children-done:${config.allChildrenDoneColor};
          --kb-all-checked:${config.allCheckedColor};
      --kb-date-color:${config.colorDate};
      --kb-date-font:${config.fontDate};
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

async function tagUntaggedRecurrentCards(app: App, paths: string[], config: KanbanConfig): Promise<void> {
  const annotationRe = new RegExp(`@${config.normRecurrent}\\b`, 'i');
  const listItemRe = /^(\s*)(?:[-*+]|\d+[.)]\s)/;
  for (const filePath of paths) {
    const tFile = app.vault.getAbstractFileByPath(filePath) as TFile | null;
    if (!tFile) continue;
    let raw: string;
    try { raw = await app.vault.read(tFile); } catch { continue; }
    const lines = raw.split('\n');
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      if (!annotationRe.test(lines[i])) continue;
      const tags = extractTags(lines[i]);
      if (tags.some((t: string) => config.normKanban.includes(normalizeTag(t)))) continue;
      // Skip if this line is a subtask of a parent that already has #recurrent
      const myIndent = (lines[i].match(/^(\s*)/) || [""])[0].length;
      if (myIndent > 0) {
        let skipLine = false;
        for (let j = i - 1; j >= 0; j--) {
          if (!listItemRe.test(lines[j])) continue;
          const parentIndent = (lines[j].match(/^(\s*)/) || [""])[0].length;
          if (parentIndent < myIndent) {
            const parentTags = extractTags(lines[j]);
            if (parentTags.some((t: string) => normalizeTag(t) === config.normRecurrent)) {
              skipLine = true;
            }
            break;
          }
        }
        if (skipLine) continue;
      }
      const parsed = parseTaskLine(lines[i]);
      parsed.tags.push(config.recurrentColumn);
      lines[i] = serializeTaskLine(parsed);
      // No-trigger cards would fire every day; skip today so they don't move immediately on creation.
      if (!hasValidTriggers(lines[i], config.normRecurrent)) {
        const n = new Date();
        const skipStr = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
        lines[i] = setSkipDate(lines[i], skipStr);
      }
      changed = true;
    }
    if (changed) await app.vault.modify(tFile, lines.join('\n'));
  }
}

// Scans every task line (cards and sub-items) for ones that were checked off
// directly in the document — not via the board UI — and swaps their kanban
// column tag for the done tag, so hand-edited files still land in #done.
async function moveCheckedCardsToDone(app: App, paths: string[], config: KanbanConfig): Promise<void> {
  if (!config.normDone) return;
  for (const filePath of paths) {
    const tFile = app.vault.getAbstractFileByPath(filePath) as TFile | null;
    if (!tFile) continue;
    let raw: string;
    try { raw = await app.vault.read(tFile); } catch { continue; }
    const lines = raw.split("\n");
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseTaskLine(lines[i]);
      if (parsed.checked !== true) continue;
      if (!parsed.tags.some((t) => matchesKanbanTag(t, config.normKanban))) continue;
      if (parsed.tags.some((t) => normalizeTag(t) === config.normDone)) continue;
      parsed.tags = parsed.tags.filter((t) => !matchesKanbanTag(t, config.normKanban));
      parsed.tags.push(config.doneColumn);
      if (!parsed.doneDate) {
        const n = new Date();
        parsed.doneDate = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`;
      }
      lines[i] = serializeTaskLine(parsed);
      changed = true;
    }
    if (changed) await app.vault.modify(tFile, lines.join("\n"));
  }
}

export const KANBAN_NARROW_BREAKPOINT = 700;

export function isNarrowLayout(width: number): boolean {
  const isPhone = /iPhone|iPod|(Android.*Mobile)/i.test(navigator.userAgent);
  return isPhone || width < KANBAN_NARROW_BREAKPOINT;
}

export async function buildBoard(
  app: App,
  containerEl: HTMLElement,
  config: KanbanConfig,
  savedActiveCol?: string | null
): Promise<void> {
  _dialogDoc = containerEl.ownerDocument;
  const vaultName = app.vault.getName();

  const paths = await getTargetFilePaths(app, config);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Step A: tag @recurrent cards that have no kanban tag yet → add #recurrent
  if (config.normRecurrent) {
    await tagUntaggedRecurrentCards(app, paths, config);
  }

  // Step A1: cards/sub-items checked off directly in the document → #done
  await moveCheckedCardsToDone(app, paths, config);

  let items = await collectItems(app, paths, config);

  // Auto-move past/undated #later items and triggered #later items → today column
  const todayStrLater = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const laterToMove = items.filter((i) => {
    if (!i.item.tags.some((t: string) => normalizeTag(t) === config.normLater)) return false;
    if (extractSkipDate(i.item.text) === todayStrLater) return false;
    if (!isLaterDueToday(i.item.text, today, config.normRecurrent)) return false;
    // Don't move undated+untriggered cards that hold children with scheduled dates
    const hasDate = !!parseCardDate(i.item.text);
    const hasTriggers = extractTriggerAnnotations(i.item.text, config.normRecurrent).some(isValidTriggerToken);
    if (!hasDate && !hasTriggers && hasDatedSub(i.item.subs)) return false;
    return true;
  });
  if (laterToMove.length) {
    for (const item of laterToMove)
      await moveToColumn(app, item.filePath, item.item.line, item.item.tags, config.todayColumn, false, config, null, null, null, null, true);
    items = await collectItems(app, paths, config);
  }

  // Step A2: add #today and remove date from dated subtasks of remaining #later cards
  {
    const remainingLater = items.filter(
      (i) => i.item.tags.some((t: string) => normalizeTag(t) === config.normLater)
    );
    let anyLaterSubTriggered = false;
    for (const i of remainingLater) {
      if (await triggerDatedLaterSubs(app, i.item.subs, i.filePath, config, today))
        anyLaterSubTriggered = true;
    }
    if (anyLaterSubTriggered) items = await collectItems(app, paths, config);
  }

  // Step B: move triggered #recurrent cards → today column
  if (config.normRecurrent) {
    const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    // A card with no trigger annotations fires every day; a card with triggers fires on matching days.
    const recurrentToMove = items.filter((i) => {
      if (!i.item.tags.some((t: string) => normalizeTag(t) === config.normRecurrent)) return false;
      if (!hasRecurrentAnnotation(i.item.text, config.normRecurrent)) return false;
      if (extractSkipDate(i.item.text) === todayStr) return false;
      const triggers = extractTriggerAnnotations(i.item.text, config.normRecurrent);
      if (triggers.length === 0) return !i.item.subs || i.item.subs.length === 0;
      return matchesTriggerAnnotations(triggers, today);
    });
    if (recurrentToMove.length) {
      for (const item of recurrentToMove)
        await moveToColumn(app, item.filePath, item.item.line, item.item.tags, config.todayColumn, false, config);
      items = await collectItems(app, paths, config);
    }
    // Step C: add #today to subtasks of #recurrent cards whose trigger fires today
    let anySubTriggered = false;
    for (const i of items) {
      if (!i.item.tags.some((t: string) => normalizeTag(t) === config.normRecurrent)) continue;
      if (await triggerRecurrentSubs(app, i.item.subs, i.filePath, config, today, todayStr))
        anySubTriggered = true;
    }
    if (anySubTriggered) items = await collectItems(app, paths, config);
  }

  const columns = groupByColumns(items, config);
  await assignInitialOrders(app, columns, config);

  // Date columns (later) sort by date: most recent first, undated cards last
  const laterColData = columns[config.normLater];
  if (laterColData) {
    laterColData.cards.sort((a: any, b: any) => {
      const da = parseCardDate(a.item.text);
      const db = parseCardDate(b.item.text);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da.getTime() - db.getTime();
    });
  }

  const boardDoc = containerEl.ownerDocument;
  let _colorCss = boardDoc.getElementById("kanban-color-vars");
  if (!_colorCss) { _colorCss = boardDoc.createElement("style"); _colorCss.id = "kanban-color-vars"; boardDoc.head.appendChild(_colorCss); }
  (_colorCss as HTMLStyleElement).textContent = buildColorCSS(config);

  // Static styles — updated only on board build
  let _css = boardDoc.getElementById("kanban-board-styles");
  if (!_css) { _css = boardDoc.createElement("style"); _css.id = "kanban-board-styles"; boardDoc.head.appendChild(_css); }
  (_css as HTMLStyleElement).textContent = `
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

  // Build DOM
  const wrapper = containerEl.createEl("div", {
    attr: { id: "kanban-wrapper" },
  });
  const scroll = wrapper.createEl("div", {
    attr: {
      id: "kanban-scroll",
      style:
        "display:flex;overflow-x:auto;gap:0;padding:12px 0;-webkit-overflow-scrolling:touch;",
    },
  });

  const isNarrow = isNarrowLayout(
    wrapper.clientWidth > 0 ? wrapper.clientWidth : window.innerWidth
  );
  wrapper.dataset.narrow = isNarrow ? "1" : "0";

  const allNorms = Object.keys(columns);
  let activeNorm = (savedActiveCol && allNorms.includes(savedActiveCol)) ? savedActiveCol : config.normToday;

  if (isNarrow) {
    const tabBar = scroll.createEl("div", {
      attr: {
        style:
          "display:flex;gap:6px;flex-wrap:wrap;padding:4px 8px 14px;width:100%;box-sizing:border-box;touch-action:none;",
      },
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
            transition:transform .1s,outline .1s;touch-action:none;`,
        },
      });
      (tab as HTMLButtonElement).dataset.colNorm = norm;
      (tab as HTMLButtonElement).dataset.colActive = isActive ? "1" : "0";
      const tabMax = config.columnMaxCards[norm] || 0;
      if (tabMax > 0 && col.cards.length > tabMax) {
        (tab as HTMLButtonElement).dataset.colOverlimit = "1";
      }
    }
  }

  const colKeys = isNarrow ? [activeNorm] : allNorms;

  for (const norm of colKeys) {
    const col = columns[norm];
    if (!col) continue;

    const colStyle = isNarrow
      ? `width:calc(100% - 16px);margin:0 8px 20px;padding:10px;`
      : `flex:1;min-width:200px;max-width:260px;padding:10px 0 10px 0;margin:0;display:flex;flex-direction:column;`;
    const colMax = config.columnMaxCards[norm] || 0;
    const colAttr: Record<string, string> = { style: colStyle, "data-col-container": norm };
    if (colMax > 0 && col.cards.length > colMax) colAttr["data-col-overlimit"] = "1";
    const colDiv = scroll.createEl("div", { attr: colAttr });

    const header = colDiv.createEl("div", {
      attr: { style: "display:flex;align-items:center;margin-bottom:10px;padding:0 4px;" },
    });
    header.createEl("h4", {
      text: col.rawTag.replace(/^#/, "").toUpperCase(),
      attr: { style: "margin:0;flex-grow:1;font-weight:bold;color:var(--kb-text);" },
    });
    header.createEl("span", {
      text: String(col.cards.length),
      attr: { class: "kb-col-count", style: "margin-right:6px;font-size:.75em;color:var(--kb-text);background:transparent;border:1px solid var(--background-modifier-border);border-radius:50%;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;" },
    });

    if (norm !== config.normDone) {
      const btn = header.createEl("button", {
        text: "+",
        attr: {
          class: "kb-col-add-btn",
          style:
            "width:24px;height:24px;border-radius:50%;border:1px solid var(--background-modifier-border);background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--kb-text);",
        },
      });
      (btn as HTMLButtonElement).dataset.column = norm;
      (btn as HTMLButtonElement).dataset.tag = col.rawTag;
    } else {
      const btn = header.createEl("button", {
        text: "Archive",
        attr: {
          class: "kb-col-add-btn",
          style:
            "height:24px;padding:0 8px;border-radius:12px;border:1px solid var(--background-modifier-border);background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.75em;color:var(--kb-text);",
        },
      });
      (btn as HTMLButtonElement).dataset.column = norm;
    }

    const zone = colDiv.createEl("div", {
      attr: {
        class: `drop-zone drop-zone-${norm}`,
        style:
          "min-height:200px;border:2px dashed var(--background-modifier-border);border-right:none;border-radius:0;padding:5px;flex-grow:1;display:flex;flex-direction:column;",
      },
    });

    const insertSlot = (idx: number) => {
      const s = boardDoc.createElement("div");
      s.className = "insert-slot";
      s.style.cssText = "height:0;border-top:2px dashed transparent;width:100%";
      s.dataset.index = String(idx);
      return s;
    };

    if (col.cards.length > 0) zone.appendChild(insertSlot(0));
    col.cards.forEach((card: any, i: number) => {
      zone.innerHTML += createCardHTML(card, card.multiTag, norm, config, vaultName);
      if (i < col.cards.length - 1) zone.appendChild(insertSlot(i + 1));
    });
    zone.appendChild(insertSlot(col.cards.length));
  }

  wrapper.createEl("p", {
    attr: {
      id: "kanban-status",
      style:
        "margin-top:20px;text-align:center;color:var(--text-muted);font-size:.9em;",
    },
    text: `Found: ${items.length} items`,
  });
}

// ─── EVENT LISTENERS ──────────────────────────────────────────────────────────

// Returns a cleanup function that removes all listeners added here.
export function attachListeners(
  boardEl: HTMLElement,
  config: KanbanConfig,
  app: App,
  refresh: () => void
): () => void {
  const ownerDoc = () => boardEl.ownerDocument;
  let draggedCard: any = null;
  let currentInsertIndex = -1;

  // ── Helpers ──
  const cardDataFrom = (el: Element | null) => {
    const c = el?.closest(".kanban-card") as HTMLElement | null;
    if (!c) return null;
    return {
      filePath: c.dataset.file!,
      lineNum: parseInt(c.dataset.line!, 10),
      originalTags: JSON.parse(c.dataset.tags!),
      order: parseFloat(c.dataset.order!) || null,
      state: c.dataset.state!,
      isPromoted: c.dataset.isPromoted === "true",
      subs: c.dataset.subs ? JSON.parse(c.dataset.subs) as any[] : [],
      rawText: c.dataset.raw || "",
    };
  };

  const siblingDataFrom = (zone: HTMLElement): SiblingData[] =>
    Array.from(zone.querySelectorAll(".kanban-card")).map((c: any) => {
      const ord = c.dataset.order;
      if (!ord) return { order: 999, digits: "99999", len: 5 };
      const dec = ord.split(".")[1] || "0";
      return { order: parseFloat(ord), digits: dec, len: dec.length };
    }).sort((a, b) => a.order - b.order);

  const highlightNearestSlot = (zone: HTMLElement, clientY: number) => {
    const rect = zone.getBoundingClientRect();
    const y = clientY - rect.top;
    let nearest: HTMLElement | null = null,
      minDist = Infinity;
    zone.querySelectorAll<HTMLElement>(".insert-slot").forEach((slot) => {
      const sr = slot.getBoundingClientRect();
      const dist = Math.abs(sr.top + sr.height / 2 - rect.top - y);
      if (dist < minDist) {
        minDist = dist;
        nearest = slot;
      }
    });
    document.querySelectorAll<HTMLElement>(".insert-slot").forEach(
      (s) => (s.style.borderTopColor = "transparent")
    );
    if (nearest) {
      (nearest as HTMLElement).style.borderTopColor = "var(--kb-accent)";
      currentInsertIndex = parseInt((nearest as HTMLElement).dataset.index!, 10);
    }
  };

  const resolveTargetNorm = (zone: HTMLElement): string | null => {
    const m = zone.className.match(/drop-zone-([\w-]+)/);
    return m ? m[1] : null;
  };

  // ── Card relationship highlighting ──
  const clearHighlights = () => {
    boardEl.querySelectorAll<HTMLElement>(".kanban-card").forEach((c) =>
      c.classList.remove("kh-self", "kh-parent", "kh-sibling")
    );
  };

  const subsHasLine = (subs: any[], line: number): boolean =>
    subs.some((s: any) => s.line === line);

  // Recurses into nested subs so ancestry/family checks can cross multiple
  // levels of outline nesting (e.g. project → phase → task), not just the
  // immediate level — intermediate outline levels often have no kanban tag
  // and thus no card of their own to "hop through".
  const subsHasLineDeep = (subs: any[], line: number): boolean =>
    subs.some((s: any) => s.line === line || subsHasLineDeep(s.subs || [], line));

  const applyHighlights = (card: HTMLElement) => {
    clearHighlights();
    const file = card.dataset.file!;
    const allCards = Array.from(boardEl.querySelectorAll<HTMLElement>(".kanban-card"));

    // Walk up to find the top-most ancestor
    let topParent = card;
    for (let safety = 0; safety < 20; safety++) {
      const tpLine = parseInt(topParent.dataset.line!, 10);
      const parent = allCards.find(
        (o) => o !== topParent && o.dataset.file === file &&
          subsHasLineDeep(JSON.parse(o.dataset.subs || "[]"), tpLine)
      );
      if (!parent) break;
      topParent = parent;
    }

    // BFS: collect every card reachable downward from the top parent
    const family = new Set<HTMLElement>([topParent]);
    const queue: HTMLElement[] = [topParent];
    while (queue.length) {
      const curr = queue.shift()!;
      const subs = JSON.parse(curr.dataset.subs || "[]");
      for (const other of allCards) {
        if (family.has(other) || other.dataset.file !== file) continue;
        if (subsHasLineDeep(subs, parseInt(other.dataset.line!, 10))) {
          family.add(other);
          queue.push(other);
        }
      }
    }

    // Direct children of the hovered card
    const ownSubs = JSON.parse(card.dataset.subs || "[]");
    const children = new Set<HTMLElement>(
      allCards.filter(
        (o) => o !== card && o.dataset.file === file &&
          subsHasLine(ownSubs, parseInt(o.dataset.line!, 10))
      )
    );

    // No family: standalone card — skip coloring entirely
    if (family.size === 1 && topParent === card) return;

    // Colour: top parent → red, direct children → blue, everything else in family → green
    topParent.classList.add("kh-self");
    for (const member of family) {
      if (member === topParent) continue;
      member.classList.add(children.has(member) ? "kh-sibling" : "kh-parent");
    }
  };

  function onMouseOver(e: MouseEvent) {
    const card = (e.target as Element).closest(".kanban-card") as HTMLElement | null;
    if (!card) return;
    if (!card.classList.contains("kh-self")) applyHighlights(card);
  }

  function onMouseOut(e: MouseEvent) {
    const toEl = e.relatedTarget as Element | null;
    if (!toEl?.closest(".kanban-card")) clearHighlights();
  }

  function onCardClick(e: MouseEvent) {
    const card = (e.target as Element).closest(".kanban-card") as HTMLElement | null;
    if (!card) return;
    applyHighlights(card);
  }

  async function doMove(
    card: ReturnType<typeof cardDataFrom>,
    targetNorm: string,
    zone: HTMLElement | null
  ) {
    if (!card) return;
    const targetTag = config.kanban.find(
      (t) => normalizeTag(t) === targetNorm
    );
    if (!targetTag) return;

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
    const newState: "expanded" | "collapsed" = "collapsed";
    const siblings = zone ? siblingDataFrom(zone) : [];
    const insertIdx = (zone && currentInsertIndex >= 0) ? currentInsertIndex : siblings.length;
    const isMulti = card.originalTags
      .map(normalizeTag)
      .filter((t: string) => config.normKanban.includes(t)).length > 1;
    const newCalc = calcInsertOrder(siblings, insertIdx, isMulti);
    const colTitle = targetTag
      .replace(/^#/, "")
      .replace(/\b\w/g, (l: string) => l.toUpperCase());

    if (config.normRecurrent && targetNorm === config.normRecurrent) {
      const { lines } = await readFileLines(app, card.filePath);
      const lineTxt = lines[card.lineNum - 1] || "";
      if (!hasValidTriggers(lineTxt, config.normRecurrent)) {
        showRecurrentTriggerDialog(async (trigger) => {
          await moveToColumn(app, card.filePath, card.lineNum, card.originalTags, targetTag, false, config, null, newCalc.digits, newState, trigger);
          requestAnimationFrame(() => setTimeout(refresh, 50));
        });
        return;
      }
      const ok = await moveToColumn(app, card.filePath, card.lineNum, card.originalTags, targetTag, false, config, null, newCalc.digits, newState);
      if (ok) requestAnimationFrame(() => setTimeout(refresh, 50));
    } else if (targetNorm === config.normLater) {
      const { lines } = await readFileLines(app, card.filePath);
      const lineTxt = lines[card.lineNum - 1] || "";
      const dateMatch = lineTxt
        .replace(/%%[\s\S]*?@\s*\d+\s*[cx]\s*%%/g, "")
        .trim()
        .match(/@(\d{4}-\d{2}-\d{2})/);
      const existing = dateMatch
        ? new Date(dateMatch[1] + "T00:00:00")
        : null;
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
        newState
      );
      if (ok) requestAnimationFrame(() => setTimeout(refresh, 50));
    }
    currentInsertIndex = -1;
  }

  // ── Sub-item checkbox toggle ──
  async function onSubCheckClick(e: Event) {
    const cb = (e.target as Element).closest(".kb-sub-check") as HTMLInputElement | null;
    if (!cb) return;
    e.stopPropagation();
    const card = cb.closest(".kanban-card") as HTMLElement | null;
    if (!card) return;
    const filePath = card.dataset.file!;
    const subLineNum = parseInt(cb.dataset.subLine!, 10);
    if (!filePath || isNaN(subLineNum) || subLineNum < 1) return;
    const { tFile, lines } = await readFileLines(app, filePath);
    if (subLineNum > lines.length) return;
    const parsed = parseTaskLine(lines[subLineNum - 1]);
    if (parsed.checked === null) return;
    parsed.checked = !parsed.checked;
    if (parsed.checked) {
      const n = new Date();
      parsed.doneDate = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`;
    } else {
      parsed.doneDate = null;
    }
    lines[subLineNum - 1] = serializeTaskLine(parsed);
    await writeFileLines(app, tFile, lines);
    refresh();
  }

  // ── Add subtask button ──
  async function onAddSubClick(e: Event) {
    const btn = (e.target as Element).closest(".kb-add-sub") as HTMLElement | null;
    if (!btn) return;
    e.stopPropagation();
    const card = btn.closest(".kanban-card") as HTMLElement | null;
    if (!card) return;

    const filePath = card.dataset.file!;
    const cardLine = parseInt(card.dataset.line!, 10);
    const afterLine = parseInt(card.dataset.lastSubLine!, 10);
    const tags: string[] = JSON.parse(card.dataset.tags || "[]");
    const normTags = tags.map(normalizeTag);
    const isLater = normTags.some(t => t === config.normLater);
    const isRecurrent = !!(config.normRecurrent && normTags.some(t => t === config.normRecurrent));

    const doAdd = async (text: string) => {
      if (await addSubtaskToCard(app, filePath, afterLine, cardLine, text))
        requestAnimationFrame(() => setTimeout(refresh, 50));
    };

    showSubtaskDialog(async (text) => {
      if (isLater) {
        const defDate = getDefaultDate().toISOString().split("T")[0];
        showDateDialog("Set date for subtask", defDate, async (dateStr) => {
          await doAdd(dateStr ? `${text} ${dateStr}` : text);
        });
      } else if (isRecurrent) {
        showRecurrentTriggerDialog(async (triggerStr) => {
          const n = new Date();
          const skipStr = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
          const triggerPart = triggerStr ? ` ${triggerStr}` : '';
          await doAdd(`${text} @${config.normRecurrent}${triggerPart} %% @skip:${skipStr} %%`);
        });
      } else {
        await doAdd(text);
      }
    });
  }

  // ── Promote icon ──
  async function onPromoteClick(e: Event) {
    const icon = (e.target as Element).closest(".promote-icon") as HTMLElement | null;
    if (!icon) return;
    e.stopPropagation();
    const card = icon.closest(".kanban-card") as HTMLElement | null;
    if (!card) return;
    await promoteSubToChild(
      app,
      card.dataset.file!,
      parseInt(icon.dataset.line!, 10),
      icon.dataset.parentTag!,
      parseFloat(icon.dataset.parentOrder!) || 0,
      config,
      refresh
    );
  }

  async function onDemoteClick(e: Event) {
    const btn = (e.target as Element).closest(".demote-btn") as HTMLElement | null;
    if (!btn) return;
    e.stopPropagation();
    const card = btn.closest(".kanban-card") as HTMLElement | null;
    if (!card) return;
    const filePath = card.dataset.file!;
    const lineNum = parseInt(card.dataset.line!, 10);
    const { tFile, lines } = await readFileLines(app, filePath);
    if (lineNum < 1 || lineNum > lines.length) return;
    const parsed = parseTaskLine(lines[lineNum - 1]);
    parsed.tags = parsed.tags.filter((t) => !config.normKanban.includes(normalizeTag(t)));
    lines[lineNum - 1] = serializeTaskLine(parsed);
    if (config.normRecurrent && hasRecurrentAnnotation(lines[lineNum - 1], config.normRecurrent)) {
      // Unpromoted recurrent subtasks would otherwise re-trigger immediately
      // if their trigger still matches today; skip today to prevent that.
      const n = new Date();
      const skipStr = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
      lines[lineNum - 1] = setSkipDate(lines[lineNum - 1], skipStr);
    }
    await writeFileLines(app, tFile, lines);
    refresh();
  }

  // ── Clickable date label on later cards ──
  async function onDateLabelClick(e: MouseEvent) {
    const span = (e.target as Element).closest(".kb-date-label") as HTMLElement | null;
    if (!span) return;
    e.stopPropagation();
    const card = span.closest(".kanban-card") as HTMLElement | null;
    if (!card) return;
    const currentDateStr = span.dataset.date || "";
    const existing = currentDateStr ? new Date(currentDateStr + "T00:00:00") : null;
    const defDate = (existing && !isNaN(existing.getTime()) ? existing : getDefaultDate()).toISOString().split("T")[0];
    showDateDialog("Change date", defDate, async (dateStr) => {
      await updateCardDate(app, card.dataset.file!, parseInt(card.dataset.line!, 10), dateStr);
      requestAnimationFrame(() => setTimeout(refresh, 50));
    });
  }

  // ── Clickable trigger label on recurrent cards ──
  async function onTriggerLabelClick(e: MouseEvent) {
    const span = (e.target as Element).closest(".kb-trigger-label") as HTMLElement | null;
    if (!span) return;
    e.stopPropagation();
    const card = span.closest(".kanban-card") as HTMLElement | null;
    if (!card) return;
    const rawText = card.dataset.raw || "";
    const existing = extractTriggerAnnotations(rawText, config.normRecurrent);
    showRecurrentTriggerDialog(async (newTriggerStr) => {
      await updateCardTriggers(app, card.dataset.file!, parseInt(card.dataset.line!, 10), config.normRecurrent, newTriggerStr);
      requestAnimationFrame(() => setTimeout(refresh, 50));
    }, existing);
  }

  // ── Inline card text editing ──
  async function onDblClick(e: MouseEvent) {
    if ((e.target as Element).closest("a,button,.promote-icon,.demote-btn,.kb-date-label,.kb-trigger-label")) return;
    const titleDiv = (e.target as Element).closest(".card-title") as HTMLElement | null;
    if (!titleDiv) return;
    const card = titleDiv.closest(".kanban-card") as HTMLElement | null;
    if (!card) return;
    if (titleDiv.querySelector(".card-edit-input")) return;

    const raw = card.dataset.raw || "";
    const filePath = card.dataset.file!;
    const lineNum = parseInt(card.dataset.line!, 10);

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

    const arrow = titleDiv.querySelector<HTMLElement>("span[style*='position:absolute']");
    titleDiv.innerHTML = "";
    titleDiv.appendChild(input);
    if (arrow) titleDiv.appendChild(arrow);
    titleDiv.onclick = null;

    const finishEdit = async (save: boolean) => {
      if (!titleDiv.contains(input)) return;
      const newText = input.value.trim();
      if (card.querySelector("details")) {
        titleDiv.onclick = function () {
          (this as HTMLElement).closest(".kanban-card")
            ?.querySelector("details")
            ?.toggleAttribute("open");
        };
      }
      if (save && newText && newText !== raw) {
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
      if (e.key === "Escape") await finishEdit(false);
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

  // ── Details toggle → save state ──
  async function onToggle(e: Event) {
    const details = e.target as HTMLDetailsElement;
    if (details.tagName !== "DETAILS") return;
    const card = details.closest(".kanban-card") as HTMLElement | null;
    if (!card) return;
    const newState: "expanded" | "collapsed" = details.open
      ? "expanded"
      : "collapsed";
    await updateFileOrderComment(
      app,
      card.dataset.file!,
      parseInt(card.dataset.line!, 10),
      card.dataset.digits || "00000",
      newState
    );
    card.dataset.state = newState;
  }

  // ── Touch interaction ──
  let touchCard: HTMLElement | null = null;
  let ghost: HTMLElement | null = null;
  let isTouchDrag = false;
  let touchTimer: ReturnType<typeof setTimeout> | null = null;
  let selectedCard: HTMLElement | null = null;
  let colPickerOverlay: HTMLElement | null = null;
  const HOLD_DELAY = 450,
    DRAG_DELAY = 450,
    MOVE_THRESHOLD = 8;
  let touchStartX = 0,
    touchStartY = 0;
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
    boardEl.querySelectorAll<HTMLElement>("[data-col-norm]").forEach((t) => {
      t.style.outline = "";
      t.style.transform = "";
      t.style.background = "";  // clear inline; CSS rules take over
    });
  };

  const showColumnPicker = (savedCard: ReturnType<typeof cardDataFrom>) => {
    closeColPicker();
    const doc = ownerDoc();
    const overlay = doc.createElement("div");
    overlay.id = "kanban-col-picker";
    overlay.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:flex-end;justify-content:center;";
    doc.body.appendChild(overlay);
    colPickerOverlay = overlay;

    const sheet = doc.createElement("div");
    sheet.style.cssText =
      "background:var(--background-primary);color:var(--text-normal);padding:16px 16px 32px;border-radius:16px 16px 0 0;width:100%;max-width:480px;box-shadow:0 -4px 24px rgba(0,0,0,.2);";
    overlay.appendChild(sheet);

    const title = doc.createElement("p");
    title.textContent = "Move to column";
    title.style.cssText = "margin:0 0 14px;font-size:.9em;font-weight:600;text-align:center;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;";
    sheet.appendChild(title);

    const list = doc.createElement("div");
    list.style.cssText = "display:flex;flex-direction:column;gap:8px;";
    sheet.appendChild(list);

    // Derive column list from DOM tab buttons
    const tabs = Array.from(boardEl.querySelectorAll<HTMLElement>("[data-col-norm]"));
    for (const tab of tabs) {
      const norm = tab.dataset.colNorm!;
      const label = tab.textContent || norm.toUpperCase();
      const cc = (config.columnColors as Record<string, string> | undefined)?.[norm] || "";
      const btn = doc.createElement("button");
      btn.textContent = label;
      btn.style.cssText =
        `padding:14px 16px;border-radius:10px;border:1px solid var(--background-modifier-border);` +
        `background:${cc ? `color-mix(in srgb,${cc} 20%,var(--background-secondary))` : "var(--background-secondary)"};` +
        `color:var(--text-normal);font-size:1em;cursor:pointer;text-align:left;font-weight:500;`;
      btn.addEventListener("click", async () => {
        closeColPicker();
        clearSelection();
        touchCard = null;
        currentInsertIndex = -1;
        await doMove(savedCard, norm, null);
      });
      list.appendChild(btn);
    }

    const cancelBtn = doc.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText =
      "margin-top:12px;padding:14px;border-radius:10px;border:1px solid var(--background-modifier-border);background:none;color:var(--text-muted);width:100%;cursor:pointer;font-size:1em;";
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
    if (touchTimer) clearTimeout(touchTimer);
    isTouchDrag = false;
    isPanning = false;
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    boardEl.querySelectorAll<HTMLElement>(".kanban-card").forEach(
      (c) => (c.style.opacity = "1")
    );
    boardEl.querySelectorAll<HTMLElement>(".drop-zone").forEach(
      (z) => (z.style.borderColor = "var(--background-modifier-border)")
    );
    boardEl.querySelectorAll<HTMLElement>(".insert-slot").forEach(
      (s) => (s.style.borderTopColor = "transparent")
    );
    clearSelection();
    touchCard = null;
    draggedCard = null;
    currentInsertIndex = -1;
  };

  const collapseCardEl = (el: HTMLElement) => {
    el.querySelector("details")?.removeAttribute("open");
    const titleSpan = el.querySelector<HTMLElement>(".card-title span");
    if (titleSpan) titleSpan.textContent = "▼";
  };

  const makeGhost = (card: HTMLElement) => {
    const rect = card.getBoundingClientRect();
    const g = card.cloneNode(true) as HTMLElement;
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
      transition: "none",
    });
    ownerDoc().body.appendChild(g);
    return g;
  };

  const targetFromPoint = (x: number, y: number) => {
    if (ghost) ghost.style.display = "none";
    const el = ownerDoc().elementFromPoint(x, y);
    if (ghost) ghost.style.display = "";
    return {
      zone: el?.closest(".drop-zone") as HTMLElement | null,
      tabNorm:
        (el?.closest("[data-col-norm]") as HTMLElement | null)?.dataset
          .colNorm ?? null,
    };
  };

  function onTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) {
      clearTouch();
      return;
    }
    if (boardEl.querySelector(".card-edit-input")) return;
    if ((e.target as Element).closest("button,a,input,textarea,.promote-icon,.demote-btn")) return;

    const card = (e.target as Element).closest(".kanban-card") as HTMLElement | null;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;

    if (isNarrowNow()) {
      const tappedTab = (e.target as Element).closest("[data-col-norm]");
      if (tappedTab && selectedCard) return;
      if (!card && selectedCard) {
        clearSelection();
        return;
      }
      if (!card) return;

      clearSelection();
      touchCard = card;
      draggedCard = cardDataFrom(card);
      touchTimer = setTimeout(() => {
        if (!selectedCard) {
          selectedCard = card;
          card.style.outline = "2px solid var(--kb-accent)";
          card.style.transform = "scale(1.02)";
          showColumnPicker(draggedCard);
        }
      }, HOLD_DELAY);
    } else {
      if (!card) {
        isPanning = true;
        panStartX = e.touches[0].clientX;
        panStartY = e.touches[0].clientY;
        const scrollEl = ownerDoc().getElementById("kanban-scroll");
        panScrollStart = scrollEl ? scrollEl.scrollLeft : 0;
        const vertEl = boardEl.closest<HTMLElement>(".view-content") ?? ownerDoc().documentElement;
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
  }

  function onTouchMove(e: TouchEvent) {
    if (isPanning && e.touches.length === 1) {
      const t = e.touches[0];
      const scrollEl = ownerDoc().getElementById("kanban-scroll");
      if (scrollEl) scrollEl.scrollLeft = panScrollStart - (t.clientX - panStartX);
      const vertEl = boardEl.closest<HTMLElement>(".view-content") ?? ownerDoc().documentElement;
      vertEl.scrollTop = panScrollTopStart - (t.clientY - panStartY);
      e.preventDefault();
      return;
    }
    if (!touchCard || e.touches.length !== 1) return;
    const { clientX, clientY } = e.touches[0];
    const dx = Math.abs(clientX - touchStartX);
    const dy = Math.abs(clientY - touchStartY);

    if (isNarrowNow()) {
      if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) {
        if (touchTimer) clearTimeout(touchTimer);
        if (!selectedCard) {
          touchCard = null;
          draggedCard = null;
        }
      }
      if (selectedCard && isTouchDrag) {
        if (ghost) {
          ghost.style.left = clientX - ghost.offsetWidth / 2 + "px";
          ghost.style.top = clientY - ghost.offsetHeight / 2 - 20 + "px";
        }
        const { zone } = targetFromPoint(clientX, clientY);
        boardEl.querySelectorAll<HTMLElement>(".drop-zone").forEach(
          (z) => (z.style.borderColor = "var(--background-modifier-border)")
        );
        if (zone) {
          zone.style.borderColor = "var(--kb-accent)";
          highlightNearestSlot(zone, clientY);
        }
        e.preventDefault();
      }
      return;
    }

    if (!isTouchDrag) {
      if (dy > dx * 2 && dy > MOVE_THRESHOLD) {
        clearTouch();
        return;
      }
      if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) {
        if (touchTimer) clearTimeout(touchTimer);
        isTouchDrag = true;
        if (!ghost) ghost = makeGhost(touchCard);
        collapseCardEl(touchCard);
        touchCard.style.opacity = ".35";
      }
    }
    if (!isTouchDrag) return;

    ghost!.style.left = clientX - ghost!.offsetWidth / 2 + "px";
    ghost!.style.top = clientY - ghost!.offsetHeight / 2 - 20 + "px";

    const { zone, tabNorm } = targetFromPoint(clientX, clientY);
    boardEl.querySelectorAll<HTMLElement>(".drop-zone").forEach(
      (z) => (z.style.borderColor = "var(--background-modifier-border)")
    );
    boardEl.querySelectorAll<HTMLElement>("[data-col-norm]").forEach((t) => {
      t.style.outline = "";
      t.style.transform = "";
    });
    if (zone) {
      zone.style.borderColor = "var(--kb-accent)";
      highlightNearestSlot(zone, clientY);
    } else if (tabNorm) {
      const tab = boardEl.querySelector<HTMLElement>(
        `[data-col-norm="${tabNorm}"]`
      );
      if (tab) {
        tab.style.outline = "2px solid var(--kb-accent)";
        tab.style.transform = "scale(1.08)";
      }
    }
    e.preventDefault();
  }

  async function onTouchEnd(e: TouchEvent) {
    if (touchTimer) clearTimeout(touchTimer);

    if (isPanning) {
      isPanning = false;
      return;
    }

    const { clientX, clientY } = e.changedTouches[0];

    if (isNarrowNow()) {
      // If the column picker dialog is open, the finger lift is the end of the
      // hold gesture — leave the dialog alone, it manages its own lifecycle.
      if (colPickerOverlay) {
        touchCard = null;
        return;
      }

      touchCard = null;
      return;
    }

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

  // ── Mouse drag (desktop) ──
  let mouseCard: HTMLElement | null = null;
  let isMouseDrag = false;
  let mouseStartX = 0, mouseStartY = 0;

  const clearMouseDrag = () => {
    isMouseDrag = false;
    if (ghost) { ghost.remove(); ghost = null; }
    if (mouseCard) { mouseCard.style.opacity = "1"; mouseCard = null; }
    draggedCard = null;
    ownerDoc().body.style.userSelect = "";
    boardEl.querySelectorAll<HTMLElement>(".drop-zone").forEach(
      (z) => (z.style.borderColor = "var(--background-modifier-border)")
    );
    boardEl.querySelectorAll<HTMLElement>(".insert-slot").forEach(
      (s) => (s.style.borderTopColor = "transparent")
    );
    currentInsertIndex = -1;
    ownerDoc().removeEventListener("mousemove", onMouseMove);
    ownerDoc().removeEventListener("mouseup", onMouseUp);
  };

  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    if (boardEl.querySelector(".card-edit-input")) return;
    if ((e.target as Element).closest("button,a,input,.promote-icon,.demote-btn")) return;
    const card = (e.target as Element).closest(".kanban-card") as HTMLElement | null;
    if (!card) return;
    mouseCard = card;
    draggedCard = cardDataFrom(card);
    mouseStartX = e.clientX;
    mouseStartY = e.clientY;
    ownerDoc().addEventListener("mousemove", onMouseMove);
    ownerDoc().addEventListener("mouseup", onMouseUp);
  }

  function onMouseMove(e: MouseEvent) {
    if (!mouseCard) return;
    const dx = Math.abs(e.clientX - mouseStartX);
    const dy = Math.abs(e.clientY - mouseStartY);
    if (!isMouseDrag) {
      if (dx < MOVE_THRESHOLD && dy < MOVE_THRESHOLD) return;
      isMouseDrag = true;
      ghost = makeGhost(mouseCard);
      collapseCardEl(mouseCard);
      mouseCard.style.opacity = ".35";
      ownerDoc().body.style.userSelect = "none";
    }
    ghost!.style.left = e.clientX - ghost!.offsetWidth / 2 + "px";
    ghost!.style.top = e.clientY - ghost!.offsetHeight / 2 - 20 + "px";

    const { zone, tabNorm } = targetFromPoint(e.clientX, e.clientY);
    boardEl.querySelectorAll<HTMLElement>(".drop-zone").forEach(
      (z) => (z.style.borderColor = "var(--background-modifier-border)")
    );
    boardEl.querySelectorAll<HTMLElement>("[data-col-norm]").forEach((t) => {
      t.style.outline = "";
      t.style.transform = "";
    });
    if (zone) {
      zone.style.borderColor = "var(--kb-accent)";
      highlightNearestSlot(zone, e.clientY);
    } else if (tabNorm) {
      const tab = boardEl.querySelector<HTMLElement>(`[data-col-norm="${tabNorm}"]`);
      if (tab) {
        tab.style.outline = "2px solid var(--kb-accent)";
        tab.style.transform = "scale(1.08)";
      }
    }
  }

  async function onMouseUp(e: MouseEvent) {
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

  // ── Middle-button pan (scroll-wheel click on Mac) ──
  let isMidPan = false;
  let midPanStartX = 0;
  let midPanStartY = 0;
  let midPanScrollLeft = 0;
  let midPanScrollTop = 0;

  function onMidMouseDown(e: MouseEvent) {
    if (e.button !== 1) return;
    e.preventDefault();
    isMidPan = true;
    midPanStartX = e.clientX;
    midPanStartY = e.clientY;
    const scrollEl = ownerDoc().getElementById("kanban-scroll");
    midPanScrollLeft = scrollEl ? scrollEl.scrollLeft : 0;
    const vertEl = boardEl.closest<HTMLElement>(".view-content") ?? ownerDoc().documentElement;
    midPanScrollTop = vertEl.scrollTop;
    ownerDoc().body.style.cursor = "grabbing";
    ownerDoc().addEventListener("mousemove", onMidMouseMove);
    ownerDoc().addEventListener("mouseup", onMidMouseUp);
  }

  function onMidMouseMove(e: MouseEvent) {
    if (!isMidPan) return;
    const scrollEl = ownerDoc().getElementById("kanban-scroll");
    if (scrollEl) scrollEl.scrollLeft = midPanScrollLeft - (e.clientX - midPanStartX);
    const vertEl = boardEl.closest<HTMLElement>(".view-content") ?? ownerDoc().documentElement;
    vertEl.scrollTop = midPanScrollTop - (e.clientY - midPanStartY);
  }

  function onMidMouseUp(e: MouseEvent) {
    if (e.button !== 1) return;
    isMidPan = false;
    ownerDoc().body.style.cursor = "";
    ownerDoc().removeEventListener("mousemove", onMidMouseMove);
    ownerDoc().removeEventListener("mouseup", onMidMouseUp);
  }

  // ── Phone column tabs ──
  function onTabClick(e: MouseEvent) {
    if (selectedCard) return;
    const tab = (e.target as Element).closest("button[data-col-norm]") as HTMLElement | null;
    if (!tab) return;
    const wrapper = ownerDoc().getElementById("kanban-wrapper");
    if (wrapper) wrapper.dataset.activeCol = tab.dataset.colNorm;
    refresh();
  }

  // ── Add buttons ──
  async function onAddClick(e: MouseEvent) {
    const btn = (e.target as Element).closest("button[data-column]") as HTMLElement | null;
    if (!btn) return;
    if (btn.dataset.column === config.normDone) return;

    const tag = btn.dataset.tag!;
    const norm = btn.dataset.column!;
    const title = `Add to ${tag.replace(/^#/, "").toUpperCase()} Column`;
    const isProject = config.normProject.includes(norm);

    if (norm === config.normLater) {
      const defDate = getDefaultDate().toISOString().split("T")[0];
      showDateDialog(title, defDate, async (dateStr, text, createDoc) => {
        if (text && await addNewItem(app, config.newTaskInsert, tag, text, dateStr, config, !!createDoc))
          requestAnimationFrame(() => setTimeout(refresh, 50));
      }, { withText: true, defaultCreateDoc: isProject });
    } else if (config.normRecurrent && norm === config.normRecurrent) {
      showInputDialog(title, isProject, (text: string, createDoc: boolean) => {
        showRecurrentTriggerDialog(async (triggerStr) => {
          const n = new Date();
          const skipStr = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
          const triggerPart = triggerStr ? ` ${triggerStr}` : '';
          const annotated = `${text} @${config.normRecurrent}${triggerPart} %% @skip:${skipStr} %%`;
          if (await addNewItem(app, config.newTaskInsert, tag, annotated, null, config, createDoc))
            requestAnimationFrame(() => setTimeout(refresh, 50));
        });
      });
    } else {
      showInputDialog(title, isProject, async (text: string, createDoc: boolean) => {
        if (await addNewItem(app, config.newTaskInsert, tag, text, null, config, createDoc))
          requestAnimationFrame(() => setTimeout(refresh, 50));
      });
    }
  }

  // ── Archive button ──
  async function onArchiveClick(e: MouseEvent) {
    const btn = (e.target as Element).closest("button[data-column]") as HTMLElement | null;
    if (!btn || btn.dataset.column !== config.normDone) return;

    const zone = btn
      .closest("[data-col-container]")
      ?.querySelector(".drop-zone") as HTMLElement | null;
    if (!zone) return;

    // Archiving a top-level card removes its block from its original spot and
    // appends it elsewhere, which shifts every later line number in that file.
    // Process bottom-to-top (by line number) so line numbers captured earlier
    // in this batch stay valid for cards still waiting to be archived.
    const cards = Array.from(zone.querySelectorAll<HTMLElement>(".kanban-card"))
      .sort((a, b) => parseInt(b.dataset.line!, 10) - parseInt(a.dataset.line!, 10));

    let count = 0;
    for (const card of cards) {
      let subs: any[] = [];
      try { subs = JSON.parse(card.dataset.subs || "[]"); } catch { /* ignore malformed subs */ }
      const ok = await archiveToSection(
        app,
        card.dataset.file!,
        parseInt(card.dataset.line!, 10),
        subs,
        config,
        card.dataset.isPromoted !== "true"
      );
      if (ok) count++;
    }
    if (count) {
      new Notice(`Archived ${count} items.`);
      requestAnimationFrame(() => setTimeout(refresh, 50));
    }
  }

  // Intercept obsidian:// links so they open via the API instead of triggering
  // the OS protocol handler, which closes pop-out windows.
  function onObsidianLinkClick(e: MouseEvent) {
    const anchor = (e.target as Element).closest("a") as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!href.startsWith("obsidian://open")) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const url = new URL(href);
      const file = url.searchParams.get("file") ?? "";
      const section = url.searchParams.get("section") ?? "";
      const linktext = (section ? `${file}#${section}` : file).replace(/\.md$/, "");
      // Activate a main-window leaf first so the file opens there, not in the popout.
      let mainLeaf: any = null;
      app.workspace.iterateRootLeaves((leaf: any) => { if (!mainLeaf) mainLeaf = leaf; });
      if (mainLeaf) app.workspace.setActiveLeaf(mainLeaf, { focus: true });
      app.workspace.openLinkText(linktext, "", false);
    } catch { /* ignore malformed URLs */ }
  }

  // Attach all listeners
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
  boardEl.addEventListener("toggle", onToggle, true);
  boardEl.addEventListener("touchstart", onTouchStart as unknown as EventListener, { passive: true });
  boardEl.addEventListener("touchmove", onTouchMove as unknown as EventListener, { passive: false });
  boardEl.addEventListener("touchend", onTouchEnd as unknown as EventListener, { passive: false });
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
    boardEl.removeEventListener("toggle", onToggle, true);
    boardEl.removeEventListener("touchstart", onTouchStart as unknown as EventListener);
    boardEl.removeEventListener("touchmove", onTouchMove as unknown as EventListener);
    boardEl.removeEventListener("touchend", onTouchEnd as unknown as EventListener);
    boardEl.removeEventListener("touchcancel", clearTouch);
  };
}
