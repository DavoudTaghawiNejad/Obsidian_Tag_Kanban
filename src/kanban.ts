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

import { AbstractInputSuggest, App, Notice, Platform, prepareFuzzySearch, renderResults, Scope, SearchResult, TFile, TFolder } from "obsidian";
import { KanbanSettings } from "./main";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

export interface KanbanConfig {
  kanban: string[];
  parentPages: string[];
  allVaultNotes: boolean;
  doneColumn: string;
  startColumn: string;
  dueColumn: string;
  laterColumn: string;
  recurrentColumn: string;
  maybeSomedayColumns: string[];
  newTaskInsert: string;
  normKanban: string[];
  normDone: string;
  normStart: string;
  normDue: string;
  normLater: string;
  normRecurrent: string;
  normMaybeSomeday: string[];
  normProject: string[];
  normActive: string[];
  projectsDocument: string;
  allChildrenDoneColor: string;
  // Colors (empty string → fall back to Obsidian theme variable). These are
  // resolved hex values — computed by buildConfig() from each field's own
  // Hue plus the shared central Saturation/Lightness (or, for text colors,
  // Text lightness).
  columnColors: Record<string, string>;
  // Per-column max card count keyed by normalized tag. 0 = no limit.
  columnMaxCards: Record<string, number>;
  // Shared warning background for columns that exceed their max card count.
  colorColumnOverLimit: string;
  colorColumnBg: string;
  colorText: string;
  // The dark option for column title and card highlight text (see
  // columnTitleTextColor) — white is used instead when the background is too
  // similar in luminance to this color. 0-100, see columnTitleTextColor's
  // thresholdPct.
  colorColumnTitleDark: string;
  colorTextContrastThreshold: number;
  // Length (px) of the directional (top-left-lit) white title shadow. 0 = none.
  columnTitleShadowLength: number;
  colorAccent: string;
  colorLink: string;
  colorFamilySelf: string;
  colorFamilyParent: string;
  colorFamilySibling: string;
  colorDate: string;
  fontDate: string;
  colorBold: string;
  colorItalicStar: string;
  colorItalicUnderscore: string;
  // Kanban Statistics chart colors — always a usable CSS color (a computed
  // hex, or a "var(--color-...)" theme fallback when the hue is unset),
  // never "".
  colorChartOpened: string;
  colorChartDone: string;
  colorChartDeleted: string;
  colorChartZeroAxis: string;
  // Resolved for the current device (desktop vs. mobile) — empty means "use default".
  fontSizeColumnTitle: string;
  fontSizeCardTitle: string;
  fontSizeSubtask: string;
}

// A column's specific type (Done/Due/Later/Recurrent/Start/Project), if it
// matches one — precedence order below, first match wins. A column that
// matches none of these is classified only by Active/Non-active/Maybe Someday
// (see resolveColumnColorHex) — Maybe Someday has no Hue of its own; it's a
// Lightness offset off Column background's Hue, same mechanism as Non-active.
type SpecificColumnType =
  "doneColumn" | "dueColumn" | "laterColumn" | "recurrentColumn" | "startColumn" | "projectColumns";

const SPECIFIC_HUE_FIELD: Record<SpecificColumnType, keyof KanbanSettings> = {
  doneColumn: "hueDoneColumn",
  dueColumn: "hueDueColumn",
  laterColumn: "hueLaterColumn",
  recurrentColumn: "hueRecurrentColumn",
  startColumn: "hueStartColumn",
  projectColumns: "hueProjectColumns",
};

function classifySpecificColumnType(
  norm: string,
  settings: KanbanSettings,
  normProject: string[]
): SpecificColumnType | null {
  if (norm === normalizeTag(settings.doneColumn)) return "doneColumn";
  if (norm === normalizeTag(settings.dueColumn)) return "dueColumn";
  if (norm === normalizeTag(settings.laterColumn)) return "laterColumn";
  if (norm === normalizeTag(settings.recurrentColumn || "#recurrent")) return "recurrentColumn";
  if (norm === normalizeTag(settings.startColumn)) return "startColumn";
  if (normProject.includes(norm)) return "projectColumns";
  return null;
}

// Resolves a column's color: its specific type's own color (Done/Due/Later/
// Recurrent/Start/Project), if that type's Hue is set; otherwise Column
// background's Hue. Active columns use it at the general Lightness
// unmodified; Non-active columns shift by nonActiveLightnessDelta; Maybe
// Someday columns shift by their own maybeSomedayLightnessDelta instead — a
// single shared offset covering every Maybe Someday column, the same way
// nonActiveLightnessDelta covers every non-active column. None of the three
// fall through further (no separate Hue of their own).
function resolveColumnColorHex(
  norm: string,
  settings: KanbanSettings,
  normProject: string[],
  normMaybeSomeday: string[],
  normActive: string[],
  generalHex: (hue: number | null | undefined) => string,
  hueHex: (hue: number | null | undefined, light: number) => string,
  baseL: number
): string {
  const specific = classifySpecificColumnType(norm, settings, normProject);
  if (specific) {
    const hue = settings[SPECIFIC_HUE_FIELD[specific]] as number | null;
    if (hue !== null && hue !== undefined) return generalHex(hue);
  }
  if (normMaybeSomeday.includes(norm)) {
    return hueHex(settings.hueColumnBg, clamp(baseL + (settings.maybeSomedayLightnessDelta ?? 0), 0, 100));
  }
  const isActive = normActive.includes(norm);
  const light = isActive ? baseL : clamp(baseL + (settings.nonActiveLightnessDelta ?? 0), 0, 100);
  return hueHex(settings.hueColumnBg, light);
}

export function buildConfig(settings: KanbanSettings): KanbanConfig {
  const normKanban = settings.kanban.map(normalizeTag);
  // There can be more than one Maybe Someday column (like Project columns).
  const normMaybeSomeday = (settings.maybeSomedayColumns || []).map(normalizeTag);
  // Maybe Someday can never be an Active column, regardless of what's typed into
  // the Active columns setting — filtered here so every consumer of normActive
  // (coloring, the unmanaged-work highlight) automatically respects it.
  const normActive = (settings.activeColumns && settings.activeColumns.length
    ? settings.activeColumns
    : ["#next", "#important", "#today"]
  ).map(normalizeTag).filter((t) => !normMaybeSomeday.includes(t));
  const normProject = (settings.projectColumns || []).map(normalizeTag);

  // Saturation and Lightness are shared by every color choice except text
  // colors and the card-highlight dialog (fixed constants of its own). Text
  // colors use their own Text saturation/Text lightness instead, so text
  // stays legible regardless of how saturated/light/dark the general
  // Saturation/Lightness are set.
  const satC = clamp(settings.colorSaturation ?? 55, 0, 100);
  const baseL = clamp(settings.colorLightness ?? 80, 0, 100);
  const textSatC = clamp(settings.textSaturation ?? 55, 0, 100);
  const textL = clamp(settings.textLightness ?? 30, 0, 100);

  // hue == null → "use Obsidian theme default" (resolves to "").
  const hueHex = (hue: number | null | undefined, light: number): string =>
    hue === null || hue === undefined ? "" : hslToHex(((hue % 360) + 360) % 360, satC, light);
  const generalHex = (hue: number | null | undefined) => hueHex(hue, baseL);
  const textHueHex = (hue: number | null | undefined, light: number): string =>
    hue === null || hue === undefined ? "" : hslToHex(((hue % 360) + 360) % 360, textSatC, light);
  const textHex = (hue: number | null | undefined) => textHueHex(hue, textL);
  // Chart marks get their own Saturation/Lightness (like text colors do) —
  // solid bar/line fills need more vividness than the pastel column-
  // background default. Unset hue → the matching Obsidian theme color, so
  // charts follow the active theme rather than resolving to "" (unusable).
  const chartSatC = clamp(settings.chartSaturation ?? 70, 0, 100);
  const chartL = clamp(settings.chartLightness ?? 48, 0, 100);
  const chartHex = (hue: number | null | undefined, themeFallback: string): string =>
    hue === null || hue === undefined ? themeFallback : hslToHex(((hue % 360) + 360) % 360, chartSatC, chartL);
  // Column title text: a hue-selectable dark color, at Font color's own
  // Saturation/Lightness — white is substituted per-column when the
  // column's own background is too dark for this to read (see
  // columnTitleTextColor / textOnBg). Unset hue → Font color's current hue.
  const colorColumnTitleDark = textHex(settings.hueColumnTitle ?? settings.hueText ?? 225);
  const colorTextContrastThreshold = clamp(settings.textContrastThreshold ?? 45, 0, 108);
  // Bold/Italic/Italic each shift up to ±50% away from Text lightness.
  const boldL = clamp(textL + (settings.boldLightnessDelta ?? 0), 0, 100);
  const italicStarL = clamp(textL + (settings.italicStarLightnessDelta ?? 0), 0, 100);
  const italicUnderscoreL = clamp(textL + (settings.italicUnderscoreLightnessDelta ?? 0), 0, 100);

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
    maybeSomedayColumns: settings.maybeSomedayColumns || [],
    normMaybeSomeday,
    normProject,
    normActive,
    projectsDocument: settings.projectsDocument || "",
    allChildrenDoneColor: generalHex(settings.hueAllChildrenDone) || "#e03e3e",
    columnColors: Object.fromEntries(
      (settings.kanban || []).map((tag) => {
        const norm = normalizeTag(tag);
        return [norm, resolveColumnColorHex(norm, settings, normProject, normMaybeSomeday, normActive, generalHex, hueHex, baseL)];
      })
    ),
    columnMaxCards: Object.fromEntries(
      (settings.kanban || []).map((tag, i) => [normalizeTag(tag), (settings.columnMaxCards || [])[i] || 0])
    ),
    colorColumnOverLimit: generalHex(settings.hueColumnOverLimit) || "#5c1a1a",
    colorColumnBg: generalHex(settings.hueColumnBg),
    colorAccent: generalHex(settings.hueAccent),
    colorFamilySelf: generalHex(settings.hueFamilySelf) || "#e03e3e",
    colorFamilyParent: generalHex(settings.hueFamilyParent) || "#2db55d",
    colorFamilySibling: generalHex(settings.hueFamilySibling) || "#4a90d9",
    fontDate: settings.fontDate || "monospace",
    colorText: textHex(settings.hueText),
    colorColumnTitleDark,
    colorTextContrastThreshold,
    columnTitleShadowLength: clamp(settings.columnTitleShadowLength ?? 2, 0, 10),
    colorLink: textHex(settings.hueLink),
    colorDate: textHex(settings.hueDate) || "#7ab8e8",
    colorBold: textHueHex(settings.hueBold, boldL),
    colorItalicStar: textHueHex(settings.hueItalicStar, italicStarL),
    colorItalicUnderscore: textHueHex(settings.hueItalicUnderscore, italicUnderscoreL),
    colorChartOpened: chartHex(settings.hueChartOpened, "var(--color-blue)"),
    colorChartDone: chartHex(settings.hueChartDone, "var(--color-green)"),
    colorChartDeleted: chartHex(settings.hueChartDeleted, "var(--color-red)"),
    colorChartZeroAxis: chartHex(settings.hueChartZeroAxis, "var(--color-orange)"),
    fontSizeColumnTitle: (Platform.isMobile
      ? settings.fontSizeColumnTitleMobile
      : settings.fontSizeColumnTitle) || "",
    fontSizeCardTitle: (Platform.isMobile
      ? settings.fontSizeCardTitleMobile
      : settings.fontSizeCardTitle) || "",
    fontSizeSubtask: (Platform.isMobile
      ? settings.fontSizeSubtaskMobile
      : settings.fontSizeSubtask) || "",
  };
}

export function validateConfig(settings: KanbanSettings): string | null {
  const normKanban = settings.kanban.map(normalizeTag);
  const normDone = normalizeTag(settings.doneColumn);
  const normStart = normalizeTag(settings.startColumn);
  const normDue = normalizeTag(settings.dueColumn);
  const normLater = normalizeTag(settings.laterColumn);

  if (!settings.kanban.length) return "Missing/empty 'Kanban columns' setting.";
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
    return "Missing 'New task insert location' — set a note name in settings.";
  return null;
}

// ─── TAG UTILITIES ────────────────────────────────────────────────────────────

export const normalizeTag = (tag: string): string =>
  (tag || "").trim().replace(/^#/, "").replace(/_$/, "").toLowerCase();

const matchesKanbanTag = (raw: string, normList: string[]): boolean =>
  normList.includes(normalizeTag(raw));

function extractTags(text: string): string[] {
  const cleaned = text
    .replace(/`[^`]*`/g, "")
    .replace(/["'""][^"'""]*["'""]/g, "");
  return cleaned.match(/(?<!\w)#\w+/g) || [];
}

// Tag stamped on a task whose title/text was cleared out via inline editing,
// in place of physically deleting the line — see markLineDeleted().
const DELETED_TAG = "#deleted";
const isDeletedTag = (t: string) => normalizeTag(t) === normalizeTag(DELETED_TAG);

// Tag stamped on a checked subtask by the order-subtasks dialog's "Archive
// done" button — see archiveCheckedSubtasks.
const ARCHIVED_TAG = "#archived";

// ─── UNCOUNTED (statistics exclusion) ────────────────────────────────────────
// Two independent markers, both stamped as "%% @… %%" comments so Obsidian's
// reading view never shows them (see TaskLine.uncounted/uncountedChildren):
//   %% @uncounted %%          — this exact line is excluded from statistics.
//   %% @uncounted_children %% — every descendant of this line, any depth, is
//                                excluded; the line itself still counts.
//   %% @ucc %%                — typing shorthand for @uncounted_children,
//                                normalized to the long form by
//                                expandUncountedShorthand on every scan.
// The two are composable: a line carrying both drops itself and its whole
// subtree. Deliberately lenient on internal whitespace on read (unlike most
// other "%% @… %%" comments here); always written back in canonical form.
const UNCOUNTED_RE = /%%\s*@uncounted\s*%%/;
const UNCOUNTED_CHILDREN_RE = /%%\s*@(?:uncounted_children|ucc)\s*%%/;

export function isUncountedText(text: string): boolean {
  return UNCOUNTED_RE.test(text ?? "");
}

export function isUncountedChildrenText(text: string): boolean {
  return UNCOUNTED_CHILDREN_RE.test(text ?? "");
}

// ─── ORDER-COMMENT PARSING ────────────────────────────────────────────────────
// Format: %% @<digits> %% or %% @-<digits> %% (a leading '-' places the card
// below zero — see the ORDER ARITHMETIC section for why that's useful).
// A trailing single letter (the old expanded/collapsed flag, e.g. "%% @123x %%")
// is tolerated on read for files written before that flag was dropped, but is
// never written back — the next write to a line rewrites it in the bare form.
//
// `digits` carries the sign (e.g. "-35"); `len` is always the *magnitude*
// length (excluding the sign), since that's what the padding/scale math in
// calcMidDigits needs — use magLen()/splitSigned() rather than `.length`
// when deriving one of these from a fresh digit string.

interface OrderInfo {
  digits: string;
  len: number;
}

function parseOrderComment(text: string): OrderInfo | null {
  const m = text.match(/%% @(-?\d+)\w? %%/);
  if (!m) return null;
  const mag = m[1].replace(/^-/, "");
  // An all-zero digit string means "no real order" (same as absent) — sign
  // doesn't matter here, since -0 and 0 are the same value.
  return /[1-9]/.test(mag) ? { digits: m[1], len: mag.length } : null;
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
  createdDate: string | null;                  // "%% @created:YYYY-MM-DD %%" comment
  deletedDate: string | null;                  // "%% @deleted:YYYY-MM-DD %%" comment
  orderDigits: string | null;
  skipDate: string | null;                     // "%% @skip:YYYY-MM-DD %%" comment
  color: string | null;                        // "%% @color:#RRGGBB %%" comment
  dependsOn: ">" | "^" | null;                 // depends on preceding sibling / parent, or neither
  uncounted: boolean;                          // "%% @uncounted %%" comment
  uncountedChildren: boolean;                  // "%% @uncounted_children %%"/"%% @ucc %%" comment
}

function parseTaskLine(raw: string): TaskLine {
  const indent = (raw.match(/^(\s*)/) || ["", ""])[1];
  let rest = raw.slice(indent.length);

  // Order comment (a legacy trailing letter, e.g. "%% @123x %%", is tolerated
  // on read but dropped on the next write — see parseOrderComment above).
  let orderDigits: string | null = null;
  const om = rest.match(/%% @(-?\d+)\w? %%/);
  if (om) {
    orderDigits = om[1];
  }
  // Skip date — preserve across parse/serialize round-trips
  let skipDate: string | null = null;
  const sm = rest.match(/%% @skip:(\d{4}-\d{2}-\d{2}) %%/);
  if (sm) skipDate = sm[1];
  // Card highlight color — preserve across parse/serialize round-trips
  let color: string | null = null;
  const clm = rest.match(/%% @color:(#[0-9a-fA-F]{6}) %%/);
  if (clm) color = clm[1];
  // Created/deleted date stamps — preserve across parse/serialize round-trips
  let createdDate: string | null = null;
  const crm = rest.match(/%% @created:(\d{4}-\d{2}-\d{2}) %%/);
  if (crm) createdDate = crm[1];
  let deletedDate: string | null = null;
  const dlm = rest.match(/%% @deleted:(\d{4}-\d{2}-\d{2}) %%/);
  if (dlm) deletedDate = dlm[1];
  // Uncounted markers — preserve across parse/serialize round-trips (see the
  // UNCOUNTED section above; "@ucc" is normalized to uncountedChildren here,
  // same as this parse already tolerates the legacy order-comment letter).
  const uncounted = UNCOUNTED_RE.test(rest);
  const uncountedChildren = UNCOUNTED_CHILDREN_RE.test(rest);
  rest = rest.replace(/\s*%%[\s\S]*?%%\s*/g, " ").trim();

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

  // Dependent-subtask marker: ">" depends on the immediately preceding
  // sibling, "^" on the parent. Requires real trailing content — deliberately
  // does NOT match at end-of-string, so a bare "- [ ] >"/"- [ ] ^" isn't a
  // marker at all, just literal punctuation with nothing to depend on.
  let dependsOn: ">" | "^" | null = null;
  const gm = rest.match(/^([>^])\s+/);
  if (gm) {
    dependsOn = gm[1] as ">" | "^";
    rest = rest.slice(gm[0].length);
  }

  const tags = (rest.match(/(?<!\w)#\w+/g) || []);
  const text = rest.replace(/\s*(?<!\w)#\w+/g, "").trim();

  return { indent, bullet, checked, text, tags, date, doneDate, createdDate, deletedDate, orderDigits, skipDate, color, dependsOn, uncounted, uncountedChildren };
}

function serializeTaskLine(t: TaskLine): string {
  const parts: string[] = [];

  if (t.bullet) {
    parts.push(t.checked !== null ? `${t.bullet} [${t.checked ? "x" : " "}]` : t.bullet);
  }
  // Unlike every field below (a trailing token), the dependency marker must
  // stay glued to the checkbox at the front of the line — that adjacency is
  // the syntax itself. Dropped (not emitted bare) when there's no text, same
  // as parseTaskLine refuses to read one back with nothing after it.
  if (t.dependsOn && t.text) {
    parts.push(`${t.dependsOn} ${t.text}`);
  } else if (t.text) {
    parts.push(t.text);
  }
  parts.push(...t.tags);
  if (t.date) parts.push(t.date);
  if (t.doneDate) parts.push(`✅${t.doneDate}`);
  if (t.createdDate) parts.push(`%% @created:${t.createdDate} %%`);
  if (t.deletedDate) parts.push(`%% @deleted:${t.deletedDate} %%`);
  if (t.orderDigits) {
    parts.push(`%% @${t.orderDigits} %%`);
  }
  if (t.skipDate) {
    parts.push(`%% @skip:${t.skipDate} %%`);
  }
  if (t.color) {
    parts.push(`%% @color:${t.color} %%`);
  }
  // Always written in canonical long form — this is what normalizes a
  // hand-typed "%% @ucc %%" the moment the line is next parsed/serialized.
  if (t.uncounted) {
    parts.push("%% @uncounted %%");
  }
  if (t.uncountedChildren) {
    parts.push("%% @uncounted_children %%");
  }

  return t.indent + parts.join(" ");
}

async function updateFileOrderComment(
  app: App,
  filePath: string,
  lineNum: number,
  newDigits: string | null
): Promise<boolean> {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    if (lineNum < 1 || lineNum > lines.length) return false;

    const parsed = parseTaskLine(lines[lineNum - 1]);
    const digits = newDigits ?? parsed.orderDigits;
    if (!digits) return false;

    // Skip write if already correct — avoids triggering a vault.modify refresh loop.
    if (parsed.orderDigits === digits) return true;

    parsed.orderDigits = digits;
    lines[lineNum - 1] = serializeTaskLine(parsed);
    await vaultModify(app, tFile, lines.join("\n"));
    return true;
  } catch (e: any) {
    console.error("updateFileOrderComment failed:", e);
    return false;
  }
}

// ─── ORDER ARITHMETIC (shortest signed decimal strictly between two bounds) ──
// Order values are signed decimal fractions (±0.<digits>) — see the
// ORDER-COMMENT PARSING section above for the on-disk format. Placing a card
// between two neighbors (or at an open end of a column) picks the value with
// the *fewest digits* that still sits strictly between them, not the
// arithmetic midpoint — repeated inserts at the same spot then grow the
// digit string only as fast as actually necessary. When one side has no
// real neighbor (inserting at the very top/bottom of a column, or promoting
// a subtask with nothing already ordered after it), the result hugs the
// real neighbor instead of centering on an arbitrary bound. That's also
// what lets a run of inserts at the very top cross zero into negative
// values once there's no more room above zero, rather than growing
// precision forever — the actual reason negative order values exist.

interface SiblingData {
  digits: string;
  len: number;
}

// Splits a signed digit string ("-35" / "35") into its sign and magnitude.
function splitSigned(s: string): { neg: boolean; mag: string } {
  return s.startsWith("-") ? { neg: true, mag: s.slice(1) } : { neg: false, mag: s };
}

// Magnitude length of a (possibly signed) digit string — what SiblingData.len
// and OrderInfo.len should always hold, as opposed to the raw string length.
function magLen(s: string): number {
  return s.startsWith("-") ? s.length - 1 : s.length;
}

// Floor division for BigInts (b > 0) — BigInt's native `/` truncates toward
// zero, which is wrong here whenever a is negative.
function bigFloorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a < 0n && q * b !== a ? q - 1n : q;
}

// Compares two signed order-digit strings as decimal fractions (±0.<digits>),
// without ever going through a lossy float — pad the shorter magnitude to the
// longer's length with trailing zeros, then compare.
function compareDigits(a: string, b: string): number {
  const A = splitSigned(a), B = splitSigned(b);
  const aZero = !/[1-9]/.test(A.mag), bZero = !/[1-9]/.test(B.mag);
  const aSign = aZero ? 0 : A.neg ? -1 : 1;
  const bSign = bZero ? 0 : B.neg ? -1 : 1;
  if (aSign !== bSign) return aSign - bSign;
  if (aSign === 0) return 0;
  const l = Math.max(A.mag.length, B.mag.length);
  const pa = A.mag.padEnd(l, "0"), pb = B.mag.padEnd(l, "0");
  const cmp = pa < pb ? -1 : pa > pb ? 1 : 0;
  return aSign < 0 ? -cmp : cmp;
}

// Cards without an order-digits string sort last, tie-broken by discovery order.
function compareCardsByDigits(
  a: { digits?: string | null; discoveryIndex?: number },
  b: { digits?: string | null; discoveryIndex?: number }
): number {
  if (a.digits == null && b.digits == null) return (a.discoveryIndex || 0) - (b.discoveryIndex || 0);
  if (a.digits == null) return 1;
  if (b.digits == null) return -1;
  const c = compareDigits(a.digits, b.digits);
  return c !== 0 ? c : (a.discoveryIndex || 0) - (b.discoveryIndex || 0);
}

// Shortest signed value strictly between `prev` and `next`. Either bound may
// be omitted (null) to mean "no real neighbor on this side" — the search
// then hugs whichever bound is real instead of centering on a virtual one.
function calcMidDigits(prev: SiblingData | null, next: SiblingData | null): SiblingData {
  if (!prev && !next) return { digits: "5", len: 1 };

  const L = Math.max(prev?.len || 0, next?.len || 0, 1);
  const scaleAt = (s: SiblingData): bigint => {
    const { neg, mag } = splitSigned(s.digits);
    const v = BigInt(mag.padEnd(L, "0") + "0"); // scaled to L+1 digits
    return neg ? -v : v;
  };
  const OPEN = 10n ** BigInt(L + 1); // virtual ±1 bound for an absent neighbor
  const lowBound = prev ? scaleAt(prev) : -OPEN;
  const highBound = next ? scaleAt(next) : OPEN;

  for (let d = 1; d <= L + 1; d++) {
    const scale = 10n ** BigInt(L + 1 - d);
    const nMin = bigFloorDiv(lowBound, scale) + 1n;
    const nMax = -bigFloorDiv(-highBound, scale) - 1n;
    if (nMin > nMax || (nMin === 0n && nMax === 0n)) continue;

    let pick: bigint;
    if (!prev) {
      pick = nMax !== 0n ? nMax : nMax - 1n;
    } else if (!next) {
      pick = nMin !== 0n ? nMin : nMin + 1n;
    } else {
      pick = bigFloorDiv(nMin + nMax, 2n);
      if (pick === 0n) pick = nMax >= 1n ? 1n : -1n;
    }
    if (pick < nMin || pick > nMax || pick === 0n) continue;

    const neg = pick < 0n;
    const mag = (neg ? -pick : pick).toString().padStart(d, "0");
    return { digits: neg ? `-${mag}` : mag, len: d };
  }
  // Unreachable as long as prev's value is genuinely less than next's.
  return { digits: "5", len: 1 };
}

function calcInsertOrder(
  siblingData: SiblingData[],
  insertIndex: number,
  isMulti = false
): SiblingData {
  const n = siblingData.length;
  if (insertIndex === 0 || isMulti) {
    return n === 0
      ? { digits: "5", len: 1 }
      : calcMidDigits(null, siblingData[0]);
  }
  if (insertIndex >= n) return calcMidDigits(siblingData[n - 1], null);
  return calcMidDigits(siblingData[insertIndex - 1], siblingData[insertIndex]);
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

// Extracts @word and @1-2-digit-number annotations, skipping @YYYY-MM-DD, @recurrent,
// @repeat:N<unit>, and any %% ... %% structural comment (e.g. %% @skip:YYYY-MM-DD %%,
// whose "@skip" would otherwise be misread as a trigger token). Supports underscores
// in words (e.g. @last_day).
function extractTriggerAnnotations(text: string, normRecurrent: string): string[] {
  const cleaned = text.replace(/%%[\s\S]*?%%/g, '').replace(/@repeat:\d+(?:day|week|month|year)s?\b/gi, '');
  const matches = cleaned.match(/@([a-zA-Z][a-zA-Z_]*(?:[+-]\d+)?|\d{1,2})\b/g) || [];
  return matches
    .map((m: string) => m.slice(1).toLowerCase())
    .filter((m: string) => m !== normRecurrent);
}

// Interval-based recurrence: "@repeat:N<unit>" (e.g. "@repeat:2week", "@repeat:1year")
// stores the repeat interval for a #recurrent card whose next-fire date is tracked via
// a plain @YYYY-MM-DD annotation (same field/logic as the #later date trigger — it just
// jumps the card to Today).
type RepeatUnit = "day" | "week" | "month" | "year";
interface RepeatSpec { count: number; unit: RepeatUnit; }

function extractRepeatSpec(text: string): RepeatSpec | null {
  const m = text.match(/@repeat:(\d+)(day|week|month|year)s?\b/i);
  if (!m) return null;
  return { count: parseInt(m[1], 10), unit: m[2].toLowerCase() as RepeatUnit };
}

function formatRepeatAnnotation(spec: RepeatSpec): string {
  return `@repeat:${spec.count}${spec.unit}`;
}

function formatRepeatLabel(spec: RepeatSpec): string {
  const plural = spec.count === 1 ? spec.unit : `${spec.unit}s`;
  return `every ${spec.count} ${plural}`;
}

function formatDateAnnotation(d: Date): string {
  return `@${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Exact calendar-based arithmetic (not a fixed-day approximation): weeks are 7-day
// multiples, months/years roll forward via the calendar's own varying day counts.
function addRepeatInterval(base: Date, spec: RepeatSpec): Date {
  const d = new Date(base);
  switch (spec.unit) {
    case "day": d.setDate(d.getDate() + spec.count); break;
    case "week": d.setDate(d.getDate() + spec.count * 7); break;
    case "month": d.setMonth(d.getMonth() + spec.count); break;
    case "year": d.setFullYear(d.getFullYear() + spec.count); break;
  }
  return d;
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
  return TRIGGER_WEEKDAYS_SHORT.includes(t) ||
    TRIGGER_WEEKDAYS_FULL.includes(t) ||
    TRIGGER_MONTHS_SHORT.includes(t) ||
    TRIGGER_MONTHS_FULL.includes(t) ||
    (/^\d{1,2}$/.test(t) && parseInt(t, 10) >= 1 && parseInt(t, 10) <= 31);
}

function hasValidTriggers(text: string, normRecurrent: string): boolean {
  return extractRepeatSpec(text) !== null || extractTriggerAnnotations(text, normRecurrent).some(isValidTriggerToken);
}

function extractSkipDate(rawLine: string): string | null {
  const m = rawLine.match(/%% @skip:(\d{4}-\d{2}-\d{2}) %%/);
  return m ? m[1] : null;
}

// Card highlight color: "#RRGGBB", or null if unset.
function extractCardColor(rawLine: string): string | null {
  const m = rawLine.match(/%% @color:(#[0-9a-fA-F]{6}) %%/);
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

// Adds a kanban tag to an existing line, leaving everything else on it untouched.
async function addTagToLine(app: App, filePath: string, lineNum: number, tag: string): Promise<void> {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    const idx = lineNum - 1;
    if (idx < 0 || idx >= lines.length) return;
    const parsed = parseTaskLine(lines[idx]);
    if (!parsed.tags.some((t) => normalizeTag(t) === normalizeTag(tag))) parsed.tags.push(tag);
    lines[idx] = serializeTaskLine(parsed);
    await writeFileLines(app, tFile, lines);
  } catch { /* ignore */ }
}

// Sets (or clears, for `null`) a line's leading ">"/"^" dependency marker.
async function toggleDependencyMarker(app: App, filePath: string, lineNum: number, newMarker: ">" | "^" | null): Promise<void> {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    const idx = lineNum - 1;
    if (idx < 0 || idx >= lines.length) return;
    const parsed = parseTaskLine(lines[idx]);
    if (!parsed.dependsOn) return;
    parsed.dependsOn = newMarker;
    lines[idx] = serializeTaskLine(parsed);
    await writeFileLines(app, tFile, lines);
  } catch { /* ignore */ }
}

// Adds the due tag and removes the date from every subtask of a #later card whose @YYYY-MM-DD has arrived.
async function triggerDatedLaterSubs(
  app: App, subs: any[], filePath: string, config: KanbanConfig, today: Date
): Promise<boolean> {
  if (!subs || !subs.length) return false;
  let changed = false;
  for (const sub of subs) {
    if (!sub.tags.some((t: string) => config.normKanban.includes(normalizeTag(t)))) {
      const d = parseCardDate(sub.text);
      if (d && d <= today) {
        await addTagAndClearDate(app, filePath, sub.line, config.dueColumn);
        changed = true;
      }
    }
    if (sub.subs?.length)
      if (await triggerDatedLaterSubs(app, sub.subs, filePath, config, today)) changed = true;
  }
  return changed;
}

// Adds the due tag + skip date to every untriggered subtask whose @recurrent trigger fires today.
async function triggerRecurrentSubs(
  app: App, subs: any[], filePath: string, config: KanbanConfig, today: Date, todayStr: string
): Promise<boolean> {
  if (!subs || !subs.length) return false;
  let changed = false;
  for (const sub of subs) {
    if (!sub.tags.some((t: string) => config.normKanban.includes(normalizeTag(t)))) {
      const repeatDate = parseCardDate(sub.text);
      const fires = repeatDate
        ? repeatDate <= today
        : matchesTriggerAnnotations(extractTriggerAnnotations(sub.text, config.normRecurrent), today);
      if (
        hasRecurrentAnnotation(sub.text, config.normRecurrent) &&
        fires &&
        extractSkipDate(sub.text) !== todayStr
      ) {
        await addTagAndSkipDate(app, filePath, sub.line, config.dueColumn, todayStr);
        changed = true;
      }
    }
    if (sub.subs?.length)
      if (await triggerRecurrentSubs(app, sub.subs, filePath, config, today, todayStr)) changed = true;
  }
  return changed;
}

// Deep search: does any descendant sub carry its own "@recurrent" *with* a valid
// trigger — i.e. is a properly-configured recurring subcard? That's the only
// legitimate reason a "no trigger" top-level card (see applyRecurrentTrigger —
// missing "@recurrent" outright, since it's a plain container, or carrying it
// with no schedule) should exist at all: to hold a collection of such subcards.
// Used by the Step B filter below — a container with none anywhere in its
// subtree isn't serving that purpose and moves to Due instead.
function hasChildWithTrigger(subs: any[], normRecurrent: string): boolean {
  for (const sub of subs || []) {
    if (hasRecurrentAnnotation(sub.text, normRecurrent) && hasValidTriggers(sub.text, normRecurrent)) return true;
    if (hasChildWithTrigger(sub.subs, normRecurrent)) return true;
  }
  return false;
}

// Any subtask with no valid trigger of its own — whether or not it's itself
// "@recurrent" — is otherwise silently stuck forever once its top-level ancestor
// card is *also* untriggered (missing "@recurrent" outright, or carrying it with
// no schedule set): nothing above or below it will ever fire it automatically.
// Tagging it into Due makes it an immediately actionable, visible card instead.
// Left alone if the ancestor itself has a real trigger — only a fully-untriggered
// branch gets popped. Checked-off, deleted, and non-checkbox (plain note) lines
// are skipped — there's no task there to make actionable.
async function popOrphanedRecurrentSubs(app: App, items: any[], config: KanbanConfig): Promise<boolean> {
  if (!config.normRecurrent) return false;
  let changed = false;

  const isNoTrigger = (text: string) =>
    !hasRecurrentAnnotation(text, config.normRecurrent) || !hasValidTriggers(text, config.normRecurrent);

  const popIfOrphaned = async (subs: any[], filePath: string): Promise<void> => {
    for (const sub of subs || []) {
      if (
        isCheckboxItem(sub) &&
        !isCheckedItem(sub) &&
        !isDeletedItem(sub) &&
        !hasValidTriggers(sub.text, config.normRecurrent) &&
        !sub.tags.some((t: string) => config.normKanban.includes(normalizeTag(t)))
      ) {
        await addTagToLine(app, filePath, sub.line, config.dueColumn);
        changed = true;
      }
      if (sub.subs?.length) await popIfOrphaned(sub.subs, filePath);
    }
  };

  for (const i of items) {
    if (!i.item.tags.some((t: string) => normalizeTag(t) === config.normRecurrent)) continue;
    if (!isNoTrigger(i.item.text)) continue;
    await popIfOrphaned(i.item.subs, i.filePath);
  }

  return changed;
}

// True if `node` (at `index` within `subs`, its own sibling array) is relied
// on by another line's dependency marker: either its immediate next sibling
// depends on it as a predecessor (">"), or any of its own direct children
// depends on it as a parent ("^"). Used to block permanently deleting a
// subtask that something else's dependency targets.
function isDependedOn(node: any, subs: any[], index: number): boolean {
  const next = subs[index + 1];
  if (next && parseTaskLine(next.text).dependsOn === ">") return true;
  return (node.subs || []).some((c: any) => parseTaskLine(c.text).dependsOn === "^");
}

// Finds the sibling array (some node's own `.subs`, or a card's own
// `.item.subs`) that directly contains a node with this line number — the
// level isDependedOn needs to operate on. Returns null if no node in the
// tree has that line.
function findSiblingArrayContaining(subs: any[], line: number): any[] | null {
  if (subs.some((s: any) => s.line === line)) return subs;
  for (const s of subs) {
    const found = findSiblingArrayContaining(s.subs || [], line);
    if (found) return found;
  }
  return null;
}

// Sweeps every card's subtask tree for dependent subtasks (a ">" or "^"
// marker) whose target is now checked or deleted, tagging each satisfied one
// into the due column so it shows up as its own actionable card ("promoted"
// out of the tree). ">" depends on the immediately preceding sibling (by raw
// array position — a deleted-but-still-present predecessor still counts, and
// satisfies the dependency); "^" always depends on the parent.
//
// A ">" with no preceding sibling (index 0) is not a valid stored state —
// nothing precedes it — so it's auto-corrected to "^" (the same target it
// would otherwise have to fall back to) right here, before it's evaluated,
// so the correction and the promotion check use the same up-to-date marker
// within this one pass rather than needing a second render cycle.
async function promoteDependentSubtasks(app: App, items: any[], config: KanbanConfig): Promise<boolean> {
  let changed = false;

  const tryPromote = async (sub: any, filePath: string): Promise<boolean> => {
    if (!isCheckboxItem(sub) || isCheckedItem(sub) || isDeletedItem(sub)) return false;
    if (sub.tags.some((t: string) => config.normKanban.includes(normalizeTag(t)))) return false;
    await addTagToLine(app, filePath, sub.line, config.dueColumn);
    return true;
  };

  const evaluate = async (subs: any[], parent: any, filePath: string): Promise<void> => {
    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      const parsed = parseTaskLine(sub.text);
      if (parsed.dependsOn) {
        if (parsed.dependsOn === ">" && i === 0) {
          await toggleDependencyMarker(app, filePath, sub.line, "^");
          changed = true;
          parsed.dependsOn = "^";
        }
        const target = parsed.dependsOn === ">" ? subs[i - 1] : parent;
        const satisfied = isDeletedItem(target) || isCheckedItem(target);
        if (satisfied && (await tryPromote(sub, filePath))) changed = true;
      }
      if (sub.subs?.length) await evaluate(sub.subs, sub, filePath);
    }
  };

  for (const i of items) {
    await evaluate(i.item.subs, i.item, i.filePath);
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

function getInSevenDays(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 7);
  return d;
}

function getInThirtyDays(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 30);
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
  ["sevendays", "In 7 days", getInSevenDays],
  ["month", "Next month", getNextMonth],
  ["thirtydays", "In 30 days", getInThirtyDays],
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
const TITLE_FONT_WEIGHT = 600; // must match the font-weight applied to .card-title

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
  text = text.replace(/@repeat:(\d+)(day|week|month|year)s?\b/gi, (_match, count, unit) => {
    triggers.push(formatRepeatLabel({ count: parseInt(count, 10), unit: unit.toLowerCase() }));
    return '';
  });
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
    if (isValidTriggerToken(t)) return token;
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
      const yearSuffix = Number(y) !== today.getFullYear() ? `, ${y}` : "";
      label = `${months[Number(m) - 1]} ${Number(d)}${yearSuffix}`;
    }
    const display = inline ? "inline" : "block";
    return `<span class="kb-date-label" data-date="${y}-${m}-${d}" style="display:${display};font-size:.8em;color:var(--kb-date-color);font-family:var(--kb-date-font);cursor:pointer;text-decoration:underline dotted;">${label}</span>`;
  });
}

// Inline **bold**, *italic*, and _italic_ markers. Applied after link conversion,
// so matched content is required to exclude "<" — this stops a match from ever
// spanning across an HTML tag boundary (e.g. two separate <a> hrefs that each
// contain a single stray marker character).
export function formatInlineEmphasis(text: string, baseWeight = 400): string {
  const boldWeight = Math.min(baseWeight * 2, 1000);
  // Most UI fonts only ship a Regular and a Bold face, so any numeric weight
  // above ~600 renders identically to the surrounding title (already semibold).
  // A text-stroke fakes the extra weight the font itself can't provide.
  const strokeWidth = (boldWeight - baseWeight) / 800; // px, scales with the requested jump
  text = text.replace(/\*\*([^\n<]+?)\*\*/g, (_, inner) => `<strong style="font-weight:${boldWeight};-webkit-text-stroke:${strokeWidth}px currentColor;color:var(--kb-bold-color);">${inner}</strong>`);
  text = text.replace(/\*([^\n<]+?)\*/g, (_, inner) => `<em style="color:var(--kb-italic-star-color);">${inner}</em>`);
  // CommonMark-style rule: "_" only starts/ends emphasis at a word boundary, so
  // snake_case_names aren't accidentally italicized.
  text = text.replace(/(?<![\w_])_([^_\n<]+?)_(?![\w_])/g, (_, inner) => `<em style="color:var(--kb-italic-underscore-color);">${inner}</em>`);
  return text;
}

// ─── LINK CONVERSION ─────────────────────────────────────────────────────────

export function linksToHtml(text: string, vaultName: string): string {
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
    promoted?: boolean;
    subLine?: number | null;
    parentTag?: string | null;
    parentDigits?: string | null;
    // Dialog-only: always renders a clickable ">"/"^"/"_" glyph at the front
    // of the row — "_" stands for no marker — pulling a real leading ">"/"^"
    // out of plain text when one is present. `hasPredecessor` says whether
    // ">" is a reachable state for this row's toggle cycle (see the reorder
    // dialog's marker-toggle click handler); it does not affect what's
    // rendered, only what the next click can produce. The board's own
    // renderSub never sets this, so a marker stays plain, unclickable text
    // there.
    depToggle?: { hasPredecessor: boolean };
  } = {}
): string {
  const {
    isSub = false,
    showCheckbox = true,
    vaultName = null,
    enablePromotion = false,
    promoted = false,
    subLine = null,
    parentTag = null,
    parentDigits = null,
    depToggle,
  } = opts;

  let content = text.trim();
  let cbHtml = "";

  if (/^- \[[ xX]\] /.test(content)) {
    const checked = content[3] !== " ";
    content = content.slice(6);
    if (showCheckbox) {
      if (isSub && subLine != null) {
        // pointer-events:auto matters when this renders inside the reorder
        // dialog's row label, which wraps its content in pointer-events:none
        // (see wireSubtaskTree's buildRow) so the whole row stays draggable
        // — harmless elsewhere (the board's own renderSub never sets that on
        // an ancestor, so this is already the effective default there).
        cbHtml = `<input type="checkbox" class="kb-sub-check" data-sub-line="${subLine}"${checked ? " checked" : ""} style="width:1em;height:1em;margin-right:5px;vertical-align:middle;cursor:pointer;pointer-events:auto;">`;
      } else {
        cbHtml = `<input type="checkbox" disabled${checked ? " checked" : ""} style="width:1em;height:1em;margin-right:5px;vertical-align:middle;">`;
      }
    }
  } else if (/^[-*+]\s+/.test(content)) {
    content = content.replace(/^[-*+]\s+/, "");
    cbHtml = showCheckbox
      ? `<input type="checkbox" disabled style="width:1em;height:1em;margin-right:5px;vertical-align:middle;">`
      : "• ";
  }

  let toggleHtml = "";
  if (depToggle) {
    const mm = content.match(/^([>^])\s+/);
    const marker = mm ? (mm[1] as ">" | "^") : null;
    if (mm) content = content.slice(mm[0].length);
    // pointer-events:auto is load-bearing: the dialog wraps this whole
    // label in pointer-events:none (so a click anywhere on the row starts a
    // drag instead of being swallowed by inner content), which would
    // otherwise make this span just as unclickable as everything else.
    toggleHtml = `<span class="kb-dep-toggle" data-line="${subLine ?? ""}" data-marker="${marker ?? ""}" data-has-predecessor="${depToggle.hasPredecessor}" style="cursor:pointer;font-weight:bold;pointer-events:auto;" title="Click to cycle predecessor/parent dependency">${marker ?? "_"}</span> `;
  }

  if (vaultName) content = linksToHtml(content, vaultName);
  content = formatInlineEmphasis(content);

  const promoteHtml =
    enablePromotion && isSub && subLine && parentTag && parentDigits !== null
      ? `<span class="promote-icon" style="margin-left:6px;font-size:1.2em;cursor:pointer;color:var(--kb-accent);"
           data-line="${subLine}" data-parent-tag="${parentTag}" data-parent-digits="${parentDigits}">&#9655</span>`
      : promoted && isSub
        ? `<span class="promoted-icon" title="Already its own card" style="margin-left:6px;font-size:1.2em;color:var(--kb-accent);">&#9679;</span>`
        : "";

  return `${cbHtml}${toggleHtml}${content}${promoteHtml}`;
}

// ─── FILE OPERATIONS ──────────────────────────────────────────────────────────

// Per-file line cache, keyed by vault path. Board renders otherwise re-read
// and re-parse every target file from disk on every call (buildBoard alone
// does this up to 5x per render) — this makes an unrelated render, or one
// triggered by a single known change (e.g. a card drag), reuse content that
// hasn't actually changed on disk. Invalidated centrally by main.ts's
// vault "modify"/"delete"/"rename" listeners, since every write in this
// plugin ultimately goes through app.vault.modify, which fires "modify"
// before its promise resolves. The mtime check below is a cheap, no-I/O
// backstop for external changes (e.g. this vault syncing over iCloud) whose
// event might be missed or delayed.
const fileLineCache = new Map<string, { mtime: number; lines: string[] }>();
// Parsed (but not yet kanban-tag-filtered) entries per file — see
// parseFileEntries/getCachedFileEntries near collectItems. Kept config-
// independent (no tag filtering baked in) so a settings change never needs
// to invalidate it — only file content does, same as fileLineCache above.
const fileEntryCache = new Map<string, { mtime: number; entries: any[] }>();

// Cards a system action (drop into Done with open subtasks, an archive
// warning, a promoted subtask) wants rendered open on the very next board
// build, without writing anything to the file — see collectItems/buildBoard.
// Peeked (not removed) by collectItems, since it can run several times per
// build; consumed once, by buildBoard, against the build's final item list.
const pendingForceExpand = new Set<string>();
function forceExpandKey(filePath: string, line: number): string {
  return `${filePath}:${line}`;
}

// The single card the user last opened by hand (session-only, tracked by the
// boardEl "toggle" listener below). Unlike pendingForceExpand this isn't a
// one-shot flag — collectItems checks it on every render, so it keeps
// rendering expanded across however many renders happen in a row (e.g. a
// resize check landing right alongside the leaf-activation render) instead
// of only surviving the first one and then snapping shut on the next.
// Cleared by the toggle listener on manual collapse, and by
// expireLastExpandedIfStale once the away time exceeds the grace window
// (settings.keepLastExpandedMinutes) — see noteBoardLeft, called from
// KanbanView's active-leaf-change handler.
let currentlyExpandedKey: string | null = null;
let leftBoardAt: number | null = null;

export function noteBoardLeft(): void {
  leftBoardAt = Date.now();
}

// graceMs <= 0 disables the grace window outright — the "away too long"
// check below is then true as soon as any time at all has elapsed.
export function expireLastExpandedIfStale(graceMs: number): void {
  if (leftBoardAt !== null && Date.now() - leftBoardAt >= graceMs) {
    currentlyExpandedKey = null;
  }
}

// Collapses every open card on the board — used by the board-level Escape
// handler (KanbanView.handleBoardEscape). Explicitly clears
// currentlyExpandedKey rather than relying on the native "toggle" event that
// removeAttribute below queues, matching the same belt-and-suspenders
// approach the archive handler in attachListeners already uses.
export function collapseAllCards(boardEl: HTMLElement): void {
  boardEl.querySelectorAll<HTMLDetailsElement>(".kanban-card details[open]").forEach((details) => {
    details.removeAttribute("open");
    const arrow = details.closest(".kanban-card")?.querySelector<HTMLElement>(".kb-expand-arrow");
    if (arrow) arrow.textContent = "▼";
  });
  currentlyExpandedKey = null;
}

// Releases the click-to-isolate family filter (see toggleFamilyIsolation in
// attachListeners) — used by the board-level Escape handler. Safe to call
// unconditionally: a no-op when no isolation is active. Restores card
// visibility directly rather than going through attachListeners' applyFilter
// (private to that closure) — correct because activating isolation always
// clears the search box first, so whenever isolation is active the query is
// guaranteed empty and "show everything" is exactly what applyFilter's own
// no-query branch would do anyway.
export function clearFamilyIsolation(boardEl: HTMLElement): void {
  if (!boardEl.dataset.familyIsolate) return;
  delete boardEl.dataset.familyIsolate;
  boardEl.querySelectorAll<HTMLElement>(".kanban-card").forEach((c) => { c.style.display = ""; });
  if (boardEl.dataset.narrow === "1") {
    const activeNorm = boardEl.querySelector<HTMLElement>(
      '[data-col-norm][data-col-active="1"]'
    )?.dataset.colNorm;
    boardEl.querySelectorAll<HTMLElement>("[data-col-container]").forEach((colDiv) => {
      colDiv.style.display = colDiv.dataset.colContainer === activeNorm ? "block" : "none";
    });
  }
}

async function getCachedFileLines(app: App, filePath: string): Promise<string[]> {
  const tFile = app.vault.getAbstractFileByPath(filePath) as TFile | null;
  if (!tFile) return [];
  const cached = fileLineCache.get(filePath);
  if (cached && cached.mtime === tFile.stat.mtime) return cached.lines;
  let raw: string;
  try {
    raw = await app.vault.read(tFile);
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "string") return [];
  const lines = raw.split("\n");
  fileLineCache.set(filePath, { mtime: tFile.stat.mtime, lines });
  return lines;
}

export function invalidateCachedFile(path: string): void {
  fileLineCache.delete(path);
  fileEntryCache.delete(path);
}

export function renameCachedFile(oldPath: string, newPath: string): void {
  const lines = fileLineCache.get(oldPath);
  const entries = fileEntryCache.get(oldPath);
  fileLineCache.delete(oldPath);
  fileEntryCache.delete(oldPath);
  if (lines) fileLineCache.set(newPath, lines);
  if (entries) fileEntryCache.set(newPath, entries);
}

async function readFileLines(
  app: App,
  filePath: string
): Promise<{ tFile: TFile; lines: string[] }> {
  const tFile = app.vault.getAbstractFileByPath(filePath) as TFile | null;
  if (!tFile) throw new Error(`File not found: ${filePath}`);
  return { tFile, lines: (await app.vault.read(tFile)).split("\n") };
}

// Every write in this plugin must go through here, not app.vault.modify
// directly. Obsidian only updates TFile.stat.mtime and fires the vault
// "modify" event from its filesystem-watcher callback (Vault.onChange) —
// never synchronously as part of modify()'s own promise — so both of
// fileLineCache/fileEntryCache's invalidation paths (the main.ts "modify"
// listener, and the mtime-equality check in getCachedFileLines/
// getCachedFileEntries) depend on that watcher round-trip. On a synced
// vault (iCloud, etc.) that round-trip can lag well past the board's own
// post-write refresh, so a render right after a write can still read stale
// cached content — invalidating here, immediately after our own write
// resolves, doesn't depend on that timing at all.
async function vaultModify(app: App, tFile: TFile, content: string): Promise<void> {
  await app.vault.modify(tFile, content);
  invalidateCachedFile(tFile.path);
}

async function writeFileLines(app: App, tFile: TFile, lines: string[]) {
  await vaultModify(app, tFile, lines.join("\n"));
}

async function updateCardDate(app: App, filePath: string, lineNum: number, newDateStr: string | null): Promise<void> {
  const { tFile, lines } = await readFileLines(app, filePath);
  if (lineNum < 1 || lineNum > lines.length) return;
  const parsed = parseTaskLine(lines[lineNum - 1]);
  parsed.date = newDateStr;
  lines[lineNum - 1] = serializeTaskLine(parsed);
  await writeFileLines(app, tFile, lines);
}

async function updateCardColor(app: App, filePath: string, lineNum: number, color: string | null): Promise<void> {
  const { tFile, lines } = await readFileLines(app, filePath);
  if (lineNum < 1 || lineNum > lines.length) return;
  const parsed = parseTaskLine(lines[lineNum - 1]);
  parsed.color = color;
  lines[lineNum - 1] = serializeTaskLine(parsed);
  await writeFileLines(app, tFile, lines);
}

// Sets both uncounted markers on a line at once (the edit-card dialog's two
// checkboxes apply together on a single Apply click) — see the UNCOUNTED
// section above. Skips the write when neither flag actually changes, same
// guard updateFileOrderComment uses, to avoid a pointless vault.modify.
async function setLineUncountedFlags(
  app: App,
  filePath: string,
  lineNum: number,
  opts: { uncounted: boolean; uncountedChildren: boolean }
): Promise<void> {
  const { tFile, lines } = await readFileLines(app, filePath);
  if (lineNum < 1 || lineNum > lines.length) return;
  const parsed = parseTaskLine(lines[lineNum - 1]);
  if (parsed.uncounted === opts.uncounted && parsed.uncountedChildren === opts.uncountedChildren) return;
  parsed.uncounted = opts.uncounted;
  parsed.uncountedChildren = opts.uncountedChildren;
  lines[lineNum - 1] = serializeTaskLine(parsed);
  await writeFileLines(app, tFile, lines);
}

// Subtasks have no persisted order field — a subtask's order *is* its
// physical line position in the file. `subs` is every direct child of a
// card, in original file order (deleted-but-still-present ones included, so
// block coverage has no gaps); `newVisibleOrder` is the new order of only
// the non-deleted lines (deleted children are never shown/draggable in the
// reorder dialog). By default deleted children stay pinned at their original
// relative slot (a plain drag never touches them); pass `deletedGoLast: true`
// (the "Open → Done" sort button) to instead move all of them after the
// newly-ordered visible lines, in their own original relative order.
async function reorderSubtasks(
  app: App,
  filePath: string,
  subs: { line: number; subs: any[] }[],
  newVisibleOrder: number[],
  deletedGoLast: boolean = false
): Promise<void> {
  if (subs.length < 2) return;
  const { tFile, lines } = await readFileLines(app, filePath);

  // Each child's block runs up to the next child's line (so any blank lines
  // or comments between two children travel with the preceding block) — or,
  // for the last child, up to the end of its own subtree.
  const blocks = new Map<number, string[]>();
  for (let i = 0; i < subs.length; i++) {
    const start = subs[i].line;
    const end = i < subs.length - 1
      ? subs[i + 1].line - 1
      : (maxSubLine(subs[i].subs) || subs[i].line);
    blocks.set(start, lines.slice(start - 1, end));
  }

  const originalOrder = subs.map((s) => s.line);
  const visibleSet = new Set(newVisibleOrder);

  let finalOrder: number[];
  if (deletedGoLast) {
    const deletedLines = originalOrder.filter((line) => !visibleSet.has(line));
    finalOrder = [...newVisibleOrder, ...deletedLines];
  } else {
    let cursor = 0;
    finalOrder = originalOrder.map((line) =>
      visibleSet.has(line) ? newVisibleOrder[cursor++] : line
    );
  }

  const firstLine = originalOrder[0];
  const totalLen = originalOrder.reduce((n, line) => n + (blocks.get(line)?.length ?? 0), 0);
  const replacement = finalOrder.flatMap((line) => blocks.get(line) ?? []);
  lines.splice(firstLine - 1, totalLen, ...replacement);

  await writeFileLines(app, tFile, lines);
}

async function updateCardTriggers(
  app: App, filePath: string, lineNum: number,
  normRecurrent: string, newTriggerStr: string
): Promise<void> {
  const { tFile, lines } = await readFileLines(app, filePath);
  if (lineNum < 1 || lineNum > lines.length) return;
  const parsed = parseTaskLine(lines[lineNum - 1]);
  // Remove old trigger tokens and repeat annotation, but keep @recurrent annotation
  parsed.text = parsed.text
    .replace(/@repeat:\d+(?:day|week|month|year)s?\b/gi, '')
    .replace(/@([a-zA-Z][a-zA-Z_]*(?:[+-]\d+)?|\d{1,2})\b/g, (match, token) => {
      const t = token.toLowerCase();
      if (t === normRecurrent) return match;
      return isValidTriggerToken(t) ? '' : match;
    }).replace(/\s{2,}/g, ' ').trim();
  // A stale next-fire date only applies to the previous trigger set; drop it unless
  // the new trigger set supplies its own @YYYY-MM-DD (interval-based recurrence).
  parsed.date = null;
  // Append new triggers (avoid duplicates); a bare @YYYY-MM-DD token sets the date field.
  for (const tok of newTriggerStr.trim().split(/\s+/)) {
    if (!tok) continue;
    if (/^@\d{4}-\d{2}-\d{2}$/.test(tok)) { parsed.date = tok; continue; }
    const key = tok.replace(/^@/, '');
    if (!new RegExp(`@${key}\\b`, 'i').test(parsed.text)) parsed.text = parsed.text.trimEnd() + ' ' + tok;
  }
  lines[lineNum - 1] = serializeTaskLine(parsed);
  const n = new Date();
  const skipStr = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
  lines[lineNum - 1] = setSkipDate(lines[lineNum - 1], skipStr);
  await writeFileLines(app, tFile, lines);
}

// A line typed after a Ctrl+Enter newline (see onSubDblClick / onRowDblClick /
// startTitleEdit) may lead with its own "- [ ]"/"- [x]"/"-"/"*"/"+" marker to
// pick task-vs-bullet for the child line it becomes; plain text with no
// marker just defaults to a bullet.
function parseLineMarker(line: string): { hasCheckbox: boolean; text: string } {
  const m = line.match(/^(-\s*\[[ xX]\]|[-*+])\s*(.*)$/);
  if (!m) return { hasCheckbox: false, text: line };
  return { hasCheckbox: /\[[ xX]\]/.test(m[1]), text: m[2] };
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
    const createdMatch = original.match(/%% @created:\d{4}-\d{2}-\d{2} %%/);
    const createdComment = createdMatch ? createdMatch[0] : "";
    const orderMatch = original.match(/%% @-?\d+\w? %%/);
    const orderComment = orderMatch ? orderMatch[0] : "";
    const colorMatch = original.match(/%% @color:#[0-9a-fA-F]{6} %%/);
    const colorComment = colorMatch ? colorMatch[0] : "";
    // Re-emitted in canonical long form regardless of which spelling was on
    // disk — same normalization serializeTaskLine does elsewhere.
    const uncountedComment = UNCOUNTED_RE.test(original) ? "%% @uncounted %%" : "";
    const uncountedChildrenComment = UNCOUNTED_CHILDREN_RE.test(original) ? "%% @uncounted_children %%" : "";

    // Ctrl+Enter while inline-editing inserts a literal newline instead of
    // committing, so this line's text can spawn new child subtasks right
    // under it: the first line replaces this line's own text as before, and
    // every further line becomes its own nested line one indent level
    // deeper — see parseLineMarker for how each one picks task vs bullet.
    const rawLines = newText.replace(/\r\n/g, "\n").split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const firstText = rawLines.length ? rawLines[0] : newText.trim();
    const childIndent = indent + "\t";
    const childLines = rawLines.slice(1).map((l) => {
      const { hasCheckbox, text } = parseLineMarker(l);
      return `${childIndent}${hasCheckbox ? "- [ ] " : "- "}${text}`;
    });

    const parts = [indent + marker + firstText];
    if (tags) parts.push(tags);
    if (createdComment) parts.push(createdComment);
    if (orderComment) parts.push(orderComment);
    if (colorComment) parts.push(colorComment);
    if (uncountedComment) parts.push(uncountedComment);
    if (uncountedChildrenComment) parts.push(uncountedChildrenComment);
    lines.splice(lineNum - 1, 1, parts.join(" "), ...childLines);

    await writeFileLines(app, tFile, lines);
    return true;
  } catch (e: any) {
    console.error("editCardText failed:", e);
    return false;
  }
}

// Clearing a card's or subtask's title in the UI no longer removes the line —
// it stamps it #deleted instead, leaving the original text alone. This keeps
// line numbers stable for the surrounding tree and preserves what the task
// said, in case it's ever found again in the archive.
async function markLineDeleted(
  app: App,
  filePath: string,
  lineNum: number,
  config: KanbanConfig
): Promise<boolean> {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    if (lineNum < 1 || lineNum > lines.length) return false;
    const parsed = parseTaskLine(lines[lineNum - 1]);
    parsed.tags = parsed.tags.filter((t) => !config.normKanban.includes(normalizeTag(t)));
    if (!parsed.tags.some(isDeletedTag)) {
      parsed.tags.push(DELETED_TAG);
      const n = new Date();
      parsed.deletedDate = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
    }
    if (parsed.checked !== null) parsed.checked = false;
    lines[lineNum - 1] = serializeTaskLine(parsed);
    await writeFileLines(app, tFile, lines);
    return true;
  } catch (e: any) {
    console.error("markLineDeleted failed:", e);
    return false;
  }
}

async function deleteLineRange(
  app: App,
  filePath: string,
  startLine: number,
  endLine: number
): Promise<boolean> {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    if (startLine < 1 || startLine > lines.length) return false;
    const end = Math.min(endLine, lines.length);
    lines.splice(startLine - 1, end - startLine + 1);
    await writeFileLines(app, tFile, lines);
    return true;
  } catch (e: any) {
    console.error("deleteLineRange failed:", e);
    return false;
  }
}

// Applies the outcome of showRecurrentTriggerDialog to a task line.
// triggerAnnotation === null means the dialog was never shown (the card already
// qualified — see hasChildWithTrigger/hasValidTriggers at each call site) — leave
// its existing trigger state untouched. triggerAnnotation === "" means "No
// trigger" was actually chosen: the card stays a plain container — meant for
// adding recurring subtasks to, not for firing on its own — so it deliberately
// does NOT get "@recurrent"; it's skip-dated for today instead, so the "no
// untriggered children" rule in Step B doesn't sweep a brand-new (or
// just-returned) empty container into Due before there's been a chance to add
// anything under it. Any other (non-empty) string is an actual trigger
// (space-separated "@word"/"@repeat:..." tokens), and adds "@recurrent" plus
// those tokens, skipping ones already present.
function applyRecurrentTrigger(parsed: TaskLine, normRecurrent: string, triggerAnnotation: string | null): void {
  if (triggerAnnotation === null) return;
  if (triggerAnnotation === "") {
    const n = new Date();
    parsed.skipDate = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
    return;
  }
  const annRe = new RegExp(`@${normRecurrent}\\b`, 'i');
  if (!annRe.test(parsed.text)) parsed.text += ` @${normRecurrent}`;
  for (const tok of triggerAnnotation.trim().split(/\s+/)) {
    if (!tok) continue;
    const tokRe = new RegExp(`@${tok.replace(/^@/, '')}\\b`, 'i');
    if (!tokRe.test(parsed.text)) parsed.text += ` ${tok}`;
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
      applyRecurrentTrigger(parsed, config.normRecurrent, triggerAnnotation);
      // Created-date is stripped whenever a card lands in Recurrent — a card
      // parked there isn't "open work" (see OPEN_EXCLUDED_TAGS/NEW_EXCLUDED_TAGS
      // in KanbanStatisticsView.ts), so it shouldn't carry a creation date at
      // all. stampMissingCreatedDates skips Recurrent cards for the same
      // reason, so this stays cleared while parked; the next render backfills
      // a fresh date once it actually fires back into Due (same reasoning as
      // the equivalent strip in archiveToSection's keepRecurring path, the
      // other route back into this column).
      parsed.createdDate = null;
    }

    if (parsed.checked !== null) parsed.checked = isDone;
    if (clearDate) parsed.date = null;
    if (dateStrToAppend) parsed.date = dateStrToAppend;
    if (isDone) {
      const n = new Date();
      const todayStr = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`;
      parsed.doneDate = todayStr;
      // A card landing in Done without a created date (e.g. dragged straight
      // there from Recurrent/Maybe Someday, where it's deliberately kept
      // undated) would otherwise sit with a Done tag and no @created stamp
      // until the next board render's stampMissingCreatedDates backfill —
      // stamp it immediately instead of leaving that gap.
      if (!parsed.createdDate) parsed.createdDate = todayStr;
    } else if (!(config.normRecurrent && normalizeTag(targetTag) === config.normRecurrent)) {
      // A recurring card cycling back into its own Recurrent column keeps the
      // done date from the occurrence that just completed (dragged straight
      // there from Done, bypassing archiveToSection) — it's only cleared once
      // the card actually fires again into Due (targetTag there isn't Recurrent,
      // so it falls through to this null below).
      parsed.doneDate = null;
    }

    if (newDigits !== null) {
      parsed.orderDigits = newDigits;
    }

    lines[idx] = serializeTaskLine(parsed);
    const n = new Date();
    const skipStr = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
    // Stamp today's skip date when a recurring card fires into Due — this is what
    // stops it re-firing again the same day once it later cycles back to Recurrent
    // (the stamp isn't cleared on return, see archiveToSection). Returning to Recurrent
    // itself must NOT set the skip date; that would suppress a legitimate same-day fire.
    if (
      config.normRecurrent &&
      normalizeTag(targetTag) === config.normDue &&
      hasRecurrentAnnotation(parsed.text, config.normRecurrent)
    ) {
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

// Uncheck any completed subtasks (recursively), and strip the created-date off
// any of them that aren't their own card (no kanban tag of their own — a
// "promoted" subtask with its own tag is a card in its own right and is left
// untouched), so a recurring card that's manually dragged back to the
// recurrent column starts its next occurrence fresh — the same reset
// archiveToSection applies to a recurring card's subtasks when it cycles back
// via completion+archive instead of a plain drag (see archiveLine there).
async function uncheckSubtasks(app: App, filePath: string, subs: any[], config: KanbanConfig): Promise<boolean> {
  if (!subs || !subs.length) return false;
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    let changed = false;
    const recurse = (list: any[]) => {
      for (const sub of list) {
        const idx = sub.line - 1;
        if (idx >= 0 && idx < lines.length) {
          const parsed = parseTaskLine(lines[idx]);
          const hadOwnKanbanTag = parsed.tags.some((t) => config.normKanban.includes(normalizeTag(t)));
          let lineChanged = false;
          if (parsed.checked === true) {
            parsed.checked = false;
            parsed.doneDate = null;
            lineChanged = true;
          }
          if (!hadOwnKanbanTag && parsed.createdDate) {
            parsed.createdDate = null;
            lineChanged = true;
          }
          if (lineChanged) {
            lines[idx] = serializeTaskLine(parsed);
            changed = true;
          }
        }
        if (sub.subs?.length) recurse(sub.subs);
      }
    };
    recurse(subs);
    if (changed) await writeFileLines(app, tFile, lines);
    return changed;
  } catch (e: any) {
    console.error("uncheckSubtasks failed:", e);
    return false;
  }
}

// The monthly/column doc a card lands in when the "Insert into document"
// field is left untouched: {baseName}/{baseName}-YYYY-MM.md for ordinary
// columns, {baseName}/Later.md and {baseName}/Recurrent.md for those columns.
function computeDefaultDocName(rawInsertTarget: string, columnTag: string, config: KanbanConfig): string {
  const baseName = rawInsertTarget.trim().split("#")[0].replace(/\.md$/, "").trim();
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
  return `${baseName}/${targetFileName}`;
}

// vault.create() fails if a nested path's parent folder doesn't exist yet.
async function ensureParentFolder(app: App, path: string): Promise<void> {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return;
  const dir = path.slice(0, idx);
  if (!(app.vault.getAbstractFileByPath(dir) instanceof TFolder)) {
    await app.vault.createFolder(dir);
  }
}

async function addNewItem(
  app: App,
  columnTag: string,
  userText: string,
  dateStr: string | null,
  config: KanbanConfig,
  notesText = "",
  docName = "",
  defaultDocName = "",
  uncounted = false
): Promise<boolean> {
  try {
    if (!userText?.trim()) return false;

    let cardText = userText.trim();
    const noteLines = formatNoteLines("", notesText);

    // Task goes into the chosen (or newly created) doc; a [[link]] is added
    // to the master doc only when the target is both new and a deliberate
    // departure from the default monthly/column doc — that default doc isn't
    // a "project" just because it happened to be created just now.
    const docTitle = sanitizeDocTitle(docName.trim() || cardText);
    const wantedPath = `${docTitle.replace(/\.md$/i, "")}.md`;

    // Case-insensitive match: a bare Enter (no exact suggestion picked)
    // should still land in an existing note that only differs by case,
    // rather than creating a near-duplicate file.
    let projFile = app.vault.getAbstractFileByPath(wantedPath) as TFile | null;
    if (!projFile) {
      const wantedLower = wantedPath.toLowerCase();
      projFile = app.vault.getMarkdownFiles().find((f) => f.path.toLowerCase() === wantedLower) ?? null;
    }
    const wasNew = !projFile;
    if (!projFile) {
      await ensureParentFolder(app, wantedPath);
      projFile = await app.vault.create(wantedPath, "");
      new Notice(`Created new note "${projFile.path}".`);
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
    if (uncounted) newLine += " %% @uncounted %%";
    const projLines = (await app.vault.read(projFile)).split("\n");
    const insertAt = afterLeadingHeading(projLines, afterFrontMatter(projLines));
    projLines.splice(insertAt, 0, newLine, ...noteLines);
    await vaultModify(app, projFile, projLines.join("\n"));

    const isCustomTarget = docTitle.toLowerCase() !== sanitizeDocTitle(defaultDocName).toLowerCase();
    const masterDocName = config.projectsDocument.trim();
    if (wasNew && isCustomTarget && masterDocName) {
      const masterPath = masterDocName.endsWith(".md") ? masterDocName : `${masterDocName}.md`;
      let masterFile = app.vault.getAbstractFileByPath(masterPath) as TFile | null;
      if (!masterFile) {
        masterFile = await app.vault.create(masterPath, `# ${masterDocName}\n`);
      }
      const masterLines = (await app.vault.read(masterFile)).split("\n");
      masterLines.splice(afterFrontMatter(masterLines), 0, `[[${projFile.basename}]]`);
      await vaultModify(app, masterFile, masterLines.join("\n"));
    }

    new Notice(`Added "${userText}" to ${projFile.path}.`);
    return true;
  } catch (e: any) {
    console.error("addNewItem failed:", e);
    new Notice(`Failed to add item: ${e.message}`);
    return false;
  }
}

// The due column is hidden while empty (see buildBoard), so a settings change that
// touches it would otherwise leave it invisible with no way to confirm it worked.
// Drop an explanatory card in it, which also makes it reappear immediately.
export async function addDueColumnExplanationCard(app: App, config: KanbanConfig): Promise<boolean> {
  if (!config.dueColumn) return false;
  const text =
    "This column only shows up while it has cards in it — it disappears automatically when it's empty, " +
    "and reappears once the board moves a due-later or recurrent card into it.";
  const docName = computeDefaultDocName(config.newTaskInsert, config.dueColumn, config);
  return addNewItem(app, config.dueColumn, text, null, config, "", docName, docName);
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
  const wasLater = parsed.tags.some((t) => normalizeTag(t) === config.normLater);
  parsed.tags = parsed.tags.filter((t) => !config.normKanban.includes(normalizeTag(t)));
  parsed.tags.push(targetTag);
  // Leaving Later: its @date annotation was a trigger date, meaningless elsewhere.
  if (wasLater) parsed.date = null;
  parsed.orderDigits = null;
  const newTaskLine = serializeTaskLine(parsed);

  // Create or update the project document
  let projFile = app.vault.getAbstractFileByPath(docPath) as TFile | null;
  const isNew = !projFile;
  if (!projFile) projFile = await app.vault.create(docPath, "");
  const projLines = (await app.vault.read(projFile)).split("\n");
  projLines.splice(afterFrontMatter(projLines), 0, newTaskLine);
  await vaultModify(app, projFile, projLines.join("\n"));

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
    await vaultModify(app, masterFile, masterLines.join("\n"));
  }

  new Notice(isNew ? `Created "${safeTitle}.md" and moved task.` : `Moved task to existing "${safeTitle}.md".`);
}

const ARCHIVE_CALLOUT_HEADER = "> [!note]- Archived";

// Used by archiveToSection: locates a title-only copy of a card already
// sitting in the Archived callout, so a full archive can replace it in
// place instead of adding a duplicate entry for the same card. Matches on
// indent + bare text (TaskLine.text, i.e. ignoring tags/checkbox/dates)
// since ticking the real card changes those but not its text; indent is
// checked too so a subtask that happens to share the card's title text is
// never mistaken for the card's own placeholder line.
function findArchivedTitleLine(
  lines: string[],
  calloutIdx: number,
  plainTitle: string,
  indent: string
): number {
  if (calloutIdx < 0 || !plainTitle) return -1;
  for (let i = calloutIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith("> ")) continue;
    const parsed = parseTaskLine(l.slice(2));
    if (parsed.indent === indent && parsed.text.trim() === plainTitle) return i;
  }
  return -1;
}

async function archiveToSection(
  app: App,
  filePath: string,
  mainLineNum: number,
  subLines: any[],
  config: KanbanConfig,
  _isTopLevel = true,
  tickMain = true,
  keepRecurring = true
): Promise<boolean> {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);

    // Recurring cards reset back to active below; if any line in this block
    // recurs, leave the whole block where it is instead of archiving it.
    // Deleting a recurring card must skip this entirely (keepRecurring=false) —
    // otherwise a card whose preserved title still says "@recurrent" would
    // just get re-armed for its next occurrence instead of actually archiving.
    // Gated on _isTopLevel too: a promoted card (a subtask rendered as its own
    // board card because it carries its own kanban tag) is archived one at a
    // time with _isTopLevel=false and an empty subLines, so its own line is
    // both "main" and the whole block here — without this gate, a subtask that
    // happens to carry its own leftover "@recurrent" annotation would get
    // re-armed with the #recurrent tag by this same-line check and resurface
    // as its own phantom card in Recurrent, instead of just having its kanban
    // tag stripped like any other archived subtask.
    let hasRecurrentInBlock = false;

    function archiveLine(idx: number, tickBox: boolean) {
      if (idx < 0 || idx >= lines.length) return;
      const parsed = parseTaskLine(lines[idx]);
      // Captured before the filter below strips it: a subtask carrying its own
      // kanban tag is a "promoted" card in its own right (rendered as its own
      // board card), not a plain part of this one — see the createdDate strip
      // further down, which must leave such subtasks untouched.
      const hadOwnKanbanTag = parsed.tags.some((t) => config.normKanban.includes(normalizeTag(t)));
      parsed.tags = parsed.tags.filter((t) => !config.normKanban.includes(normalizeTag(t)));
      parsed.orderDigits = null;
      if (_isTopLevel && keepRecurring && config.normRecurrent && hasRecurrentAnnotation(lines[idx], config.normRecurrent)) {
        hasRecurrentInBlock = true;
        // Interval-based recurrence: push the next-fire date out by the repeat interval,
        // counted from the day the card was actually completed (not from whenever it
        // happens to get archived).
        const repeatSpec = extractRepeatSpec(lines[idx]);
        const completedOn = parsed.doneDate ? new Date(parsed.doneDate + "T00:00:00") : new Date();
        // Reset recurrent card: uncheck, restore #recurrent tag. The done-date
        // from the occurrence that just finished is deliberately kept (not
        // cleared) — it records when the card was last completed while it
        // sits in Recurrent, and is only cleared once the card fires again
        // into Due (see moveToColumn).
        if (parsed.checked !== null) parsed.checked = false;
        parsed.tags.push(config.recurrentColumn);
        parsed.date = repeatSpec ? formatDateAnnotation(addRepeatInterval(completedOn, repeatSpec)) : null;
        // Skip date is intentionally left untouched here: it was already stamped with
        // today when the card fired into Due, and that stamp is what stops same-day
        // re-firing once it returns to Recurrent (see moveToColumn). Restamping it to
        // the archiving date would be wrong if archiving happens on a later day.
        // Created-date is stripped: a card parked in Recurrent isn't "open
        // work" (see OPEN_EXCLUDED_TAGS/NEW_EXCLUDED_TAGS in
        // KanbanStatisticsView.ts), so it shouldn't carry a stale creation
        // date — stampMissingCreatedDates skips Recurrent cards, so this
        // stays cleared until the card actually fires back into Due, where
        // the next render backfills a fresh date for the new cycle.
        parsed.createdDate = null;
        lines[idx] = serializeTaskLine(parsed);
      } else if (tickBox && parsed.checked !== null) {
        parsed.checked = true;
        lines[idx] = serializeTaskLine(parsed);
      } else {
        // Subtask line (tickBox is always false for these calls, from recurse()
        // below). A completed plain subtask (no @recurrent annotation of its
        // own) resets to open when the recurring parent cycles back, so the
        // next occurrence starts fresh.
        if (!tickBox && hasRecurrentInBlock && parsed.checked === true) {
          parsed.checked = false;
          parsed.doneDate = null;
        }
        // Any subtask that isn't its own card (no kanban tag of its own —
        // see hadOwnKanbanTag above) is parked wherever the recurring parent
        // is, not open work in its own right, so its created-date is
        // stripped right along with the parent's — whether or not it was
        // just reset from checked above — so it isn't wrongly counted as
        // "newly opened" while still parked in Recurrent. A promoted
        // subtask (its own card) is left untouched here.
        if (!tickBox && hasRecurrentInBlock && !hadOwnKanbanTag) {
          parsed.createdDate = null;
        }
        lines[idx] = serializeTaskLine(parsed);
      }
    }

    const mainIdx = mainLineNum - 1;
    const endIdx = (maxSubLine(subLines) || mainLineNum) - 1;

    archiveLine(mainIdx, tickMain);
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
      const mainParsedForMatch = parseTaskLine(lines[mainIdx]);
      const blockLines = lines.slice(mainIdx, endIdx + 1).map((l) => `> ${l}`);
      lines.splice(mainIdx, endIdx - mainIdx + 1);

      const calloutIdx = lines.findIndex((l) => l.trim() === ARCHIVE_CALLOUT_HEADER);
      const existingTitleIdx = calloutIdx >= 0
        ? findArchivedTitleLine(lines, calloutIdx, mainParsedForMatch.text.trim(), mainParsedForMatch.indent)
        : -1;

      if (existingTitleIdx >= 0) {
        // "Archive done" already left a title-only placeholder here (with its
        // already-finished subtasks moved beneath it) — replace that single
        // line with the real card + remaining subtree, landing them right
        // where the placeholder was instead of duplicating the card.
        lines.splice(existingTitleIdx, 1, ...blockLines);
      } else if (calloutIdx >= 0) {
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

// Shared by every card/subtask deletion trigger (clearing a title/subtask
// text, and the highlight dialog's Delete button): a card with subtasks is
// always just marked deleted (removing it outright would silently discard
// every subtask beneath it), everything else asks the user to choose between
// marking deleted and permanently removing the line(s).
// Returns false if the user cancelled (nothing was written), true otherwise.
async function deleteCardOrSubtask(
  app: App,
  filePath: string,
  lineNum: number,
  lastLine: number,
  config: KanbanConfig,
  isCard: boolean,
  hasSubtasks: boolean,
  subs: any[],
  isPromoted: boolean,
  // True when some later sibling's ">" (or a direct child's "^") depends on
  // this subtask — see isDependedOn. Permanently removing the line would
  // corrupt that dependent's positional/parent bookkeeping, so only marking
  // it deleted (never a physical remove) is offered. Only ever meaningful
  // for a subtask, never a whole card — dependencies are always between
  // sibling subtasks.
  hasDependents: boolean = false
): Promise<boolean> {
  const markDeleted = async () => {
    await markLineDeleted(app, filePath, lineNum, config);
    if (isCard) {
      await archiveToSection(app, filePath, lineNum, subs, config, !isPromoted, false, false);
    }
  };

  if ((isCard && hasSubtasks) || hasDependents) {
    await markDeleted();
    return true;
  }

  const choice = await showDeleteChoiceDialog(app);
  if (choice === "mark") {
    await markDeleted();
    return true;
  }
  if (choice === "remove") {
    await deleteLineRange(app, filePath, lineNum, lastLine);
    return true;
  }
  return false;
}

async function promoteSubToChild(
  app: App,
  filePath: string,
  subLineNum: number,
  parentTag: string,
  parentDigits: string,
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
      .find((c: any) => c.digits != null && c.digits === parentDigits);

    const prevSibling = parentCard
      ? { digits: parentCard.digits || "0", len: parentCard.len || magLen(parentCard.digits || "0") }
      : { digits: parentDigits || "0", len: magLen(parentDigits || "0") };

    const higher = (columns[normParent]?.cards || [])
      .filter((c: any) => c.digits != null && compareDigits(c.digits, parentDigits) > 0)
      .sort((a: any, b: any) => compareDigits(a.digits, b.digits));

    // No sibling ordered after the parent falls through to calcMidDigits'
    // no-upper-bound case (hugs just above the parent, no forced digit growth).
    const newCalc: SiblingData = calcMidDigits(prevSibling, higher.length ? higher[0] : null);

    // A newly-promoted card starts expanded so its own subtasks (if any) are
    // immediately visible, unless it lands straight in Done/Later — a
    // session-only flag, not written to the file (see pendingForceExpand).
    const expandOnPromote = ![config.normDone, config.normLater].includes(normParent);

    // Write tag + order in a single file write
    const { tFile, lines } = await readFileLines(app, filePath);
    if (subLineNum < 1 || subLineNum > lines.length) return false;

    const parsed = parseTaskLine(lines[subLineNum - 1]);

    const finish = async (triggerAnnotation: string | null) => {
      if (!parsed.tags.some((t) => normalizeTag(t) === normParent)) {
        parsed.tags.push(parentTag);
      }
      if (normParent === config.normRecurrent) {
        applyRecurrentTrigger(parsed, config.normRecurrent, triggerAnnotation);
      }
      if (parentCard && !parsed.date) {
        const dm = parentCard.item.text.match(/@\d{4}-\d{2}-\d{2}/);
        if (dm) parsed.date = dm[0];
      }
      parsed.orderDigits = newCalc.digits;
      lines[subLineNum - 1] = serializeTaskLine(parsed);
      await writeFileLines(app, tFile, lines);
      if (expandOnPromote) pendingForceExpand.add(forceExpandKey(filePath, subLineNum));
      new Notice(`Tagged subtask with ${parentTag.replace(/^#/, "").toUpperCase()}.`);
    };

    // Promoting into Recurrent without an already-complete trigger asks for one
    // first — the same "Set" / "No trigger" choice offered by every other entry
    // point into that column — so a promoted subtask never ends up with the
    // "#recurrent" tag but no "@recurrent" annotation.
    if (
      normParent === config.normRecurrent &&
      !(hasRecurrentAnnotation(parsed.text, config.normRecurrent) && hasValidTriggers(parsed.text, config.normRecurrent))
    ) {
      showRecurrentTriggerDialog(app, async (trigger) => {
        await finish(trigger);
        requestAnimationFrame(() => setTimeout(refresh, 50));
      }, extractTriggerAnnotations(parsed.text, config.normRecurrent), extractRepeatSpec(parsed.text));
      return true;
    }

    await finish(null);
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

function setLevels(node: any, level = 0) {
  node.hierarchy_level = level;
  node.subs?.forEach((s: any) => setLevels(s, level + 1));
}

// Tab stop width (columns) used only for comparing indentation depth —
// matches Obsidian's own default tab width, so a tab and 4 spaces of
// indentation read as the same depth instead of a tab (1 character) losing
// to a 4-space indent.
//
// Deliberately NOT paired with a minimum-nest-past-parent floor (e.g.
// requiring +2 columns, matching CommonMark's "- " marker width): a vault
// scan turned up many existing notes that rely on a single extra space for
// looser nesting throughout an entire outline, not just as an isolated
// mistake. A floor treats every one of those as "not nested," which pops
// the real ancestor off the stack for good — so a stray shallow line
// permanently detaches everything typed after it (further down the file,
// at a normal deeper indent) from a project card it was still meant to be
// under, and any of those with no kanban tag of their own then vanish from
// the board entirely. Comparing tab-expanded columns with a plain "deeper
// than parent" rule (any increase counts) fixes the tabs-vs-spaces
// miscompare without that collateral damage.
const INDENT_TAB_WIDTH = 4;

// Leading-whitespace column width, with tabs expanded to the next tab stop.
// A bare tab and a single space both have raw .length 1, but very different
// visual/semantic depth — comparing indentation by character count alone
// (as this used to) silently treats them as equal.
function indentColumns(ws: string): number {
  let col = 0;
  for (const ch of ws) {
    col += ch === "\t" ? INDENT_TAB_WIDTH - (col % INDENT_TAB_WIDTH) : 1;
  }
  return col;
}

// Rewrites a line's leading whitespace to tabs-only, rounding its column
// width up to the nearest tab stop — e.g. a stray single space (column 1,
// probably meant as "one level" but typed as a space instead of a tab)
// becomes one full tab (column 4), matching a sibling that already used a
// real tab. A pure multiple-of-4 space indent (column 4, 8, ...) round-trips
// losslessly since it already lands exactly on a tab stop. Returns null when
// there's no space to convert (already tabs-only, or no indentation at all)
// so callers can tell "nothing to do" from "converted to zero tabs".
function normalizeIndentWhitespace(ws: string): string | null {
  if (!ws.includes(" ")) return null;
  const tabs = Math.ceil(indentColumns(ws) / INDENT_TAB_WIDTH);
  return "\t".repeat(tabs);
}

// Every line reachable from a tagged card's own subtree, however deep —
// i.e. everything parseFileEntries considers part of "this kanban card's
// data", regardless of whether the current (possibly still tabs-vs-spaces
// miscomputed) nesting depth is itself correct.
function collectSubLineNumbers(subs: any[], out: Set<number>): void {
  for (const s of subs ?? []) {
    out.add(s.line);
    collectSubLineNumbers(s.subs, out);
  }
}

// Auto-heals the exact bug class the tab-width fix above can't fully cover
// on its own: a line typed with spaces instead of a tab (e.g. pasted from
// elsewhere, or a stray auto-indent) silently nests under the wrong parent
// because its column comes out shallower than intended. Since every kanban
// card's subtree is walked here regardless of the current (possibly wrong)
// depth, a line ends up in scope as long as it's reachable at all from a
// tagged root — only its own leading whitespace gets rewritten, never its
// content. Returns the corrected lines, or null if nothing needed fixing.
function normalizeKanbanIndentation(lines: string[], fileItems: any[]): string[] | null {
  const kanbanLines = new Set<number>();
  for (const e of fileItems) {
    kanbanLines.add(e.item.line);
    collectSubLineNumbers(e.item.subs, kanbanLines);
  }

  let changed = false;
  const newLines = lines.slice();
  for (const lineNum of kanbanLines) {
    const raw = newLines[lineNum - 1];
    if (typeof raw !== "string") continue;
    const ws = (raw.match(/^(\s*)/) || [""])[0];
    const normalized = normalizeIndentWhitespace(ws);
    if (normalized !== null) {
      newLines[lineNum - 1] = normalized + raw.slice(ws.length);
      changed = true;
    }
  }
  return changed ? newLines : null;
}

// Nearest ancestor on the current outline stack that itself carries a
// kanban tag — i.e. the ancestor that gets its own card rendered elsewhere
// on the board. Untagged ancestors (plain outline sections/headings with no
// column tag) are skipped over, since they never become a card to link to.
function nearestTaggedAncestor(stack: any[], config: KanbanConfig): any | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].item.tags.some((t: string) => matchesKanbanTag(t, config.normKanban)))
      return stack[i];
  }
  return null;
}

// One file's contribution to collectItems' result — everything collectItems
// used to compute per-line inside its own loop, minus discoveryIndex (that's
// inherently cross-file, assigned by collectItems once entries are merged).
// Cached per file by getCachedFileEntries; only config.normKanban (the
// configured column tag list) affects this function's output, so the cache
// only needs invalidating when that list changes, not on every render.
function parseFileEntries(lines: string[], filePath: string, config: KanbanConfig): any[] {
  const fileItems: any[] = [];

  const LIST_RE = /^(\s*)(?:[-*+]|\d+[\.\)]|-\s*\[\s*\])\s+/;
  const CODE_RE = /^[\s]*```/;
  const EMBED_RE = /^[\s]*!\[\[/;
  const LINK_RE = /^[\s]*\[\[/;

  let start = 0;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === "---") {
        start = i + 1;
        break;
      }
    }
  }
  const body = lines.slice(start);

  let inCode = false;
  const stack: any[] = [];

  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    if (typeof line !== "string") continue;
    const trim = line.trim();
    if (!trim || trim.toLowerCase().includes("#exclude")) continue;
    if (CODE_RE.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode || EMBED_RE.test(line) || LINK_RE.test(line)) continue;

    const col = indentColumns((line.match(/^(\s*)/) || [""])[0]);

    // Headings with kanban tags
    const hMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (hMatch) {
      const tags = extractTags(hMatch[2]);
      // Every heading — tagged or not — closes any list nesting still open
      // from before it. Without this, an untagged heading (e.g. a plain
      // "## Notes" section break) leaves a stale card's subtree "open" on
      // the stack, so unrelated indented content further down the file can
      // get silently attributed as that card's subtask.
      while (
        stack.length &&
        stack[stack.length - 1].col >= col
      ) {
        const p = stack.pop();
        if (
          p.item.tags.some((t: string) =>
            matchesKanbanTag(t, config.normKanban)
          )
        )
          fileItems.push(p);
      }
      if (tags.some((t: string) => matchesKanbanTag(t, config.normKanban))) {
        const parsed = parseOrderComment(hMatch[2]);
        stack.push({
          item: { text: hMatch[2].trim(), tags, line: i + 1 + start, subs: [] },
          source: { path: filePath },
          filePath,
          digits: parsed?.digits ?? null,
          len: parsed?.len ?? null,
          isPromoted: stack.length > 0,
          indent: stack.length ? col : 0,
          col,
          hierarchy_level: stack.length,
          inheritedColor: stack.length
            ? (extractCardColor(stack[stack.length - 1].item.text) || stack[stack.length - 1].inheritedColor || null)
            : null,
          parentRef: nearestTaggedAncestor(stack, config),
        });
      }
      continue;
    }

    if (!LIST_RE.test(line)) continue;

    const ownTags = extractTags(line);
    const parsed = parseOrderComment(trim);

    // A following line nests under the current stack top as soon as its
    // column exceeds that top's own column at all (same "any increase
    // counts" rule as before the tab-width fix) — otherwise the top is done
    // (a sibling or a completed deeper scope) and gets popped.
    while (
      stack.length &&
      stack[stack.length - 1].col >= col
    ) {
      const p = stack.pop();
      if (
        p.item.tags.some((t: string) =>
          matchesKanbanTag(t, config.normKanban)
        )
      )
        fileItems.push(p);
    }

    const entry: any = {
      item: { text: trim, tags: ownTags, line: i + 1 + start, subs: [] },
      source: { path: filePath },
      filePath,
      digits: parsed?.digits ?? null,
      len: parsed?.len ?? null,
      isPromoted: stack.length > 0 && ownTags.some((t: string) =>
        matchesKanbanTag(t, config.normKanban)
      ),
      // 0 when this line has no parent on the stack (i.e. it's not really
      // anyone's child) — matches isPromoted rather than echoing the source
      // line's raw indentation regardless of whether it actually nested.
      indent: stack.length ? col : 0,
      col,
      hierarchy_level: stack.length,
      // Nearest ancestor's own (or itself-inherited) color — used as this
      // item's card color only when it has no "%% @color %%" of its own,
      // and only once this item is itself rendered as a card (a promoted
      // sub-task getting its own top-level card). Nested/unpromoted display
      // (renderSub) never uses this — see createCardHTML.
      inheritedColor: stack.length
        ? (extractCardColor(stack[stack.length - 1].item.text) || stack[stack.length - 1].inheritedColor || null)
        : null,
      // The nearest ancestor that itself gets its own card — used to show a
      // "belongs to <parent>" link on this card's badge row (createCardHTML)
      // instead of "from: <file>" when this item is a promoted sub-task.
      parentRef: nearestTaggedAncestor(stack, config),
    };

    // The pop loop above guarantees that whatever remains on top (if
    // anything) is strictly shallower than `col` — no need to recheck it
    // here.
    if (stack.length) {
      stack[stack.length - 1].item.subs.push(entry.item);
    }

    stack.push(entry);
  }

  while (stack.length) {
    const e = stack.pop();
    if (
      e.item.tags.some((t: string) => matchesKanbanTag(t, config.normKanban))
    )
      fileItems.push(e);
  }

  return fileItems.map((e) => {
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

// Whole-cache generation marker: parseFileEntries' output depends on
// config.normKanban (see above), so a change to the configured column tag
// list must invalidate every cached entry, not just one file's.
let cachedKanbanSignature: string | null = null;

async function getCachedFileEntries(app: App, filePath: string, config: KanbanConfig): Promise<any[]> {
  const signature = config.normKanban.join(",");
  if (signature !== cachedKanbanSignature) {
    fileEntryCache.clear();
    cachedKanbanSignature = signature;
  }
  const tFile = app.vault.getAbstractFileByPath(filePath) as TFile | null;
  if (!tFile) return [];
  const cached = fileEntryCache.get(filePath);
  if (cached && cached.mtime === tFile.stat.mtime) return cached.entries;
  const lines = await getCachedFileLines(app, filePath);
  const entries = parseFileEntries(lines, filePath, config);

  const normalizedLines = normalizeKanbanIndentation(lines, entries);
  if (normalizedLines) {
    await writeFileLines(app, tFile, normalizedLines);
    // Don't guess at the post-write mtime — just drop both caches for this
    // file so the next scan does a normal, correct read/parse/cache cycle.
    // The re-parse below (in memory, not yet cached) is only so *this*
    // render already reflects the fix instead of lagging one refresh.
    invalidateCachedFile(filePath);
    return parseFileEntries(normalizedLines, filePath, config);
  }

  fileEntryCache.set(filePath, { mtime: tFile.stat.mtime, entries });
  return entries;
}

export async function collectItems(
  app: App,
  targetFilePaths: string[],
  config: KanbanConfig
): Promise<any[]> {
  const allItems: any[] = [];
  let discoveryIdx = 0;

  for (const filePath of targetFilePaths) {
    const fileItems = await getCachedFileEntries(app, filePath, config);
    for (const e of fileItems) {
      const key = forceExpandKey(filePath, e.item.line);
      // pendingForceExpand is peeked, not consumed here — getCachedFileEntries'
      // result may be shared across several collectItems calls within one
      // buildBoard pass, and only that pass's final item list should actually
      // consume the flag (see the loop in buildBoard right after items
      // settles). currentlyExpandedKey isn't one-shot at all — see its
      // comment above.
      const state: "expanded" | "collapsed" =
        (pendingForceExpand.has(key) || currentlyExpandedKey === key) ? "expanded" : "collapsed";
      allItems.push({ ...e, state, discoveryIndex: discoveryIdx++ });
    }
  }

  return allItems;
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

  Object.values(columns).forEach((col) => col.cards.sort(compareCardsByDigits));
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
          ? { ...c, digits: "0" }
          : c
      );
    }
  }

  for (const col of Object.values(columns)) {
    const ordered = col.cards.filter(
      (c: any) => c.digits != null && !c.multiTag
    );
    const unordered = col.cards
      .filter((c: any) => c.digits == null && !c.multiTag)
      .sort((a: any, b: any) => a.discoveryIndex - b.discoveryIndex);
    if (!unordered.length) continue;

    // New (unordered) cards are slotted before the lowest already-ordered
    // card (discovery order preserved), each one computed with the same
    // shortest-value-between-bounds primitive the drag-and-drop path uses —
    // working backwards from the anchor so every step only needs to stay
    // below the slot just assigned after it.
    const anchor: SiblingData = ordered.length
      ? { digits: ordered[0].digits, len: ordered[0].len || magLen(ordered[0].digits) }
      : { digits: "9", len: 1 };
    const slots: SiblingData[] = new Array(unordered.length);
    let bound = anchor;
    for (let i = unordered.length - 1; i >= 0; i--) {
      bound = calcMidDigits(null, bound);
      slots[i] = bound;
    }

    for (let i = 0; i < unordered.length; i++) {
      const { digits, len } = slots[i];
      await updateFileOrderComment(
        app,
        unordered[i].filePath,
        unordered[i].item.line,
        digits
      );
      Object.assign(unordered[i], { digits, len });
    }

    col.cards.sort(compareCardsByDigits);
  }
}

// ─── DIALOG HELPERS ───────────────────────────────────────────────────────────

let _dialogDoc: Document = document;

function makeOverlay(id: string, app: App) {
  const doc = _dialogDoc;
  doc.getElementById(id)?.remove();
  const overlay = doc.createElement("div");
  overlay.id = id;
  // 100vw/100vh rather than 100% — a `position:fixed` element with a
  // percentage size resolves against its nearest transformed ancestor (if
  // any), not the real viewport. Obsidian's app shell can apply a transform
  // for view transitions, which would otherwise shrink this overlay (and
  // anything centered inside it) to less than the full window.
  overlay.style.cssText =
    "position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;";
  doc.body.appendChild(overlay);
  const dialog = doc.createElement("div");
  dialog.style.cssText =
    "background:var(--background-primary);color:var(--kb-dialog-text,var(--text-normal));padding:20px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:300px;max-width:400px;max-height:90vh;overflow-y:auto;text-align:center;";
  overlay.appendChild(dialog);

  // This overlay is appended straight to <body>, outside any workspace
  // leaf's own DOM — so it never gets a fair shot at a plain "keydown"
  // listener for Escape: Obsidian's own global hotkey Scope intercepts
  // Escape before it can bubble to a listener here, regardless of what
  // element inside this dialog currently has focus. Obsidian's own Modal
  // class works around exactly this by pushing its own Scope while open, so
  // its registered handler runs first; we do the same here rather than
  // relying on DOM bubbling, which is what actually let Escape leak through
  // to Obsidian's default handling (closing/switching the active tab).
  const scope = new Scope();
  let onEscape: () => void = () => close();
  scope.register([], "Escape", () => { onEscape(); return false; });
  app.keymap.pushScope(scope);

  const close = () => {
    app.keymap.popScope(scope);
    overlay.remove();
  };
  return {
    overlay,
    dialog,
    close,
    setEscapeHandler: (fn: () => void) => { onEscape = fn; },
  };
}

// Ctrl+Enter (Cmd+Enter on Mac) is Obsidian's own "Follow link under cursor"
// hotkey, resolved through app.keymap's Scope stack before a keydown ever
// reaches a plain DOM listener here — the same reason the Scope above exists
// to reclaim Escape for this file's own dialogs. Pushing a Scope that shadows
// Mod+Enter for the lifetime of an inline text edit lets that combo insert a
// newline instead of following a link; callers must pop it (call the
// returned function) once editing ends, on every exit path.
function withNewlineOnModEnter(
  app: App,
  input: HTMLTextAreaElement,
  autoResize: () => void
): () => void {
  const scope = new Scope();
  scope.register(["Mod"], "Enter", () => {
    const value = input.value;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    input.value = value.slice(0, start) + "\n" + value.slice(end);
    const pos = start + 1;
    input.setSelectionRange(pos, pos);
    autoResize();
    return false;
  });
  app.keymap.pushScope(scope);
  return () => app.keymap.popScope(scope);
}

function inputStyle() {
  return "width:100%;padding:8px;margin-bottom:10px;border:1px solid var(--background-modifier-border);border-radius:4px;box-sizing:border-box;background:var(--background-secondary);color:var(--text-normal);";
}

// Narrower than inputStyle()'s full width on purpose: a full-width native
// <input type="date"> gives iPadOS Safari enough room to switch from its
// compact picker to an expanded inline calendar grid, which grows the dialog
// tall enough to push the action buttons off-screen.
function dateInputStyle() {
  return "width:auto;max-width:160px;padding:8px;margin:0 auto 10px;display:block;border:1px solid var(--background-modifier-border);border-radius:4px;box-sizing:border-box;background:var(--background-secondary);color:var(--text-normal);";
}

// Lines that overflow the field width wrap instead of requiring horizontal
// scrolling. Indentation-sensitive whitespace (tabs/spaces used to encode
// subtask nesting) is still preserved via pre-wrap.
function textareaStyle() {
  return inputStyle() + "min-height:70px;resize:vertical;font-family:inherit;white-space:pre-wrap;overflow-wrap:break-word;";
}

// Placeholder glyph shown on the checklist-insert button; expanded to "- [ ] "
// before a note/subtask line is otherwise processed.
const CHECKLIST_MARK = "☐"; // ☐

// Turns pasted/typed notes text into sub-bullet lines under a newly created card.
// Lines already formatted as "- text" or "- [ ]"/"- [x]" checkboxes are kept as-is;
// anything else gets turned into a plain "-" bullet. Nesting depth between lines
// is derived from the hierarchy (each line's raw indent compared to its still-open
// ancestors on a stack), not copied verbatim from however many spaces/tabs the
// user happened to type — so depth normalizes to exactly one tab per level,
// shifted one level under the card's own indent.
function formatNoteLines(cardIndent: string, notesText: string): string[] {
  if (!notesText || !notesText.trim()) return [];
  const expanded = notesText.split(CHECKLIST_MARK).join("- [ ] ");
  const rawLines = expanded.replace(/\r\n/g, "\n").split("\n");
  while (rawLines.length && rawLines[0].trim() === "") rawLines.shift();
  while (rawLines.length && rawLines[rawLines.length - 1].trim() === "") rawLines.pop();
  if (!rawLines.length) return [];

  let minIndent = Infinity;
  for (const line of rawLines) {
    if (line.trim() === "") continue;
    minIndent = Math.min(minIndent, (line.match(/^(\s*)/) || [""])[0].length);
  }
  if (!isFinite(minIndent)) minIndent = 0;

  const stack: number[] = [];
  return rawLines.map((line) => {
    if (line.trim() === "") return "";
    const stripped = line.slice(minIndent);
    const rawIndentLen = (stripped.match(/^(\s*)/) || [""])[0].length;
    const content = stripped.slice(rawIndentLen);
    while (stack.length && stack[stack.length - 1] >= rawIndentLen) stack.pop();
    stack.push(rawIndentLen);
    const level = stack.length; // 1 = first level directly under the card
    const bulleted = /^-\s/.test(content) ? content : `- ${content}`;
    return `${cardIndent}${"\t".repeat(level)}${bulleted}`;
  });
}

// Appends a suffix (date/annotation) to the end of the first line of a
// possibly-multi-line string, leaving any further lines untouched.
function appendToFirstLine(text: string, suffix: string): string {
  const idx = text.indexOf("\n");
  if (idx === -1) return `${text} ${suffix}`;
  return `${text.slice(0, idx)} ${suffix}${text.slice(idx)}`;
}

function checklistButtonHtml(id: string, title: string) {
  const style = "padding:3px 10px;border-radius:12px;border:1px solid var(--background-modifier-border);background:none;cursor:pointer;font-size:1em;line-height:1;display:inline-flex;align-items:center;gap:6px;color:inherit;margin-bottom:10px;";
  return `<button type="button" id="${id}" title="${title}" style="${style}">Insert &#9744;</button>`;
}

// A plain (unstyled) checkbox + label, shared by the add-card dialogs and the
// edit-card dialog for toggling the "%% @uncounted %%"/"%% @uncounted_children %%"
// markers — see the UNCOUNTED section near DELETED_TAG/ARCHIVED_TAG.
function uncountedCheckboxHtml(id: string, label: string, checked: boolean): string {
  const style = "display:flex;align-items:center;gap:6px;font-size:.9em;color:var(--text-muted);margin-bottom:10px;cursor:pointer;";
  return `<label style="${style}"><input type="checkbox" id="${id}"${checked ? " checked" : ""}> ${label}</label>`;
}

// The doc-name field's "▾" browse button: reveals the file-suggest popover
// (see wireDocNameField) without needing to press an arrow/Tab key first.
function docBrowseBtnStyle() {
  return "padding:0 10px;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-secondary);color:var(--text-normal);cursor:pointer;font-size:1em;line-height:1;";
}

function docNameFieldHtml() {
  return `<div style="text-align:left;margin-bottom:12px;">
    <label style="display:block;margin-bottom:4px;color:var(--text-muted);font-size:.85em;">Insert into document</label>
    <div style="display:flex;gap:6px;">
      <input id="k-doc-name" type="text" style="${inputStyle()}margin-bottom:0;flex:1;">
      <button type="button" id="k-doc-browse" title="Browse notes" style="${docBrowseBtnStyle()}">&#9662;</button>
    </div>
    <div id="k-doc-spacer" style="height:0;"></div>
  </div>`;
}

// Inserts the checklist placeholder glyph at the start of the line the cursor is
// currently on, after any existing leading whitespace so indentation is preserved.
// The glyph is expanded to "- [ ] " by formatNoteLines when the card/subtask is saved.
function insertChecklistPrefix(textarea: HTMLTextAreaElement) {
  const value = textarea.value;
  const pos = textarea.selectionStart ?? value.length;
  const lineStart = value.lastIndexOf("\n", pos - 1) + 1;
  const lineEnd = (() => { const i = value.indexOf("\n", lineStart); return i === -1 ? value.length : i; })();
  const leadingWs = (value.slice(lineStart, lineEnd).match(/^[ \t]*/) || [""])[0];
  const insertPos = lineStart + leadingWs.length;
  const prefix = CHECKLIST_MARK;
  textarea.value = value.slice(0, insertPos) + prefix + value.slice(insertPos);
  const newPos = Math.max(pos, insertPos) + prefix.length;
  textarea.focus();
  textarea.setSelectionRange(newPos, newPos);
}

function buttonHtml(label: string, accent: boolean) {
  const bg = accent ? "var(--kb-dialog-text, var(--text-normal))" : "var(--background-modifier-border)";
  const color = accent ? "#fff" : "var(--text-normal)";
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

// Turns raw card text into a usable note title/path: strips %%comments%%,
// @annotations, and filename-illegal characters, but deliberately keeps "/"
// so a typed "Folder/Note" targets an existing subfolder instead of being
// flattened into "Folder Note".
function sanitizeDocTitle(text: string): string {
  return text
    .replace(/\s*%%[\s\S]*?%%\s*/g, " ")
    .replace(/@\S+/g, "")
    .replace(/[\\:*?"<>|#\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Bumps an insert index past a leading "# Heading" line, if present, so new
// content lands under a note's title rather than above it.
function afterLeadingHeading(lines: string[], insertAt: number): number {
  return lines[insertAt]?.match(/^#\s/) ? insertAt + 1 : insertAt;
}

function showConfirmDialog(app: App, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { dialog, close, setEscapeHandler } = makeOverlay("kanban-confirm-dialog", app);
    dialog.innerHTML = `
      <p style="margin:0 0 16px;font-size:.95em;">${message}</p>
      <div style="display:flex;gap:10px;justify-content:center;">${buttonHtml("Yes", true)}${buttonHtml("No", false)}</div>`;
    const [yesBtn, noBtn] = dialog.querySelectorAll("button");
    yesBtn.onclick = () => { close(); resolve(true); };
    noBtn.onclick = () => { close(); resolve(false); };
    setEscapeHandler(() => { close(); resolve(false); });
  });
}

// Offered whenever a card or subtask is deleted (see deleteCardOrSubtask) —
// deleteCardOrSubtask skips this entirely for a card that has subtasks,
// since permanently removing one would silently discard all of them.
function showDeleteChoiceDialog(app: App): Promise<"mark" | "remove" | null> {
  return new Promise((resolve) => {
    const { dialog, close, setEscapeHandler } = makeOverlay("kanban-delete-choice-dialog", app);
    dialog.innerHTML = `
      <p style="margin:0 0 16px;font-size:.95em;">Delete this task?</p>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">${buttonHtml("Mark as deleted", true)}${buttonHtml("Delete permanently", false)}${buttonHtml("Cancel", false)}</div>`;
    const [markBtn, removeBtn, cancelBtn] = dialog.querySelectorAll("button");
    markBtn.onclick = () => { close(); resolve("mark"); };
    removeBtn.onclick = () => { close(); resolve("remove"); };
    cancelBtn.onclick = () => { close(); resolve(null); };
    setEscapeHandler(() => { close(); resolve(null); });
  });
}

// Attaches Obsidian's native type-ahead popover (the same component behind its
// own [[link]] autocomplete) to a plain <input>, filtering the vault's
// markdown files as the user types.
class DocSuggest extends AbstractInputSuggest<TFile> {
  // Fires whenever `enabled` changes, from any code path (wireDocNameField's
  // reveal/Escape/Enter handling, or selectSuggestion below) — lets the
  // dialog reserve/collapse layout space for the popover in lockstep with it
  // actually opening or closing, rather than guessing at its real height.
  onEnabledChange: ((enabled: boolean) => void) | null = null;
  private _enabled = false;
  // Suppresses Obsidian's automatic open-on-focus/open-on-type behavior; the
  // popover only actually renders once something explicitly flips this (arrow
  // keys, Tab, or the browse button — see wireDocNameField) and calls open().
  get enabled(): boolean { return this._enabled; }
  set enabled(v: boolean) {
    this._enabled = v;
    this.onEnabledChange?.(v);
  }
  private matches = new Map<TFile, SearchResult>();

  constructor(app: App, private inputEl: HTMLInputElement) {
    super(app, inputEl);
    // Never show more than the first 7 matches of the current filter.
    this.limit = 7;
  }

  open(): void {
    if (this.enabled) super.open();
  }

  getSuggestions(query: string): TFile[] {
    this.matches.clear();
    if (!query.trim()) return this.app.vault.getMarkdownFiles().slice(0, this.limit || 100);
    const search = prepareFuzzySearch(query);
    const scored: { file: TFile; score: number }[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const result = search(file.path);
      if (result) {
        this.matches.set(file, result);
        scored.push({ file, score: result.score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.file);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.createDiv({ text: file.basename });
    const match = this.matches.get(file);
    if (file.parent && !file.parent.isRoot()) {
      const pathEl = el.createDiv();
      pathEl.style.cssText = "font-size:.8em;color:var(--text-muted);";
      if (match) renderResults(pathEl, file.path, match);
      else pathEl.setText(file.parent.path);
    }
  }

  selectSuggestion(file: TFile): void {
    this.setValue(file.parent && !file.parent.isRoot() ? file.path.replace(/\.md$/, "") : file.basename);
    this.enabled = false;
    this.close();
    this.inputEl.dispatchEvent(new Event("input"));
  }
}

// Shared by showInputDialog/showDateDialog's always-visible "Insert into
// document" field: prepopulated with the computed default (the monthly/column
// doc a card would land in anyway), with the native file-suggest popover
// gated to open only on explicit request (arrow keys, Tab, or the browse
// button) rather than on every keystroke or on focus.
function wireDocNameField(app: App, dialog: HTMLElement, defaultDocName: string, onEnter: () => void, close: () => void, setEscapeHandler: (fn: () => void) => void): () => string {
  const docNameInput = dialog.querySelector("#k-doc-name") as HTMLInputElement;
  const browseBtn = dialog.querySelector("#k-doc-browse") as HTMLButtonElement;
  const spacer = dialog.querySelector("#k-doc-spacer") as HTMLElement;
  const docSuggest = new DocSuggest(app, docNameInput);
  docNameInput.value = defaultDocName;

  // Reserves real layout space for up to 7 suggestion rows (some two-line,
  // for files outside the vault root) so the popover — which renders as an
  // independent overlay, not as part of this dialog's flow — has its own
  // room instead of needing to out-rank the Add/Cancel buttons below it.
  docSuggest.onEnabledChange = (open) => {
    spacer.style.height = open ? "300px" : "0";
  };

  // Tracks whether the user has explicitly moved the suggestion highlight
  // with arrow keys since the last edit. Obsidian's popover auto-highlights
  // the top match as soon as it renders, so a bare Enter would otherwise
  // silently accept that match instead of the box's own text.
  let navigated = false;
  // Set while we're re-dispatching Enter ourselves (see Tab below), so our
  // own listener doesn't re-intercept the very event it forwarded.
  let forwardingEnter = false;
  const reveal = () => {
    docSuggest.enabled = true;
    docSuggest.open();
  };

  // Select the prepopulated default the first time the field is focused, so
  // typing immediately replaces it instead of inserting into the middle.
  // Only the first time: once the user has actually edited it, later
  // refocuses shouldn't blow their edit away.
  let firstFocus = true;
  docNameInput.addEventListener("focus", () => {
    if (firstFocus) {
      firstFocus = false;
      docNameInput.select();
    }
  });

  browseBtn.addEventListener("click", () => {
    docNameInput.focus();
    reveal();
  });
  docNameInput.addEventListener("blur", () => { docSuggest.enabled = false; });
  docNameInput.addEventListener("input", () => { navigated = false; });
  // Capture phase so this runs before Obsidian's own suggest-popover key
  // handling.
  docNameInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      navigated = true;
      reveal();
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (!docSuggest.enabled) {
        // Not open yet — Tab's job here is just to open it, not to accept
        // anything (there's nothing meaningfully highlighted yet).
        reveal();
      } else {
        // Already open — accept whatever suggestion is currently highlighted
        // (by arrow keys or mouse hover) without submitting, by handing off
        // to Obsidian's own accept-highlighted-item handling rather than
        // reimplementing highlight-tracking ourselves.
        forwardingEnter = true;
        docNameInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        forwardingEnter = false;
      }
    } else if (e.key === "Enter" && !navigated && !forwardingEnter) {
      // An unnavigated Enter is ours to resolve (exact match or new document,
      // handled downstream in addNewItem), not the popover's default pick.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      docSuggest.enabled = false;
      docSuggest.close();
      onEnter();
    }
  }, true);

  // Same contract as every other field in these dialogs: Escape closes the
  // dialog like Cancel. A first Escape while the suggest popover happens to
  // be open just dismisses that popover instead, matching standard combobox
  // behavior; a second Escape then falls through to closing — checked fresh
  // against docSuggest.enabled each time this fires, not just once here.
  setEscapeHandler(() => {
    if (docSuggest.enabled) {
      docSuggest.enabled = false;
      docSuggest.close();
    } else {
      close();
    }
  });

  return () => docNameInput.value.trim();
}

function showInputDialog(title: string, app: App, defaultDocName: string, onSubmit: (v: string, notes: string, docName: string, uncounted: boolean) => void) {
  const { dialog, close, setEscapeHandler } = makeOverlay("kanban-input-dialog", app);
  dialog.innerHTML = `<h3 style="margin:0 0 10px;font-size:1.1em;">${title}</h3>
    <input id="k-text" type="text" placeholder="Enter new item text..." style="${inputStyle()}" autofocus>
    <details id="k-notes-details" style="text-align:left;margin-bottom:10px;">
      <summary style="cursor:pointer;color:var(--text-muted);">Add subtasks</summary>
      <textarea id="k-notes" placeholder="Subtasks..." style="${textareaStyle()}margin-top:10px;"></textarea>
      <div style="text-align:left;">${checklistButtonHtml("k-notes-checklist", "Insert checklist item")}</div>
    </details>
    <div style="text-align:left;">${uncountedCheckboxHtml("k-uncounted", "Don't count this card in statistics", false)}</div>
    ${docNameFieldHtml()}
    <div id="k-actions" style="display:flex;gap:10px;justify-content:center;">${buttonHtml("Add", true)}${buttonHtml("Cancel", false)}</div>`;

  const [addBtn, cancelBtn] = dialog.querySelectorAll<HTMLButtonElement>("#k-actions button");
  const input = dialog.querySelector("#k-text") as HTMLInputElement;
  const notesInput = dialog.querySelector("#k-notes") as HTMLTextAreaElement;
  const checklistBtn = dialog.querySelector("#k-notes-checklist") as HTMLButtonElement;
  const uncountedInput = dialog.querySelector("#k-uncounted") as HTMLInputElement;
  let submit: () => void;
  const getDocName = wireDocNameField(app, dialog, defaultDocName, () => submit(), close, setEscapeHandler);
  submit = () => {
    const v = input.value.trim();
    const notes = notesInput.value;
    const docName = getDocName();
    const uncounted = uncountedInput.checked;
    close();
    if (v) onSubmit(v, notes, docName, uncounted);
  };
  addBtn.onclick = submit;
  cancelBtn.onclick = close;
  checklistBtn.onclick = () => insertChecklistPrefix(notesInput);
  input.onkeydown = (e) => {
    if (e.key === "Enter") submit();
  };
  input.focus();
}

// Shared date-picker dialog for #later cards. Pass opts.withText to also collect
// item text + "insert in document" (the "add card to Later" flow); omit it for a
// plain date-only picker (move-to-Later, change date, subtask date).
function showDateDialog(
  title: string,
  defaultDate: string,
  app: App,
  onSubmit: (dateStr: string | null, text?: string, notes?: string, docName?: string, uncounted?: boolean) => void,
  opts: { withText?: boolean; defaultDocName?: string } = {}
) {
  const { withText, defaultDocName } = opts;
  const { dialog, close, setEscapeHandler } = makeOverlay(withText ? "kanban-later-add-dialog" : "kanban-date-dialog", app);
  const presetBtnStyle = (active: boolean) =>
    `padding:4px 10px;border:none;border-radius:12px;cursor:pointer;font-size:.75em;` +
    (active
      ? `background:var(--kb-dialog-text, var(--text-normal));color:#fff;`
      : `background:var(--background-modifier-border);color:var(--text-normal);`);
  let selectedPreset: string | null =
    DATE_PRESETS.find(([, , fn]) => fn().toISOString().split("T")[0] === defaultDate)?.[0] ?? null;
  const presetBtnsHtml = DATE_PRESETS.map(
    ([key, label]) => `<button type="button" class="kb-date-preset" data-preset="${key}" style="${presetBtnStyle(key === selectedPreset)}">${label}</button>`
  ).join("");

  dialog.innerHTML = `<h3 style="margin:0 0 10px;font-size:1.1em;">${title}</h3>
    ${withText ? `<input id="k-text" type="text" placeholder="Enter new item text..." style="${inputStyle()}" autofocus>` : ""}
    ${withText ? `<details id="k-notes-details" style="text-align:left;margin-bottom:10px;">
      <summary style="cursor:pointer;color:var(--text-muted);">Add subtasks</summary>
      <textarea id="k-notes" placeholder="Subtasks..." style="${textareaStyle()}margin-top:10px;"></textarea>
      <div style="text-align:left;">${checklistButtonHtml("k-notes-checklist", "Insert checklist item")}</div>
    </details>
    <div style="text-align:left;">${uncountedCheckboxHtml("k-uncounted", "Don't count this card in statistics", false)}</div>` : ""}
    <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-bottom:8px;">${presetBtnsHtml}</div>
    <input id="k-date" type="date" value="${defaultDate}" style="${dateInputStyle()}" ${withText ? "" : "autofocus"}>
    ${withText ? docNameFieldHtml() : ""}
    <div id="k-date-actions" style="display:flex;gap:10px;justify-content:center;">${buttonHtml(withText ? "Add" : "Set", true)}${buttonHtml("No date", false)}${buttonHtml("Cancel", false)}</div>`;

  const [actionBtn, noDateBtn, cancelBtn] = dialog.querySelectorAll<HTMLButtonElement>("#k-date-actions button");
  const textInput = withText ? (dialog.querySelector("#k-text") as HTMLInputElement) : null;
  const notesInput = withText ? (dialog.querySelector("#k-notes") as HTMLTextAreaElement) : null;
  const checklistBtn = withText ? (dialog.querySelector("#k-notes-checklist") as HTMLButtonElement) : null;
  const uncountedInput = withText ? (dialog.querySelector("#k-uncounted") as HTMLInputElement) : null;
  const dateInput = dialog.querySelector("#k-date") as HTMLInputElement;
  let submit: (useDate: boolean) => void;
  const getDocName = withText ? wireDocNameField(app, dialog, defaultDocName ?? "", () => submit(true), close, setEscapeHandler) : null;

  if (checklistBtn && notesInput) {
    checklistBtn.onclick = () => insertChecklistPrefix(notesInput);
  }

  const presetBtns = dialog.querySelectorAll<HTMLButtonElement>(".kb-date-preset");
  presetBtns.forEach((btn) => {
    const preset = DATE_PRESETS.find(([key]) => key === btn.dataset.preset)!;
    btn.onclick = () => {
      dateInput.value = preset[2]().toISOString().split("T")[0];
      selectedPreset = preset[0];
      presetBtns.forEach((b) => { b.style.cssText = presetBtnStyle(b.dataset.preset === selectedPreset); });
    };
  });

  submit = (useDate: boolean) => {
    const t = textInput?.value.trim() ?? "";
    if (withText && !t) return;
    const d = useDate ? dateInput.value : "";
    const notes = notesInput?.value ?? "";
    const docName = getDocName?.();
    const uncounted = uncountedInput?.checked ?? false;
    close();
    onSubmit(d ? "@" + d : null, withText ? t : undefined, withText ? notes : undefined, docName, withText ? uncounted : undefined);
  };
  actionBtn.onclick = () => submit(true);
  noDateBtn.onclick = () => submit(false);
  cancelBtn.onclick = close;
  [textInput, dateInput].forEach((el) => {
    el?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit(true);
    });
  });
  (textInput ?? dateInput).focus();
}

function showRecurrentTriggerDialog(
  app: App,
  onSubmit: (trigger: string) => void,
  existingTriggers: string[] = [],
  existingRepeatSpec: RepeatSpec | null = null,
  opts: { allowNoTrigger?: boolean } = {}
) {
  const { allowNoTrigger = true } = opts;
  const { dialog, close } = makeOverlay("kanban-recurrent-trigger-dialog", app);

  const WD_KEYS   = ['sun','mon','tue','wed','thu','fri','sat'];
  const WD_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MO_KEYS   = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const MO_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const activeWD       = new Set(existingTriggers.filter(t => WD_KEYS.includes(t)));
  const selectedDays   = existingTriggers.filter(t => /^\d{1,2}$/.test(t));
  const selectedMonths = existingTriggers.filter(t => MO_KEYS.includes(t));

  // Interval-based recurrence: a count dropdown whose options depend on the chosen
  // unit. The month dropdown's 12th slot is relabelled "1 year" and stored as a
  // @repeat:1year annotation rather than @repeat:12month.
  const YEAR_SENTINEL = "year1";
  let initRepeatUnit: RepeatUnit = existingRepeatSpec?.unit === "year" ? "month" : (existingRepeatSpec?.unit ?? "week");
  // The count dropdown's default option is "-", meaning no interval repeat
  // (the card doesn't get pushed forward after being marked done).
  let initRepeatCountVal =
    existingRepeatSpec === null
      ? ""
      : existingRepeatSpec.unit === "year" || (existingRepeatSpec.unit === "month" && existingRepeatSpec.count === 12)
        ? YEAR_SENTINEL
        : String(existingRepeatSpec.count);

  const wdStyle = (active: boolean) =>
    `height:24px;padding:0 8px;border-radius:12px;border:1px solid var(--background-modifier-border);cursor:pointer;font-size:.75em;display:inline-flex;align-items:center;justify-content:center;` +
    (active ? `background:var(--kb-dialog-text, var(--text-normal));color:#fff;` : `background:none;color:inherit;`);

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
      <span style="${lblStyle}display:block;margin-bottom:4px;">Repeat after</span>
      <div id="k-repeat-controls" style="display:flex;gap:6px;align-items:center;">
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
    <div id="k-recur-actions" style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">${buttonHtml("Set", true)}${allowNoTrigger ? buttonHtml("No trigger", false) : ""}${buttonHtml("Cancel", false)}</div>`;

  const repeatCountSel  = dialog.querySelector("#k-repeat-count") as HTMLSelectElement;
  const repeatUnitSel   = dialog.querySelector("#k-repeat-unit") as HTMLSelectElement;
  const wdWrap   = dialog.querySelector("#k-wd-wrap") as HTMLElement;
  const domSel   = dialog.querySelector("#k-dom") as HTMLSelectElement;
  const moSel        = dialog.querySelector("#k-month") as HTMLSelectElement;
  const domRows      = dialog.querySelector("#k-dom-rows") as HTMLElement;
  const moRows       = dialog.querySelector("#k-month-rows") as HTMLElement;
  const errEl        = dialog.querySelector("#k-trigger-err") as HTMLElement;
  const actionBtns = dialog.querySelectorAll<HTMLButtonElement>("#k-recur-actions button");
  const setBtn = actionBtns[0];
  const noTriggerBtn = allowNoTrigger ? actionBtns[1] : null;
  const cancelBtn = allowNoTrigger ? actionBtns[2] : actionBtns[1];

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

  // Interval-based recurrence ("Repeat after") and calendar-based triggers
  // (weekday/day-of-month/month) are mutually exclusive — a card recurs off
  // exactly one of these.
  const populateRepeatCountOptions = (unit: string, selectValue?: string) => {
    let opts: [string, string][] = [["", "-"]];
    if (unit === "day") {
      opts.push(...Array.from({ length: 30 }, (_, i) => [String(i + 1), `${i + 1} day${i > 0 ? "s" : ""}`] as [string, string]));
    } else if (unit === "week") {
      opts.push(...Array.from({ length: 8 }, (_, i) => [String(i + 1), `${i + 1} week${i > 0 ? "s" : ""}`] as [string, string]));
    } else {
      opts.push(...Array.from({ length: 11 }, (_, i) => [String(i + 1), `${i + 1} month${i > 0 ? "s" : ""}`] as [string, string]));
      opts.push([YEAR_SENTINEL, "1 year"]);
    }
    repeatCountSel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    if (selectValue !== undefined && opts.some(([v]) => v === selectValue)) repeatCountSel.value = selectValue;
  };
  repeatUnitSel.value = initRepeatUnit;
  populateRepeatCountOptions(initRepeatUnit, initRepeatCountVal);

  const readRepeatSpec = (): RepeatSpec => {
    const val = repeatCountSel.value;
    if (val === YEAR_SENTINEL) return { count: 1, unit: "year" };
    return { count: parseInt(val, 10), unit: repeatUnitSel.value as RepeatUnit };
  };

  const clearCalendarTriggers = () => {
    activeWD.clear();
    wdWrap.querySelectorAll<HTMLButtonElement>(".kb-wd-btn").forEach((b) => b.style.cssText = wdStyle(false));
    selectedDays.length = 0; renderDomRows();
    selectedMonths.length = 0; renderMoRows();
  };
  // Picking a calendar-based trigger resets the interval dropdown back to "-";
  // picking a real interval count clears any calendar-based selection.
  const clearRepeatSelection = () => { repeatCountSel.value = ""; };

  repeatCountSel.addEventListener("change", () => {
    if (repeatCountSel.value !== "") clearCalendarTriggers();
  });
  repeatUnitSel.addEventListener("change", () => populateRepeatCountOptions(repeatUnitSel.value, repeatCountSel.value));

  // Weekday toggle
  wdWrap.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest(".kb-wd-btn") as HTMLButtonElement | null;
    if (!btn) return;
    clearRepeatSelection();
    const day = btn.dataset.day!;
    if (activeWD.has(day)) { activeWD.delete(day); btn.style.cssText = wdStyle(false); }
    else                   { activeWD.add(day);    btn.style.cssText = wdStyle(true);  }
  });

  // Day-of-month: selecting appends a row
  domSel.addEventListener("change", () => {
    const val = domSel.value;
    domSel.value = "";
    if (!val || val === 'last_day' || selectedDays.includes(val)) return;
    clearRepeatSelection();
    selectedDays.push(val);
    selectedDays.sort((a, b) => parseInt(a) - parseInt(b));
    renderDomRows();
  });

  // Month: selecting appends a row
  moSel.addEventListener("change", () => {
    const val = moSel.value;
    moSel.value = "";
    if (!val || selectedMonths.includes(val)) return;
    clearRepeatSelection();
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
    if (repeatCountSel.value !== "") {
      close();
      const spec = readRepeatSpec();
      const nextDate = formatDateAnnotation(addRepeatInterval(new Date(), spec));
      onSubmit(`${formatRepeatAnnotation(spec)} ${nextDate}`);
      return;
    }
    const tokens = [...activeWD, ...selectedDays, ...selectedMonths];
    if (!tokens.length) { errEl.textContent = "Select at least one trigger."; return; }
    close();
    onSubmit(tokens.map(t => `@${t}`).join(" "));
  };

  setBtn.onclick = submit;
  if (noTriggerBtn) noTriggerBtn.onclick = () => { close(); onSubmit(""); };
  cancelBtn.onclick = close;
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}

function showSubtaskDialog(app: App, onSubmit: (text: string) => void) {
  const { dialog, close } = makeOverlay("kanban-subtask-dialog", app);
  const prefill = CHECKLIST_MARK;
  dialog.innerHTML = `<h3 style="margin:0 0 10px;font-size:1.1em;">Add subtask</h3>
    <input id="k-task" type="text" placeholder="Enter subtask text..." style="${inputStyle()}" value="${prefill}">
    <details id="k-subs-details" style="text-align:left;margin-bottom:10px;">
      <summary style="cursor:pointer;color:var(--text-muted);">Add nested subtasks</summary>
      <textarea id="k-subs" placeholder="Subtasks of this subtask..." style="${textareaStyle()}margin-top:10px;"></textarea>
      <div style="text-align:left;">${checklistButtonHtml("k-subs-checklist", "Insert checklist item")}</div>
    </details>
    <div id="k-actions" style="display:flex;gap:10px;justify-content:center;">${buttonHtml("Add", true)}${buttonHtml("Cancel", false)}</div>`;
  const [addBtn, cancelBtn] = dialog.querySelectorAll<HTMLButtonElement>("#k-actions button");
  const taskInput = dialog.querySelector("#k-task") as HTMLInputElement;
  const subsInput = dialog.querySelector("#k-subs") as HTMLTextAreaElement;
  const checklistBtn = dialog.querySelector("#k-subs-checklist") as HTMLButtonElement;
  const submit = () => {
    const taskLine = taskInput.value;
    const subsText = subsInput.value;
    close();
    if (!taskLine.trim() && !subsText.trim()) return;
    // Children typed in the subtasks box are nested one level under the task
    // line by giving every non-blank line a leading tab; formatNoteLines()
    // derives further nesting from whatever relative indentation follows.
    const indentedSubs = subsText.trim()
      ? "\n" + subsText.replace(/\r\n/g, "\n").split("\n").map((l) => (l.trim() ? `\t${l}` : l)).join("\n")
      : "";
    onSubmit(taskLine + indentedSubs);
  };
  addBtn.onclick = submit;
  cancelBtn.onclick = close;
  checklistBtn.onclick = () => insertChecklistPrefix(subsInput);
  taskInput.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  };
  taskInput.focus();
  taskInput.setSelectionRange(taskInput.value.length, taskInput.value.length);
}

// A small fixed set of basic hues (plus gray and a "Default" no-color
// option); saturation and lightness are fixed constants so only hue is
// picked here. Gray is an achromatic quick pick that bypasses
// hue/saturation/lightness entirely. Default (-2) isn't a color at all —
// picking it clears any "%% @color %%" on the card, restoring its normal
// background/text and, for a promoted sub-task, letting it inherit its
// parent's color again (see createCardHTML's cardColor).
const CARD_COLOR_HUES: [string, number][] = [
  ["Red", 0], ["Orange", 28], ["Yellow", 48], ["Green", 130],
  ["Teal", 175], ["Blue", 212], ["Purple", 265], ["Pink", 325],
];
const CARD_COLOR_GRAY = "#888888";
const CARD_COLOR_SATURATION = 65;
const CARD_COLOR_LIGHTNESS = 55;
const CARD_COLOR_NONE_SWATCH_BG =
  "repeating-linear-gradient(45deg, var(--background-modifier-border), var(--background-modifier-border) 3px, transparent 3px, transparent 7px)";

// ─── SUBTASK TREE (dialog-owned, in-memory) ──────────────────────────────────
// One in-memory tree backs the whole "Order Subtasks" dialog session: every
// reorder and reparent mutates it directly, and nothing is written to disk
// until Apply serializes the final tree in one pass (see applySubtaskTree).
// This unifies same-level reorder and cross-card reparent into a single move
// primitive (moveGroup) instead of two separate code paths, each with its
// own position-awareness and its own idea of "moved" — which is what let a
// reparent land in the wrong spot (always appended last) while an ordinary
// reorder stayed correct.

interface DialogNode {
  id: number;             // original line number — a stable identity for the dialog session, not a live file position once anything has moved
  raw: string;             // this node's own line text, without leading whitespace (indentation is recomputed from tree depth on write)
  trailingRaw: string[];   // any non-list lines (blank lines, "%% ... %%" comments) that followed this node's own line in the original file, before the next node
  children: DialogNode[];
}

// Every node's own line, paired with whatever raw lines lay between it and
// the very next node in the ORIGINAL file (its own first child, if it has
// one, or otherwise the next sibling — however many levels up that sibling
// actually lives) — computed once, up front, from the full sorted list of
// every line in the card's subtree, so buildDialogTree doesn't need to
// reason about children vs. siblings itself.
function computeTrailingMap(lines: string[], subs: any[]): Map<number, string[]> {
  const allLines = new Set<number>();
  collectSubLineNumbers(subs, allLines);
  const sorted = Array.from(allLines).sort((a, b) => a - b);
  const endLine = maxSubLine(subs) || 0;
  const map = new Map<number, string[]>();
  for (let i = 0; i < sorted.length; i++) {
    const line = sorted[i];
    const nextLine = i + 1 < sorted.length ? sorted[i + 1] : endLine + 1;
    map.set(line, lines.slice(line, nextLine - 1));
  }
  return map;
}

// Parses a card's full subtask tree (parseFileEntries' `.subs`, deleted
// entries included — they stay real, non-rendered nodes so ">"-predecessor
// indexing never drifts from the file's actual semantics) into the dialog's
// own mutable structure.
function buildDialogTree(lines: string[], subs: any[]): DialogNode[] {
  const trailingMap = computeTrailingMap(lines, subs);
  const build = (s: any): DialogNode => ({
    id: s.line,
    raw: s.text,
    trailingRaw: trailingMap.get(s.line) || [],
    children: (s.subs || []).map(build),
  });
  return subs.map(build);
}

interface ChainGroup {
  head: DialogNode;
  chain: DialogNode[];
  deleted: boolean;
}

// Groups a sibling array into reorder/display units so a ">" chain of
// predecessor-dependents is never a separate draggable slot from its
// predecessor — every consecutive run of ">" dependents (not deleted) folds
// into whichever real, non-deleted entry precedes it; a dependent right
// after a deleted entry attaches to whatever real entry precedes *that*,
// matching promoteDependentSubtasks' own treatment of a deleted predecessor
// as transparent. A ">" with no attachable predecessor at all (transient —
// see the auto-correction sweep) is its own independent unit, same as "^".
// Deleted nodes are always their own (non-rendered, non-draggable) unit.
// Used identically for rendering, drop-slot hit-testing, and the move logic
// itself, so a chain-dependent can never be treated as independently
// draggable in one path and not another.
function groupChainDependents(siblings: DialogNode[]): ChainGroup[] {
  const groups: ChainGroup[] = [];
  let attachTo: ChainGroup | null = null;
  for (const s of siblings) {
    const parsed = parseTaskLine(s.raw);
    const deleted = parsed.tags.some(isDeletedTag);
    const isChainDependent = !deleted && parsed.dependsOn === ">";
    if (isChainDependent && attachTo) {
      attachTo.chain.push(s);
    } else {
      const group: ChainGroup = { head: s, chain: [], deleted };
      groups.push(group);
      if (!deleted) attachTo = group;
    }
  }
  return groups;
}

function findNode(root: DialogNode, id: number): DialogNode | null {
  if (root.id === id) return root;
  for (const c of root.children) {
    const found = findNode(c, id);
    if (found) return found;
  }
  return null;
}

function findParentOf(root: DialogNode, id: number): DialogNode | null {
  for (const c of root.children) {
    if (c.id === id) return root;
    const found = findParentOf(c, id);
    if (found) return found;
  }
  return null;
}

function isSelfOrDescendant(node: DialogNode, id: number): boolean {
  if (node.id === id) return true;
  return node.children.some((c) => isSelfOrDescendant(c, id));
}

// The single move primitive behind every reorder and reparent in the dialog
// — see the design note above. Moves the group headed by `headId` (itself
// plus its trailing ">" chain-dependents, and each member's own real
// children, as one contiguous unit preserving relative order) so it becomes
// the `newGroupIndex`-th group (0-indexed, post-removal) among
// `newParentId`'s children — where `newParentId` may be the group's own
// current parent (a same-level reorder), a different node at any depth
// (moving down), an ancestor at any depth including the card itself (moving
// up), or an unrelated card entirely. Converts the group head's own leading
// ">" marker to "^" (its old predecessor is no longer physically adjacent
// post-move); chain members keep their own markers untouched, since they
// still refer to each other and that reference travels with the group
// intact. Returns false (a silent no-op, nothing mutated) for an invalid
// move: `headId` isn't actually a group head, `newParentId` doesn't exist,
// or the drop is circular (onto the group's own subtree).
function moveGroup(root: DialogNode, headId: number, newParentId: number, newGroupIndex: number): boolean {
  const oldParent = findParentOf(root, headId);
  if (!oldParent) return false;
  const oldGroups = groupChainDependents(oldParent.children);
  const group = oldGroups.find((g) => g.head.id === headId);
  if (!group || group.deleted) return false;
  const unit = [group.head, ...group.chain];

  const newParent = findNode(root, newParentId);
  if (!newParent) return false;
  if (unit.some((n) => isSelfOrDescendant(n, newParentId))) return false;

  const unitIds = new Set(unit.map((n) => n.id));
  oldParent.children = oldParent.children.filter((c) => !unitIds.has(c.id));

  const parsed = parseTaskLine(group.head.raw);
  if (parsed.dependsOn === ">") {
    parsed.dependsOn = "^";
    group.head.raw = serializeTaskLine(parsed);
  }

  // newParent.children already reflects the removal above whether or not
  // newParent === oldParent, so the group-index -> raw-array-index mapping
  // below is unambiguous either way.
  const newGroups = groupChainDependents(newParent.children).filter((g) => !g.deleted);
  const rawInsertIdx = newGroupIndex >= newGroups.length
    ? newParent.children.length
    : newParent.children.findIndex((c) => c.id === newGroups[newGroupIndex].head.id);

  newParent.children.splice(rawInsertIdx, 0, ...unit);
  return true;
}

// The "Open → Done" button: reorders the top-level groups into plain
// bullets, then open, then done (each bucket keeping its own original
// relative order), with deleted entries pinned at the very end. Chain-
// dependents always travel with their group's head.
function sortTopLevelOpenDone(root: DialogNode): void {
  const groups = groupChainDependents(root.children);
  const real = groups.filter((g) => !g.deleted);
  const deletedNodes = root.children.filter((c) => parseTaskLine(c.raw).tags.some(isDeletedTag));
  const plain = real.filter((g) => parseTaskLine(g.head.raw).checked === null);
  const open = real.filter((g) => parseTaskLine(g.head.raw).checked === false);
  const done = real.filter((g) => parseTaskLine(g.head.raw).checked === true);
  const flatten = (gs: ChainGroup[]) => gs.flatMap((g) => [g.head, ...g.chain]);
  root.children = [...flatten(plain), ...flatten(open), ...flatten(done), ...deletedNodes];
}

// Any unchecked, non-deleted descendant anywhere in node's own subtree (real
// tree-nesting, via .children — not sibling/chain relationships, which
// computeDependentBlockedIds below handles separately). A node with any such
// descendant is not eligible for archiving — see archiveCheckedSubtasks.
function dialogHasUnchecked(node: DialogNode): boolean {
  for (const child of node.children) {
    const parsed = parseTaskLine(child.raw);
    if (parsed.tags.some(isDeletedTag)) continue;
    if (parsed.checked === false) return true;
    if (dialogHasUnchecked(child)) return true;
  }
  return false;
}

// A ">" dependency chain (see groupChainDependents) is one connected unit of
// work, not a set of independent siblings: "test" depending on "do
// marketing" depending on "implement model" means all three share one fate.
// Returns the ids of every node, in `siblings`, that belongs to a
// chain-group (head or any chain member) containing at least one unchecked,
// non-deleted member — these are ineligible for archiving even if checked
// themselves, since part of their own connected chain is still open.
function computeDependentBlockedIds(siblings: DialogNode[]): Set<number> {
  const blocked = new Set<number>();
  for (const g of groupChainDependents(siblings)) {
    if (g.deleted) continue;
    const members = [g.head, ...g.chain];
    const hasOpenMember = members.some((m) => {
      const p = parseTaskLine(m.raw);
      return !p.tags.some(isDeletedTag) && p.checked === false;
    });
    if (hasOpenMember) {
      for (const m of members) blocked.add(m.id);
    }
  }
  return blocked;
}

// The "Archive done" button: for every checked, non-deleted node anywhere in
// the tree that has neither an open child (a tree-nested descendant that's
// still unchecked) nor an open dependent (a ">" chain-mate — see
// computeDependentBlockedIds — that's still unchecked), replaces a "#done"
// tag with "#archived", or just adds "#archived" if it carries no "#done"
// tag at all — the common case, since most subtasks are plain checkboxes
// with no kanban tag of their own; only a promoted subtask would already
// carry "#done". A pure in-memory tree mutation, exactly like a move or a
// marker toggle — nothing reaches disk until Apply. Returns how many nodes
// were archived and how many checked candidates were left alone because of
// open work underneath — the caller surfaces the latter as a Notice rather
// than silently skipping them.
function archiveCheckedSubtasks(root: DialogNode, config: KanbanConfig): { archived: number; blocked: number } {
  let archived = 0;
  let blocked = 0;
  const visit = (node: DialogNode) => {
    const dependentBlocked = computeDependentBlockedIds(node.children);
    for (const child of node.children) {
      const parsed = parseTaskLine(child.raw);
      const isDeleted = parsed.tags.some(isDeletedTag);
      if (parsed.checked === true && !isDeleted) {
        if (dialogHasUnchecked(child) || dependentBlocked.has(child.id)) {
          blocked++;
        } else {
          const doneIdx = parsed.tags.findIndex((t) => normalizeTag(t) === config.normDone);
          const alreadyArchived = parsed.tags.some((t) => normalizeTag(t) === normalizeTag(ARCHIVED_TAG));
          if (doneIdx >= 0) {
            parsed.tags[doneIdx] = ARCHIVED_TAG;
            child.raw = serializeTaskLine(parsed);
            archived++;
          } else if (!alreadyArchived) {
            parsed.tags.push(ARCHIVED_TAG);
            child.raw = serializeTaskLine(parsed);
            archived++;
          }
        }
      }
      visit(child);
    }
  };
  visit(root);
  return { archived, blocked };
}

// Regenerates a card's whole subtask block from the final in-memory tree.
// Indentation is always recomputed from depth (tabs only, one per level —
// INDENT_TAB_WIDTH's convention), never preserved from the original line,
// since a node's depth may have changed.
function serializeDialogTree(root: DialogNode, depth = 1): string[] {
  const out: string[] = [];
  for (const node of root.children) {
    out.push("\t".repeat(depth) + node.raw);
    out.push(...node.trailingRaw);
    out.push(...serializeDialogTree(node, depth + 1));
  }
  return out;
}

// Applies a dialog session's final tree to disk in one read + one write,
// replacing the card's entire original subtask line range (from its first
// subtask's line to the last line of its last subtask's own subtree) — this
// is the only place any of the dialog session's pending moves ever reach the
// file. Re-derived fresh from the file rather than trusting the tree's own
// dialog-open-time line numbers, since a DialogNode's `id` is only a stable
// *identity* for the session, not a live file position once anything moved.
// A card that currently has no subtasks on disk at all (every one of them
// added fresh this session via Add Subtask/Add Comment — see wireSubtaskTree's
// addNode) has no existing range to replace; the whole regenerated block is
// inserted directly after the card's own line instead.
async function applySubtaskTree(app: App, filePath: string, cardLineNum: number, root: DialogNode, config: KanbanConfig): Promise<void> {
  const { tFile, lines } = await readFileLines(app, filePath);
  const fileItems = parseFileEntries(lines, filePath, config);
  const card = fileItems.find((f: any) => f.item.line === cardLineNum);
  if (!card) return;
  const newBlock = serializeDialogTree(root);
  if (card.item.subs.length) {
    const startLine = card.item.subs[0].line;
    const endLine = maxSubLine(card.item.subs) || cardLineNum;
    lines.splice(startLine - 1, endLine - startLine + 1, ...newBlock);
  } else {
    if (!newBlock.length) return;
    lines.splice(cardLineNum, 0, ...newBlock);
  }
  await writeFileLines(app, tFile, lines);
}

// Self-contained drag/reorder/reparent for the "Order Subtasks" dialog —
// deliberately not the board's own drag machinery (attachListeners), which
// is tightly coupled to cross-column/tag/order-digit logic that doesn't
// apply here. A single drag session spans the WHOLE tree — every level, and
// every row's own (possibly still-empty) children list, however deep — with
// one consistent hit-testing routine (updateHover) that always resolves to
// "this list, at this index," rather than two separate concepts for
// same-level reorder vs. reparent. Nothing is written to disk until the
// caller reads `root` itself (on Apply); a chain-dependent (see
// groupChainDependents) is never its own drag handle, only its group's head
// is — but it's still a fully normal, independently editable row, with its
// own real children rendered and reorderable exactly like anything else.
function wireSubtaskTree(
  app: App,
  containerEl: HTMLElement,
  titleEl: HTMLElement,
  root: DialogNode,
  config: KanbanConfig,
  // Same immediate-save semantics as the board's own subtask editor. Both
  // close the dialog on success (see their call sites in
  // showCardColorDialog) — each can shift line numbers this session's
  // Apply-time write depends on, so the in-memory tree isn't safe to keep
  // dragging afterward. The marker toggle, by contrast, is a pure in-memory
  // tree mutation just like a move — see onToggleClick below — so it never
  // touches disk or closes the dialog on its own.
  onEditSubtask: (line: number, newText: string) => Promise<string | null>,
  onDeleteSubtask: (line: number) => Promise<boolean>,
  // Fired after every tree mutation (a completed move, a sort) with whether
  // the tree now differs from what was first rendered — including once,
  // synchronously, during this initial setup (dirty = false).
  onChange: (dirty: boolean) => void,
  // Lets an in-progress row edit temporarily claim Escape for itself (cancel
  // just this edit) instead of the dialog's own Escape handler (which would
  // otherwise close/cancel the whole dialog) — see onRowDblClick below.
  setEscapeHandler: (fn: () => void) => void,
  dialogEscapeDefault: () => void
): {
  sortOpenDone(): void;
  archiveDone(): { archived: number; blocked: number };
  addNode(isCheckboxNode: boolean): void;
  setShowArchived(show: boolean): void;
  refreshClamping(): void;
  destroy(): void;
} {
  const doc = containerEl.ownerDocument;
  const DRAG_DELAY = 200, MOVE_THRESHOLD = 6;

  let dirty = false;
  // Archived subtasks default to hidden — see the order-subtasks section's
  // own "Show archived" toggle. Purely a rendering concern: an archived
  // node stays a real, structural tree node either way (never removed),
  // exactly like a deleted one — see renderInto/appendUnit, the only place
  // this is consulted. moveGroup's own group-index math is untouched by
  // this (it still sees every non-deleted group, archived or not), since
  // hiding only skips the row/subtree *rendering*, never the slot that
  // marks its position — see renderInto's own comment.
  let showArchived = false;
  const nodeIsArchived = (n: DialogNode) => parseTaskLine(n.raw).tags.some(isArchivedTag);
  const rowEls = new Map<number, HTMLElement>();
  let slots: { el: HTMLElement; parentId: number; index: number }[] = [];
  // Synthetic ids for nodes added this session (see addNode) — negative, so
  // they can never collide with a real line number (always >= 1). Purely a
  // session-local identity, same as every other node's id; never written
  // anywhere.
  let nextNewId = -1;

  const makeSlot = (parentId: number, index: number): HTMLElement => {
    const s = doc.createElement("div");
    s.className = "kb-subtask-slot";
    s.style.cssText = "height:12px;margin:-6px 0;border-top:2px dashed transparent;width:100%;";
    slots.push({ el: s, parentId, index });
    return s;
  };

  // A row styled like a real board card (createCardHTML) rather than a
  // compact list row, matching the board's own look. `draggable` rows (a
  // group's head) get a drag handle and grab cursor; a chain-dependent
  // (folded into its predecessor — see groupChainDependents) renders as a
  // fully normal, independently editable row otherwise, just without its
  // own drag handle, since its position only has meaning relative to its
  // predecessor.
  // `draggable` is exactly "is this a group head" (a chain-dependent is
  // never draggable — see appendUnit) — reused here to decide spacing: a
  // group head gets a visible gap from whatever preceded it (the previous
  // group, or the top of the list), while a chain-dependent sits flush
  // (margin-top:0) directly against its predecessor and nudged in by
  // CHAIN_INDENT_STEP * chainDepth (a small fraction of a real nesting
  // level's own 26px — see appendUnit's childWrap — since this is "depends
  // on," not "nested under"). `chainDepth` cascades — the Nth member of a
  // chain (1-indexed: b depends on a, c depends on b, d depends on c, ...)
  // sits N steps in, not a single flat step, so the indent itself reads as
  // the dependency chain: each link one step deeper than the one it
  // depends on. Container-level `gap` is deliberately 0 everywhere (see
  // renderInto/appendUnit) so this per-row margin is the only thing
  // controlling spacing — a uniform flex `gap` can't express "0 between
  // some children, a real gap between others."
  const GROUP_GAP = "14px";
  const CHAIN_INDENT_STEP = 12;
  const buildRow = (node: DialogNode, draggable: boolean, hasPredecessor: boolean, chainDepth: number): HTMLElement => {
    const row = doc.createElement("div");
    row.className = "kb-subtask-row";
    row.dataset.id = String(node.id);
    if (draggable) row.dataset.draggable = "1";
    row.style.cssText =
      "display:flex;flex-direction:column;gap:8px;padding:14px 16px;background:var(--kb-card-bg,var(--background-primary));" +
      `border:1px solid var(--background-modifier-border);border-radius:10px;cursor:${draggable ? "grab" : "default"};text-align:left;` +
      `box-shadow:0 1px 3px rgba(0,0,0,.08);margin-top:${draggable ? GROUP_GAP : "0"};margin-left:${chainDepth * CHAIN_INDENT_STEP}px;`;
    const mainLine = doc.createElement("div");
    mainLine.style.cssText = "display:flex;align-items:center;gap:10px;";
    if (draggable) {
      const handle = doc.createElement("span");
      handle.textContent = "⠿";
      handle.setAttribute("aria-hidden", "true");
      handle.style.cssText = "color:var(--text-faint);font-size:1.2em;line-height:1;flex-shrink:0;user-select:none;";
      mainLine.appendChild(handle);
    }
    const label = doc.createElement("span");
    label.className = "kb-subtask-label";
    // pointer-events:none makes the whole row draggable everywhere,
    // including over the (non-interactive, disabled) checkbox glyph, which
    // would otherwise swallow mousedown without bubbling. The dep-toggle
    // span inside carries its own pointer-events:auto (see renderCheckbox)
    // so it stays independently clickable. Temporarily switched to auto
    // while editing (see onRowDblClick) so the textarea itself is
    // interactive.
    label.style.cssText =
      `flex:1;min-width:0;pointer-events:none;overflow-wrap:anywhere;font-weight:${TITLE_FONT_WEIGHT};line-height:1.4;`;
    label.innerHTML = renderSubtaskPreviewHTML({ text: node.raw, line: node.id }, config, hasPredecessor);
    mainLine.appendChild(label);
    row.appendChild(mainLine);
    rowEls.set(node.id, row);
    return row;
  };

  // Renders `parent`'s own children as one reorderable/reparentable list —
  // one slot before, after, and between every group, but never inside one
  // (so there's no drop target between a subtask and its own
  // chain-dependents to silently reassign what they depend on). Every row,
  // draggable or not, gets its own nested children list rendered the exact
  // same way one level deeper — even a row with no real children yet still
  // gets an (empty, single-slot) list of its own, which is what lets
  // dropping something directly under it work through the same slot
  // mechanics as everywhere else, with no separate "reparent onto a row's
  // body" concept.
  //
  // Every group still gets its full set of slots (via the unconditional
  // makeSlot calls below), archived or not — only the row (and, since
  // appendUnit is simply never called for it, everything nested beneath it)
  // is skipped when showArchived is off. This keeps slot indices identical
  // to what groupChainDependents/moveGroup themselves compute (neither of
  // which knows about "archived hidden" at all), so drag/drop math never
  // has to special-case a hidden row's position.
  const renderInto = (container: HTMLElement, parent: DialogNode) => {
    container.innerHTML = "";
    const groups = groupChainDependents(parent.children).filter((g) => !g.deleted);
    container.appendChild(makeSlot(parent.id, 0));
    groups.forEach((g, i) => {
      if (showArchived || !nodeIsArchived(g.head)) {
        appendUnit(container, parent, g.head, true, 0);
      }
      // 1-indexed, cascading: the first chain member (depends directly on
      // the head) sits 1 step in, the second (depends on the first) sits 2
      // steps in, and so on -- see buildRow's own doc comment.
      g.chain.forEach((chainNode, ci) => {
        if (showArchived || !nodeIsArchived(chainNode)) {
          appendUnit(container, parent, chainNode, false, ci + 1);
        }
      });
      container.appendChild(makeSlot(parent.id, i + 1));
    });
  };

  const appendUnit = (container: HTMLElement, parent: DialogNode, node: DialogNode, draggable: boolean, chainDepth: number) => {
    // "Has a real predecessor" = is not raw index 0 among `parent`'s own
    // children (deleted-but-present siblings still count — see
    // groupChainDependents' own doc comment) — the same test the
    // auto-correction sweep uses to decide a ">" is even a valid state here.
    const hasPredecessor = parent.children.findIndex((c) => c.id === node.id) > 0;
    const row = buildRow(node, draggable, hasPredecessor, chainDepth);
    container.appendChild(row);
    const childWrap = doc.createElement("div");
    // gap:0 -- spacing between this row's own children is controlled
    // per-row by buildRow's margin-top (see GROUP_GAP), not by a uniform
    // container gap.
    childWrap.style.cssText = "display:flex;flex-direction:column;padding-left:26px;margin-top:8px;";
    row.appendChild(childWrap);
    renderInto(childWrap, node);
  };

  const render = () => {
    rowEls.clear();
    slots = [];
    renderInto(containerEl, root);
    adjustClamping();
    onChange(dirty);
  };

  // When every card can't fit without the column scrolling, clamp each
  // label to 2 lines (ellipsis); if that's still not enough, drop to 1 line.
  // Uses setProperty/removeProperty (not cssText) so this only ever touches
  // the clamp-specific properties, never clobbering the row's base style.
  const setClamp = (n: 0 | 1 | 2) => {
    rowEls.forEach((row) => {
      const label = row.querySelector<HTMLElement>(":scope > div > .kb-subtask-label");
      if (!label) return;
      if (n === 0) {
        label.style.removeProperty("display");
        label.style.removeProperty("-webkit-box-orient");
        label.style.removeProperty("-webkit-line-clamp");
        label.style.removeProperty("overflow");
      } else {
        label.style.setProperty("display", "-webkit-box");
        label.style.setProperty("-webkit-box-orient", "vertical");
        label.style.setProperty("-webkit-line-clamp", String(n));
        label.style.setProperty("overflow", "hidden");
      }
    });
  };
  const fitsWithoutScroll = () => containerEl.scrollHeight <= containerEl.clientHeight + 1;
  const adjustClamping = () => {
    // Collapsed (display:none) or not yet laid out — nothing to measure.
    if (containerEl.clientHeight === 0) return;
    setClamp(0);
    if (fitsWithoutScroll()) return;
    setClamp(2);
    if (fitsWithoutScroll()) return;
    setClamp(1);
  };

  render();

  // Double-click a row (at any depth) to edit its text inline, exactly like
  // a subtask on the board itself (onSubDblClick) — same textarea styling,
  // same Enter-saves/Escape-cancels/blur-saves behavior. Persists
  // immediately via the callbacks above, and closes the dialog on success —
  // see this function's own doc comment for why.
  const onRowDblClick = async (e: MouseEvent) => {
    const row = (e.target as Element).closest(".kb-subtask-row") as HTMLElement | null;
    if (!row) return;
    if (row.querySelector(".card-edit-input")) return;
    const label = row.querySelector<HTMLElement>(":scope > div > .kb-subtask-label");
    if (!label) return;
    const line = parseInt(row.dataset.id!, 10);
    const node = findNode(root, line);
    if (!node) return;
    // The editable content is the bullet/checkbox/kanban-tag-stripped text
    // (matching the board's own onSubDblClick and cleanSubtaskText) — NOT
    // node.raw itself, which still carries its own "- [ ]" prefix.
    // onEditSubtask ultimately calls editCardText, which reconstructs the
    // line by gluing the ORIGINAL line's own bullet/checkbox/tags back onto
    // whatever's typed here; feeding it node.raw directly would double up
    // that prefix on every real edit.
    const raw = cleanSubtaskText(node.raw, config).raw;

    const savedHTML = label.innerHTML;
    const input = doc.createElement("textarea");
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

    label.innerHTML = "";
    label.style.pointerEvents = "auto";
    label.appendChild(input);

    const popModEnterScope = withNewlineOnModEnter(app, input, autoResize);
    let finished = false;
    const finishEdit = async (save: boolean) => {
      if (finished || !label.contains(input)) return;
      finished = true;
      popModEnterScope();
      setEscapeHandler(dialogEscapeDefault);
      label.style.pointerEvents = "none";
      const newText = input.value.trim();
      if (save && !newText) {
        const ok = await onDeleteSubtask(line);
        if (ok) dialogEscapeDefault();
        else label.innerHTML = savedHTML;
      } else if (save && newText !== raw) {
        const newLabelHtml = await onEditSubtask(line, newText);
        if (newLabelHtml !== null) dialogEscapeDefault();
        else label.innerHTML = savedHTML;
      } else {
        label.innerHTML = savedHTML;
      }
    };

    // Claims Escape for the duration of this edit (cancel just this row)
    // instead of the dialog's own Escape handler, which would otherwise
    // close/cancel the whole dialog — see makeOverlay's Scope-based Escape
    // handling for why a DOM-level stopPropagation() alone can't do this.
    setEscapeHandler(() => finishEdit(false));

    input.addEventListener("keydown", async (ev) => {
      if (ev.key === "Enter" && !ev.ctrlKey && !ev.metaKey) { ev.preventDefault(); await finishEdit(true); }
    });
    input.addEventListener("input", autoResize);
    input.addEventListener("blur", () => finishEdit(true));
    input.addEventListener("dblclick", (ev) => ev.stopPropagation());
    requestAnimationFrame(() => requestAnimationFrame(() => {
      autoResize();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }));
  };
  containerEl.addEventListener("dblclick", onRowDblClick);

  // Opens a freshly-added node (see addNode) for typing. A pure in-memory
  // edit, unlike onRowDblClick's edit of an EXISTING node: there's nothing
  // on disk yet to write to, so committing just fills in this node's own
  // `raw` (and, for any extra lines the user typed, brand-new child nodes —
  // same "further lines become children one level deeper" convention as
  // editCardText's own Ctrl+Enter handling) and re-renders, leaving the
  // dialog open exactly like a move or a marker toggle. Only reaches disk
  // if the session is later applied; leaving it blank drops the placeholder
  // instead of leaving an empty subtask behind.
  const startNewNodeEdit = (node: DialogNode, isCheckboxNode: boolean) => {
    const row = rowEls.get(node.id);
    const label = row?.querySelector<HTMLElement>(":scope > div > .kb-subtask-label");
    if (!row || !label) return;

    const input = doc.createElement("textarea");
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

    label.innerHTML = "";
    label.style.pointerEvents = "auto";
    label.appendChild(input);

    const popModEnterScope = withNewlineOnModEnter(app, input, autoResize);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      popModEnterScope();
      setEscapeHandler(dialogEscapeDefault);

      const rawLines = input.value.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      const parent = findParentOf(root, node.id);
      if (!rawLines.length) {
        if (parent) parent.children = parent.children.filter((c) => c.id !== node.id);
      } else {
        node.raw = `${isCheckboxNode ? "- [ ] " : "- "}${rawLines[0]}`;
        for (const l of rawLines.slice(1)) {
          const { hasCheckbox, text } = parseLineMarker(l);
          node.children.push({ id: nextNewId--, raw: `${hasCheckbox ? "- [ ] " : "- "}${text}`, trailingRaw: [], children: [] });
        }
      }
      dirty = true;
      render();
    };

    setEscapeHandler(finish);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.ctrlKey && !ev.metaKey) { ev.preventDefault(); finish(); }
    });
    input.addEventListener("input", autoResize);
    input.addEventListener("blur", finish);
    input.addEventListener("dblclick", (ev) => ev.stopPropagation());
    requestAnimationFrame(() => requestAnimationFrame(() => {
      autoResize();
      input.focus();
    }));
  };

  // The "+ Subtask"/"+ Comment" buttons: always append a brand-new node as
  // a direct child of the card (level 1), below every existing top-level
  // subtask, then immediately open it for typing. A subtask starts with a
  // checkbox; a comment is a plain bullet (no checkbox) — matching this
  // codebase's existing convention that a plain bullet is a descriptive/
  // context line rather than an actual task.
  const addNode = (isCheckboxNode: boolean) => {
    const node: DialogNode = { id: nextNewId--, raw: isCheckboxNode ? "- [ ] " : "- ", trailingRaw: [], children: [] };
    root.children.push(node);
    dirty = true;
    render();
    startNewNodeEdit(node, isCheckboxNode);
  };

  // Handles every plain click inside the column that isn't itself a drag —
  // the ">"/"^"/"_" dependency toggle and the checkbox both live here,
  // sharing one suppressToggleClick flag (see below), since only one
  // top-level listener can safely consume a flag that guards against a
  // spurious trailing click after a real drag: two independent listeners
  // each checking-and-clearing the same flag would only have the first one
  // ever actually see it set.
  //
  // A gesture that starts on either the toggle glyph or the checkbox is NOT
  // excluded from drag-tracking below (unlike an earlier version of this
  // dialog, which is exactly what made a real drag attempt starting on the
  // glyph silently do nothing except fire a spurious trailing click that
  // cycled the marker instead) — both participate in the same
  // move-threshold disambiguation as the rest of the row. suppressToggleClick
  // swallows that trailing native "click" a real drag still fires on
  // release, so it doesn't also toggle something on top of whatever the
  // drag itself did.
  let suppressToggleClick = false;
  const onContainerClick = (e: MouseEvent) => {
    if (suppressToggleClick) { suppressToggleClick = false; return; }
    const target = e.target as Element;

    // ">"/"^"/"_" dependency-marker toggle (see renderCheckbox's depToggle
    // option) — cycles ">" -> "^" -> "_" (no marker) -> ">" ..., except ">"
    // is skipped entirely for a row with no real predecessor (see
    // appendUnit's hasPredecessor), where it isn't a valid state at all —
    // for such a row the cycle is just "^" -> "_" -> "^" ... A pure
    // in-memory tree mutation, exactly like a move: it never touches disk
    // and never closes the dialog — just rewrites this node's own `raw`
    // text and re-renders, so the row (and whatever group it now belongs
    // to, if the marker change moved it in or out of a chain) reflects the
    // new state immediately and stays open for further clicks or drags.
    // Only reaches disk if the session is later applied.
    const toggle = target.closest(".kb-dep-toggle") as HTMLElement | null;
    if (toggle) {
      const line = parseInt(toggle.dataset.line!, 10);
      if (isNaN(line)) return;
      const node = findNode(root, line);
      if (!node) return;
      const marker = (toggle.dataset.marker || null) as ">" | "^" | null;
      const hasPredecessor = toggle.dataset.hasPredecessor === "true";
      const cycle: (">" | "^" | null)[] = hasPredecessor ? [">", "^", null] : ["^", null];
      const idx = cycle.indexOf(marker);
      const newMarker = cycle[idx === -1 ? 0 : (idx + 1) % cycle.length];
      const parsed = parseTaskLine(node.raw);
      parsed.dependsOn = newMarker;
      node.raw = serializeTaskLine(parsed);
      dirty = true;
      render();
      return;
    }

    // Checkbox check/uncheck — same in-memory-only, dialog-stays-open
    // treatment as the marker toggle, and the same checked/doneDate pairing
    // as the board's own onSubCheckClick: checking stamps today's done
    // date, unchecking clears it. cb.checked already reflects the native
    // toggle that just happened (this click handler runs after it), so
    // there's nothing to compute beyond reading it.
    const cb = target.closest(".kb-sub-check") as HTMLInputElement | null;
    if (cb) {
      const line = parseInt(cb.dataset.subLine!, 10);
      if (isNaN(line)) return;
      const node = findNode(root, line);
      if (!node) return;
      const parsed = parseTaskLine(node.raw);
      if (parsed.checked === null) return;
      parsed.checked = cb.checked;
      if (parsed.checked) {
        const n = new Date();
        parsed.doneDate = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
      } else {
        parsed.doneDate = null;
      }
      node.raw = serializeTaskLine(parsed);
      dirty = true;
      render();
    }
  };
  containerEl.addEventListener("click", onContainerClick);

  let dragId: number | null = null;
  let ghost: HTMLElement | null = null;
  let hoverSlot: { parentId: number; index: number } | null = null;
  let hoverTargetEl: HTMLElement | null = null; // the row (or title) owning the hovered slot's list, when reparenting
  let activeMove: ((e: MouseEvent) => void) | null = null;
  let activeUp: ((e: MouseEvent) => void) | null = null;

  const clearSlotHighlight = () => slots.forEach((s) => (s.el.style.borderTopColor = "transparent"));
  const clearTargetHighlight = () => {
    if (!hoverTargetEl) return;
    hoverTargetEl.style.outline = "";
    hoverTargetEl.style.outlineOffset = "";
    hoverTargetEl = null;
  };

  // Resolves the drag to exactly one (targetParentId, targetIndex) — the
  // single hit-testing routine that covers same-level reorder and
  // reparent-to-any-depth alike, rather than two separate concepts. Slots
  // belonging to the dragged group's own subtree (including any chain
  // member's own children) are excluded so the highlight — and the
  // eventual drop — can never land somewhere circular. The dialog's own
  // title row is one more candidate, resolved to "become the card's own
  // first child" (index 0), since dropping there means promoting all the
  // way back up to the card.
  const updateHover = (clientX: number, clientY: number) => {
    clearSlotHighlight();
    clearTargetHighlight();
    hoverSlot = null;
    if (dragId === null) return;
    const oldParent = findParentOf(root, dragId);
    if (!oldParent) return;
    const group = groupChainDependents(oldParent.children).find((g) => g.head.id === dragId);
    if (!group) return;
    const unit = [group.head, ...group.chain];

    let nearestSlot: (typeof slots)[number] | null = null, minDist = Infinity;
    for (const s of slots) {
      if (unit.some((n) => isSelfOrDescendant(n, s.parentId))) continue;
      const r = s.el.getBoundingClientRect();
      const dist = Math.abs(r.top + r.height / 2 - clientY);
      if (dist < minDist) { minDist = dist; nearestSlot = s; }
    }

    const titleRect = titleEl.getBoundingClientRect();
    const titleDist = Math.abs(titleRect.top + titleRect.height / 2 - clientY);
    if (titleDist < minDist) {
      hoverSlot = { parentId: root.id, index: 0 };
      hoverTargetEl = titleEl;
      titleEl.style.outline = "2px solid var(--kb-accent)";
      titleEl.style.outlineOffset = "2px";
      return;
    }

    if (nearestSlot) {
      nearestSlot.el.style.borderTopColor = "var(--kb-accent)";
      hoverSlot = { parentId: nearestSlot.parentId, index: nearestSlot.index };
      // Reparenting into a different list (not the dragged group's own
      // current parent) also outlines the row that owns that list — the
      // card's own top level has no such row (its owner is the title,
      // handled above) — giving distinct feedback from a plain reorder.
      if (nearestSlot.parentId !== oldParent.id && nearestSlot.parentId !== root.id) {
        const ownerRow = rowEls.get(nearestSlot.parentId);
        if (ownerRow) {
          hoverTargetEl = ownerRow;
          ownerRow.style.outline = "2px solid var(--kb-accent)";
          ownerRow.style.outlineOffset = "2px";
        }
      }
    }
  };

  const makeGhost = (row: HTMLElement): HTMLElement => {
    const r = row.getBoundingClientRect();
    // Only the row's own header line is cloned — not its (possibly large)
    // nested children list — so the ghost stays a compact, single-row
    // preview no matter how much the dragged row is carrying along with it.
    const mainLine = row.querySelector<HTMLElement>(":scope > div");
    const g = doc.createElement("div");
    g.style.cssText = row.style.cssText;
    Object.assign(g.style, {
      position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: "auto",
      opacity: ".9", pointerEvents: "none", zIndex: "10002",
      boxShadow: "0 8px 24px rgba(0,0,0,.25)", cursor: "grabbing",
    });
    if (mainLine) g.appendChild(mainLine.cloneNode(true));
    doc.body.appendChild(g);
    return g;
  };

  const moveGhost = (clientX: number, clientY: number) => {
    if (!ghost) return;
    ghost.style.left = `${clientX - ghost.offsetWidth / 2}px`;
    ghost.style.top = `${clientY - ghost.offsetHeight / 2}px`;
  };

  const startDrag = (row: HTMLElement, clientX: number, clientY: number) => {
    dragId = parseInt(row.dataset.id!, 10);
    ghost = makeGhost(row);
    row.style.opacity = ".3";
    moveGhost(clientX, clientY);
  };

  // A rejected/no-op drop (nothing under the pointer, or a genuinely
  // circular target — see moveGroup) just leaves the tree untouched; since
  // the DOM is never mutated mid-drag (only the tree, and only once a move
  // actually lands), the dragged row is already still exactly where it
  // was — nothing to visually "snap back." A successful move instead
  // re-renders the WHOLE tree from scratch, so the moved row comes back as
  // a completely normal, freshly-built row — draggable again immediately,
  // indistinguishable from a row that was always there. No separate
  // "pending" or "preview" state, ever.
  const endDrag = () => {
    const draggedRowEl = dragId !== null ? rowEls.get(dragId) ?? null : null;
    let moved = false;
    if (dragId !== null && hoverSlot) {
      if (moveGroup(root, dragId, hoverSlot.parentId, hoverSlot.index)) {
        dirty = true;
        moved = true;
        render();
      }
    }
    if (ghost) { ghost.remove(); ghost = null; }
    if (!moved) draggedRowEl?.style.removeProperty("opacity");
    clearSlotHighlight();
    clearTargetHighlight();
    dragId = null;
    hoverSlot = null;
  };

  const onMouseDown = (e: MouseEvent) => {
    if ((e.target as Element).closest(".card-edit-input")) return;
    const row = (e.target as Element).closest(".kb-subtask-row[data-draggable='1']") as HTMLElement | null;
    if (!row) return;
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    const onMove = (me: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(me.clientX - startX) <= MOVE_THRESHOLD && Math.abs(me.clientY - startY) <= MOVE_THRESHOLD) return;
        dragging = true;
        startDrag(row, me.clientX, me.clientY);
      }
      moveGhost(me.clientX, me.clientY);
      updateHover(me.clientX, me.clientY);
    };
    const onUp = () => {
      doc.removeEventListener("mousemove", onMove);
      doc.removeEventListener("mouseup", onUp);
      activeMove = null; activeUp = null;
      if (dragging) { suppressToggleClick = true; endDrag(); }
    };
    activeMove = onMove; activeUp = onUp;
    doc.addEventListener("mousemove", onMove);
    doc.addEventListener("mouseup", onUp);
  };

  let touchRow: HTMLElement | null = null;
  let touchStartX = 0, touchStartY = 0, touchDragging = false;
  let touchTimer: ReturnType<typeof setTimeout> | null = null;

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    if (containerEl.querySelector(".card-edit-input")) return;
    const row = (e.target as Element).closest(".kb-subtask-row[data-draggable='1']") as HTMLElement | null;
    if (!row) return;
    touchRow = row;
    touchDragging = false;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchTimer = setTimeout(() => {
      if (touchRow) { touchDragging = true; startDrag(touchRow, touchStartX, touchStartY); }
    }, DRAG_DELAY);
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!touchRow || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!touchDragging) {
      if (Math.abs(t.clientX - touchStartX) > MOVE_THRESHOLD || Math.abs(t.clientY - touchStartY) > MOVE_THRESHOLD) {
        if (touchTimer) clearTimeout(touchTimer);
        touchDragging = true;
        startDrag(touchRow, t.clientX, t.clientY);
      } else {
        return;
      }
    }
    moveGhost(t.clientX, t.clientY);
    updateHover(t.clientX, t.clientY);
    e.preventDefault();
  };
  const onTouchEnd = () => {
    if (touchTimer) clearTimeout(touchTimer);
    if (touchDragging) { suppressToggleClick = true; endDrag(); }
    touchRow = null;
    touchDragging = false;
  };

  containerEl.addEventListener("mousedown", onMouseDown);
  containerEl.addEventListener("touchstart", onTouchStart, { passive: true });
  containerEl.addEventListener("touchmove", onTouchMove, { passive: false });
  containerEl.addEventListener("touchend", onTouchEnd);
  containerEl.addEventListener("touchcancel", onTouchEnd);

  return {
    sortOpenDone: () => {
      sortTopLevelOpenDone(root);
      dirty = true;
      render();
    },
    archiveDone: () => {
      const result = archiveCheckedSubtasks(root, config);
      if (result.archived) {
        dirty = true;
        render();
      }
      return result;
    },
    addNode,
    setShowArchived: (show: boolean) => {
      if (show === showArchived) return;
      showArchived = show;
      render();
    },
    refreshClamping: () => adjustClamping(),
    destroy: () => {
      containerEl.removeEventListener("mousedown", onMouseDown);
      containerEl.removeEventListener("click", onContainerClick);
      containerEl.removeEventListener("touchstart", onTouchStart);
      containerEl.removeEventListener("touchmove", onTouchMove);
      containerEl.removeEventListener("touchend", onTouchEnd);
      containerEl.removeEventListener("touchcancel", onTouchEnd);
      containerEl.removeEventListener("dblclick", onRowDblClick);
      if (activeMove) doc.removeEventListener("mousemove", activeMove);
      if (activeUp) doc.removeEventListener("mouseup", activeUp);
      if (touchTimer) clearTimeout(touchTimer);
      if (ghost) ghost.remove();
    },
  };
}

function showCardColorDialog(
  app: App,
  existingColor: string | null,
  title: string,
  // The card's own line — stamped onto the title element below so it's also
  // a valid drop target for the subtask-reorder reparent gesture (dropping a
  // subtask directly onto the title promotes it all the way back to being a
  // direct child of the card, same as dropping onto any other row one level
  // in — see wireSubtaskTree's updateHover).
  cardLineNum: number,
  subtaskTree: DialogNode[],
  config: KanbanConfig,
  // The card's own current "%% @uncounted %%"/"%% @uncounted_children %%"
  // state — see the UNCOUNTED section near DELETED_TAG/ARCHIVED_TAG.
  existingUncounted: boolean,
  existingUncountedChildren: boolean,
  onApply: (hex: string | null) => void,
  // Fired only when either uncounted checkbox differs from its existing*
  // value at Apply time — a plain field set, not folded into onApply/hex
  // since it's independent of the color.
  onSetUncountedFlags: (uncounted: boolean, uncountedChildren: boolean) => void,
  // Fired only when the subtask tree actually changed by the time Apply was
  // clicked — see wireSubtaskTree's `dirty` tracking. Everything about the
  // move (every reorder and every reparent from this whole session) is
  // already folded into `finalTree`; the caller's only job is to serialize
  // it (see applySubtaskTree).
  onReorder: (finalTree: DialogNode[]) => void,
  onDelete: () => void,
  // Same immediate-save semantics as the board's own subtask editor: these
  // fire (and persist) right away, independent of Apply/Cancel, and close
  // the dialog on success (see wireSubtaskTree's matching params for why).
  // The marker toggle, checkbox, and "Archive done" have no equivalent
  // callback here — each is a pure in-memory tree mutation handled entirely
  // inside wireSubtaskTree, folded into `finalTree` like any other pending
  // change.
  onEditSubtask: (line: number, newText: string) => Promise<string | null>,
  onDeleteSubtask: (line: number) => Promise<boolean>
) {
  const { dialog, close, setEscapeHandler } = makeOverlay("kanban-card-color-dialog", app);
  dialog.style.maxWidth = "720px"; // 1.5x the original 480px
  const root: DialogNode = { id: cardLineNum, raw: "", trailingRaw: [], children: subtaskTree };

  const validExisting = existingColor && /^#[0-9a-fA-F]{6}$/.test(existingColor)
    ? existingColor
    : null;
  const existingHsl = validExisting ? hexToHsl(validExisting) : null;
  let selectedHue = !existingHsl
    ? -2 // no color set → Default
    : existingHsl.l > 90
      ? -2 // legacy literal white, from before Default existed
      : existingHsl.s < 10
        ? -1
        : CARD_COLOR_HUES.reduce((best, [, h]) =>
            Math.abs(h - existingHsl.h) < Math.abs(best - existingHsl.h) ? h : best, CARD_COLOR_HUES[0][1]);

  const swatchBtnStyle = (h: number, active: boolean) =>
    `width:32px;height:32px;border-radius:50%;cursor:pointer;` +
    `border:2px solid ${active ? "var(--kb-accent)" : h === -2 ? "var(--background-modifier-border)" : "transparent"};` +
    `background:${h === -2 ? CARD_COLOR_NONE_SWATCH_BG : h === -1 ? CARD_COLOR_GRAY : hslToHex(h, CARD_COLOR_SATURATION, CARD_COLOR_LIGHTNESS)};`;

  const swatchesHtml = CARD_COLOR_HUES
    .map(([name, h]) => `<button type="button" class="kb-color-swatch" data-hue="${h}" title="${name}" style="${swatchBtnStyle(h, h === selectedHue)}"></button>`)
    .join("") +
    `<button type="button" class="kb-color-swatch" data-hue="-1" title="Gray" style="${swatchBtnStyle(-1, selectedHue === -1)}"></button>` +
    `<button type="button" class="kb-color-swatch" data-hue="-2" title="Default (no color)" style="${swatchBtnStyle(-2, selectedHue === -2)}"></button>`;

  const deleteBtnStyle = "padding:8px 16px;background:var(--text-error, #e03e3e);border:none;border-radius:4px;cursor:pointer;color:#fff;";
  const sortBtnStyle = "align-self:flex-start;flex-shrink:0;margin-bottom:8px;padding:5px 12px;border-radius:6px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);cursor:pointer;font-size:.85em;";

  // Sits between the color swatches and the Apply/Cancel/Delete row — always
  // shown, not a collapsible element (a card's subtasks are core content
  // here, not an optional aside). Always rendered, even with zero existing
  // subtasks — Add Subtask/Add Comment need somewhere to live for a card
  // that doesn't have any yet (see applySubtaskTree's own handling of that
  // case).
  const subtaskSectionHtml = `
    <div id="k-subtask-section" style="margin-top:14px;text-align:left;flex:1 1 auto;min-height:0;display:flex;flex-direction:column;">
      <div style="font-size:.8em;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;flex-shrink:0;">Order subtasks</div>
      <div id="k-subtask-btnrow" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;flex-shrink:0;">
        <button id="k-subtask-add-task" type="button" style="${sortBtnStyle}" title="Add a new subtask below all others">Add ☐</button>
        <button id="k-subtask-add-comment" type="button" style="${sortBtnStyle}" title="Add a new plain (non-checkbox) note below all others">Add •</button>
        <button id="k-subtask-sort" type="button" style="${sortBtnStyle}" title="Move all done subtasks below the open ones">Open → Done</button>
        <button id="k-subtask-archive-done" type="button" style="${sortBtnStyle}" title="Tag every checked subtask #archived (replacing #done if present)">Archive done</button>
        <label id="k-subtask-show-archived-label" style="display:flex;align-items:center;gap:8px;margin-left:auto;font-size:.85em;color:var(--text-muted);cursor:pointer;user-select:none;">
          <span style="position:relative;display:inline-block;width:32px;height:18px;flex-shrink:0;">
            <input type="checkbox" id="k-subtask-show-archived" style="position:absolute;inset:0;opacity:0;margin:0;cursor:pointer;">
            <span id="k-subtask-show-archived-track" style="position:absolute;inset:0;background:var(--background-modifier-border);border-radius:9px;transition:background .15s;"></span>
            <span id="k-subtask-show-archived-thumb" style="position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--background-primary);box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .15s;"></span>
          </span>
          Show archived
        </label>
      </div>
      <div id="k-subtask-col" style="flex:1;min-height:0;overflow-y:auto;padding:8px;border:1px solid var(--background-modifier-border);border-radius:8px;background:var(--background-secondary);display:flex;flex-direction:column;"></div>
    </div>`;

  // The "don't count its subtasks" toggle is only offered when there's
  // something for it to actually do — a card with no subtasks yet has
  // nothing to exclude. Still offered despite an empty tree if the flag is
  // somehow already set (e.g. every subtask was since removed, or "@ucc" was
  // hand-typed onto the card line itself) — hiding it then would leave no
  // way to clear it from this dialog.
  const hasSubtasks = subtaskTree.length > 0 || existingUncountedChildren;

  dialog.innerHTML = `
    <div style="flex-shrink:0;">
      <h3 id="k-card-title-row" style="margin:0 0 12px;font-size:1.1em;overflow-wrap:anywhere;border-radius:6px;">${title || "Card"}</h3>
      <div id="k-color-swatches" style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;">${swatchesHtml}</div>
      <div style="display:flex;flex-direction:column;align-items:flex-start;margin-top:10px;">
        ${uncountedCheckboxHtml("k-card-uncounted", "Don't count this card in statistics", existingUncounted)}
        ${hasSubtasks ? uncountedCheckboxHtml("k-card-uncounted-children", "Don't count its subtasks in statistics", existingUncountedChildren) : ""}
      </div>
    </div>
    ${subtaskSectionHtml}
    <div id="k-color-actions" style="flex-shrink:0;margin-top:14px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;align-items:center;">${buttonHtml("Apply", true)}${buttonHtml("Cancel", false)}<button id="k-color-delete" type="button" style="${deleteBtnStyle}">Delete</button></div>`;

  const titleRowEl = dialog.querySelector<HTMLElement>("#k-card-title-row")!;
  const subtaskColEl = dialog.querySelector<HTMLElement>("#k-subtask-col");
  const subtaskAddTaskBtn = dialog.querySelector<HTMLButtonElement>("#k-subtask-add-task");
  const subtaskAddCommentBtn = dialog.querySelector<HTMLButtonElement>("#k-subtask-add-comment");
  const subtaskSortBtn = dialog.querySelector<HTMLButtonElement>("#k-subtask-sort");
  const subtaskArchiveDoneBtn = dialog.querySelector<HTMLButtonElement>("#k-subtask-archive-done");
  const showArchivedCheckbox = dialog.querySelector<HTMLInputElement>("#k-subtask-show-archived");
  const showArchivedTrack = dialog.querySelector<HTMLElement>("#k-subtask-show-archived-track");
  const showArchivedThumb = dialog.querySelector<HTMLElement>("#k-subtask-show-archived-thumb");
  const deleteBtn = dialog.querySelector("#k-color-delete") as HTMLButtonElement;

  // The subtask section is always shown (not collapsible — see
  // subtaskSectionHtml above), so the dialog always takes the full-height,
  // flex-column layout that used to apply only once expanded.
  dialog.style.height = "90vh";
  dialog.style.display = "flex";
  dialog.style.flexDirection = "column";
  dialog.style.overflow = "hidden";

  // Deleting the whole card while a reorder is in progress is both easy to
  // hit by mistake and hard to undo, so the Delete button hides itself for
  // the duration.
  let dirty = false;
  const refreshDeleteVisibility = () => {
    deleteBtn.style.display = dirty ? "none" : "";
  };
  const onTreeChange = (d: boolean) => { dirty = d; refreshDeleteVisibility(); };

  const treeCtl = subtaskColEl
    ? wireSubtaskTree(app, subtaskColEl, titleRowEl, root, config, onEditSubtask, onDeleteSubtask, onTreeChange, setEscapeHandler, () => closeAndCleanup())
    : null;
  // Re-measure now that the column has actually been laid out — a reading
  // of scrollHeight/clientHeight always forces a synchronous layout, so
  // this reflects the dialog's real size now that it's on screen.
  treeCtl?.refreshClamping();

  subtaskAddTaskBtn?.addEventListener("click", () => treeCtl?.addNode(true));
  subtaskAddCommentBtn?.addEventListener("click", () => treeCtl?.addNode(false));

  subtaskSortBtn?.addEventListener("click", () => treeCtl?.sortOpenDone());

  // "Show archived" toggle — defaults off (unchecked), matching
  // wireSubtaskTree's own showArchived default. Purely a display filter:
  // archived subtasks (and everything nested beneath them, cascading the
  // same way #deleted ones already do — see renderInto) stay real,
  // structural tree nodes either way, just not rendered until switched on.
  const applyShowArchivedVisual = () => {
    if (!showArchivedCheckbox || !showArchivedTrack || !showArchivedThumb) return;
    const on = showArchivedCheckbox.checked;
    showArchivedTrack.style.background = on ? "var(--kb-accent)" : "var(--background-modifier-border)";
    showArchivedThumb.style.transform = on ? "translateX(14px)" : "translateX(0)";
  };
  applyShowArchivedVisual();
  showArchivedCheckbox?.addEventListener("change", () => {
    applyShowArchivedVisual();
    treeCtl?.setShowArchived(showArchivedCheckbox.checked);
  });

  subtaskArchiveDoneBtn?.addEventListener("click", () => {
    const result = treeCtl?.archiveDone();
    if (!result) return;
    // Silent when there's nothing to report (matches the "Open → Done"
    // button, which also has no feedback when nothing changed) — but a
    // checked subtask left alone because of open work underneath (see
    // archiveCheckedSubtasks) is exactly the case that must NOT be silent,
    // since silently skipping it (or silently archiving it anyway) is what
    // this Notice exists to replace.
    if (result.blocked > 0) {
      const archivedPart = result.archived
        ? `Archived ${result.archived} subtask${result.archived === 1 ? "" : "s"}. `
        : "Nothing archived. ";
      new Notice(`${archivedPart}${result.blocked} left unarchived — still ${result.blocked === 1 ? "has" : "have"} open work underneath.`);
    } else if (result.archived > 0) {
      new Notice(`Archived ${result.archived} subtask${result.archived === 1 ? "" : "s"}.`);
    }
  });

  // The dialog can only get taller/shorter via the window itself resizing
  // (no user-facing resize handle), so this only needs to run occasionally,
  // not on every animation frame.
  const dialogWindow = dialog.ownerDocument.defaultView;
  const onWindowResize = () => treeCtl?.refreshClamping();
  dialogWindow?.addEventListener("resize", onWindowResize);

  const swatchWrap = dialog.querySelector("#k-color-swatches") as HTMLElement;
  const [applyBtn, cancelBtn] = dialog.querySelectorAll<HTMLButtonElement>("#k-color-actions button");
  const uncountedCheckbox = dialog.querySelector<HTMLInputElement>("#k-card-uncounted")!;
  // Absent from the DOM entirely when !hasSubtasks (see above) — Apply then
  // just keeps existingUncountedChildren (false, since that's the only way
  // hasSubtasks can be false) unchanged.
  const uncountedChildrenCheckbox = dialog.querySelector<HTMLInputElement>("#k-card-uncounted-children");

  const currentHex = (): string | null =>
    selectedHue === -2 ? null :
    selectedHue === -1 ? CARD_COLOR_GRAY :
    hslToHex(selectedHue, CARD_COLOR_SATURATION, CARD_COLOR_LIGHTNESS);

  swatchWrap.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest(".kb-color-swatch") as HTMLButtonElement | null;
    if (!btn) return;
    selectedHue = parseInt(btn.dataset.hue!, 10);
    swatchWrap.querySelectorAll<HTMLButtonElement>(".kb-color-swatch").forEach((b) => {
      b.style.cssText = swatchBtnStyle(parseInt(b.dataset.hue!, 10), parseInt(b.dataset.hue!, 10) === selectedHue);
    });
  });

  const closeAndCleanup = () => {
    treeCtl?.destroy();
    dialogWindow?.removeEventListener("resize", onWindowResize);
    close();
  };

  applyBtn.onclick = () => {
    const finalTree = root.children;
    const wasDirty = dirty;
    const newUncounted = uncountedCheckbox.checked;
    const newUncountedChildren = uncountedChildrenCheckbox?.checked ?? existingUncountedChildren;
    closeAndCleanup();
    onApply(currentHex());
    if (wasDirty) onReorder(finalTree);
    if (newUncounted !== existingUncounted || newUncountedChildren !== existingUncountedChildren) {
      onSetUncountedFlags(newUncounted, newUncountedChildren);
    }
  };
  cancelBtn.onclick = closeAndCleanup;
  deleteBtn.onclick = () => { closeAndCleanup(); onDelete(); };
  setEscapeHandler(closeAndCleanup);
}

// Text is expected to already carry its own "-"/"- [ ]" formatting (from
// showSubtaskDialog); formatNoteLines only adds a bullet where one is missing.
async function addSubtaskToCard(
  app: App, filePath: string, afterLine: number, cardLine: number, text: string
): Promise<boolean> {
  try {
    const { tFile, lines } = await readFileLines(app, filePath);
    const cardIndent = (lines[cardLine - 1]?.match(/^(\s*)/) ?? ["",""])[1];
    const subLines = formatNoteLines(cardIndent, text);
    if (!subLines.length) return false;
    lines.splice(afterLine, 0, ...subLines);
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

// Only checkbox items (- [ ] or - [x]) are tasks; plain bullet points are not.
function isCheckboxItem(s: any): boolean {
  return /^[-*+]\s+\[[ xX]\]/.test((s.text ?? "").trim());
}
function isCheckedItem(s: any): boolean {
  return /^[-*+]\s+\[[xX]\]/.test((s.text ?? "").trim());
}
// A subtask marked #deleted (its text was cleared via inline editing — see
// markLineDeleted) is invisible on the board and excluded from every count
// below, along with everything nested beneath it.
function isDeletedItem(s: any): boolean {
  return (s.tags ?? []).some(isDeletedTag);
}
// A subtask marked #archived (see archiveCheckedSubtasks, the order-
// subtasks dialog's "Archive done" button) is put away the same way a
// deleted one is: invisible on the board, along with everything nested
// beneath it, and excluded from every count below for the same reason
// isDeletedItem already is — an archived branch (always checked, so it
// never itself contributes an "unchecked" count) can still hide unchecked
// descendants of its own that shouldn't leak into a parent card's styling
// once that whole branch is put away.
const isArchivedTag = (t: string) => normalizeTag(t) === normalizeTag(ARCHIVED_TAG);
function isArchivedItem(s: any): boolean {
  return (s.tags ?? []).some(isArchivedTag);
}
// Any unchecked checkbox descendant.
function hasUnchecked(subs: any[]): boolean {
  for (const s of subs ?? []) {
    if (isDeletedItem(s) || isArchivedItem(s)) continue;
    if (isCheckboxItem(s) && !isCheckedItem(s)) return true;
    if (s.subs?.length && hasUnchecked(s.subs)) return true;
  }
  return false;
}

// ─── CARD HTML ────────────────────────────────────────────────────────────────

// Sized in em so it always tracks the font-size of whatever row it's dropped
// into (the badge row is .8em) and never grows past a single line of text.
const SOURCE_DOC_ICON =
  `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" ` +
  `stroke-linecap="round" stroke-linejoin="round" style="display:block;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/></svg>`;

// Same cleanup/formatting createCardHTML applies to a card's own title, but
// for a *parent* card's raw text shown as a preview label: every kanban tag
// is stripped (not just the current column's — the parent may live in a
// different column than this card) since it's plumbing, not part of the name.
function buildParentPreviewHTML(parentRawText: string, config: KanbanConfig, vaultName: string): string {
  let display = parentRawText
    .replace(/\s*%%[\s\S]*?%%\s*/g, " ")
    .replace(/\s*✅\d{4}-\d{2}-\d{2}/, "")
    .trim();
  display = display
    .split(/\s+/)
    .filter((w: string) => !(w.startsWith("#") && config.normKanban.includes(normalizeTag(w))))
    .join(" ")
    .trim();
  let raw = display
    .replace(/^- \[[ xX]\] /, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^#{1,6}\s+/, "")
    .trim();

  // Date/trigger annotations are dropped rather than rendered as the usual
  // clickable badges (formatCardDateAnnotation/formatTriggerAnnotations):
  // those badges wire their click handler to the *nearest* .kanban-card
  // ancestor, which here would be this (child) card, not the parent whose
  // text is being previewed — clicking one would silently edit the wrong line.
  raw = raw.replace(/@(\d{4})-(\d{2})-(\d{2})\b/g, "").trim();
  if (config.normRecurrent) {
    raw = raw.replace(new RegExp(`@${config.normRecurrent}\\b`, "gi"), "");
    raw = raw.replace(/@repeat:(\d+)(day|week|month|year)s?\b/gi, "");
    raw = raw.replace(/@([a-zA-Z][a-zA-Z_]*(?:[+-]\d+)?|\d{1,2})\b/g, (match: string, token: string) =>
      isValidTriggerToken(token.toLowerCase()) ? "" : match
    );
  }
  raw = raw.replace(/\s{2,}/g, " ").trim();

  return formatInlineEmphasis(linksToHtml(raw, vaultName));
}

// Same text cleanup as renderSub() inside createCardHTML, for a direct
// child rendered as a static row in the subtask-reorder dialog. Wikilinks
// are left as plain text (vaultName omitted from renderCheckbox) rather than
// clickable anchors — every row in that dialog is drag-only, so nothing
// inside it should be independently clickable.
// Same cleanup renderSub() does inside createCardHTML, factored out so both
// the static label (renderSubtaskPreviewHTML) and the subtask-reorder
// dialog's inline editor (which needs the plain editable "raw" text, same as
// data-sub-raw on the board) stay in sync.
function cleanSubtaskText(subText: string, config: KanbanConfig): { hasCheckbox: boolean; formatted: string; raw: string } {
  const hasCheckbox = /^- \[[ xX]\] /.test(subText || "");
  const formatted = (subText || "")
    .replace(/\s*%%[\s\S]*?%%\s*/g, " ")
    .replace(/\s*✅\d{4}-\d{2}-\d{2}/, "")
    .trim()
    .split(/\s+/)
    .filter((w: string) => !(w.startsWith("#") && config.normKanban.includes(normalizeTag(w))))
    .join(" ")
    .trim();
  const raw = formatted
    .replace(/^- \[[ xX]\] /, "")
    .replace(/^[-*+]\s+/, "")
    .trim();
  return { hasCheckbox, formatted, raw };
}

// `hasPredecessor` (default true — permissive, only real callers that know
// otherwise pass false) drives whether the reorder dialog's clickable
// ">"/"^"/"_" toggle offers ">" as a cycle destination: never valid for a
// row with no real predecessor, where it would recreate the invalid,
// auto-corrected state the render-time sweep exists to fix.
function renderSubtaskPreviewHTML(sub: any, config: KanbanConfig, hasPredecessor: boolean = true): string {
  const { hasCheckbox, formatted } = cleanSubtaskText(sub.text, config);
  const subText = formatCardDateAnnotation(formatTriggerAnnotations(formatted, config.normRecurrent, false), true);
  // isSub:true (not the board-preview default of false) renders a live,
  // clickable checkbox (class kb-sub-check) instead of a disabled one — see
  // wireSubtaskTree's onContainerClick for the reorder dialog's own handler.
  return renderCheckbox(subText, { isSub: true, showCheckbox: hasCheckbox, subLine: sub.line, depToggle: { hasPredecessor } });
}

function createCardHTML(
  item: any,
  isMulti: boolean,
  currentNorm: string,
  config: KanbanConfig,
  vaultName: string
): string {
  let display = item.item.text;
  display = display.replace(/\s*%%[\s\S]*?%%\s*/g, " ").replace(/\s*✅\d{4}-\d{2}-\d{2}/, "").trim();
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
    // A promoted dependent subtask renders through this card-title path —
    // its leading ">"/"^" marker is meaningful on a subtask row but not on
    // a card title, so it's stripped here only.
    .replace(/^[>^]\s+/, "")
    .trim();
  const mainContent = formatInlineEmphasis(linksToHtml(formatCardDateAnnotation(formatTriggerAnnotations(rawText, config.normRecurrent)), vaultName), TITLE_FONT_WEIGHT);

  const hasSubs = item.item.subs.length > 0; // structural (any subs at all, for expand/collapse)
  const isExpanded = item.state === "expanded";

  // Any unchecked descendant that has a tag in the configured "active" column group.
  function hasActiveKanban(subs: any[]): boolean {
    for (const s of subs ?? []) {
      if (isDeletedItem(s) || isArchivedItem(s)) continue;
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
      if (isDeletedItem(s) || isArchivedItem(s)) continue;
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

  // Red: only in project columns — has unchecked checkboxes, none in an active column, and not all deferred to Later/Recurrent.
  const isProjectColumn  = config.normProject.includes(currentNorm);
  // Red: in the Done column — a "done" card still has an unchecked subtask.
  const isDoneColumn     = currentNorm === config.normDone;
  const hasUnmanagedWork = (isProjectColumn && hasUnchecked(item.item.subs)
    && !hasActiveKanban(item.item.subs) && !allUncheckedInLaterOrRecurrent(item.item.subs))
    || (isDoneColumn && hasUnchecked(item.item.subs));

  function renderSub(sub: any, depth: number): string {
    const parentTag =
      item.item.tags.find((t: string) => normalizeTag(t) === currentNorm) || "";
    const hasCheckbox = /^- \[[ xX]\] /.test(sub.text);
    const isChecked = /^- \[[xX]\] /.test(sub.text);
    const alreadyTagged = extractTags(sub.text).some((t: string) =>
      config.normKanban.includes(normalizeTag(t))
    );
    let subText = sub.text
      .replace(/\s*%%[\s\S]*?%%\s*/g, " ")
      .replace(/\s*✅\d{4}-\d{2}-\d{2}/, "")
      .trim()
      .split(/\s+/)
      .filter((w: string) => !(w.startsWith('#') && config.normKanban.includes(normalizeTag(w))))
      .join(" ")
      .trim();
    const subEditRaw = subText
      .replace(/^- \[[ xX]\] /, "")
      .replace(/^[-*+]\s+/, "")
      .trim();
    subText = formatCardDateAnnotation(formatTriggerAnnotations(subText, config.normRecurrent, false), true);
    const indent = "&nbsp;".repeat(depth * 3);
    const rendered = renderCheckbox(subText, {
      isSub: true,
      showCheckbox: hasCheckbox,
      vaultName,
      enablePromotion: hasCheckbox && !isChecked && !alreadyTagged,
      promoted: alreadyTagged,
      subLine: sub.line,
      parentTag,
      parentDigits: item.digits,
    });
    const subLastLine = maxSubLine(sub.subs) || sub.line;
    const subStyle = `margin:4px 0;line-height:1.5;${
      config.fontSizeSubtask ? `font-size:${config.fontSizeSubtask};` : ""
    }`;
    return `<div class="kb-sub-row" data-sub-line="${sub.line}" data-sub-last-line="${subLastLine}" data-sub-raw="${subEditRaw.replace(/"/g, "&quot;")}" style="${subStyle}">${indent}${rendered}</div>`;
  }

  function renderSubTree(subs: any[], depth = 0): string {
    return (subs || [])
      .filter((sub: any) => !isDeletedItem(sub) && !isArchivedItem(sub))
      .map((sub: any) => renderSub(sub, depth) + renderSubTree(sub.subs, depth + 1))
      .join("");
  }

  const addSubBtnStyle = `width:24px;height:24px;border-radius:50%;border:1px solid var(--background-modifier-border);background:none;cursor:pointer;font-size:1.1em;line-height:1;display:inline-flex;align-items:center;justify-content:center;color:inherit;`;
  const addSubBtn = `<button class="kb-add-sub" style="${addSubBtnStyle}">+</button>`;

  // A floated, invisible spacer placed before the text reserves room for the
  // top-right icon only on the line it overlaps; later wrapped lines flow past
  // it and use the card's full width. Its height must match the title's own
  // line-height exactly (both set here as the same "TITLE_LINE_H" em value) —
  // if the spacer were taller than one line it would bleed into line 2 and
  // force it to reserve the same right-hand space as line 1.
  const TITLE_LINE_H = 1.5; // em
  const iconSpacer = (width: number) =>
    `<span aria-hidden="true" style="float:right;width:${width}px;height:${TITLE_LINE_H}em;"></span>`;

  // A card's chosen highlight color always wins over the structural
  // border rules below, but only as a frame — the fill stays the card's
  // normal background and text stays the card's normal text color, so a
  // colored card doesn't take over its surroundings (unlike the fill+frame
  // combo this used to apply). Computed here (before titleStyle/badge) so
  // those explicit per-element colors — which would otherwise block
  // inheritance from the card wrapper below — pick it up too. When the
  // card's own column has a background of the same color family
  // (config.columnColors), a plain frame would blend into it and
  // disappear, so it gets a thin white outline ring around it (a double
  // frame) to stay visible. Falls back to the nearest ancestor's color
  // (item.inheritedColor, set in parseFileEntries) when this card has none
  // of its own — only relevant for a promoted sub-task getting its own
  // top-level card here; the nested/unpromoted display in renderSub never
  // applies a color at all.
  const cardColor = extractCardColor(item.item.text) || item.inheritedColor || null;
  const textColor = "var(--kb-text)";
  let colorStyle = "";
  if (cardColor) {
    const columnBg = config.columnColors[currentNorm] || "";
    const needsSeparator = columnBg && sameColorFamily(cardColor, columnBg);
    colorStyle = needsSeparator
      ? `border:6px solid ${cardColor}!important;outline:3px solid #fff!important;`
      : `border:6px solid ${cardColor}!important;`;
  }

  const titleStyle = `padding:6px 0;font-weight:${TITLE_FONT_WEIGHT};color:${textColor};text-align:left;line-height:${TITLE_LINE_H};${
    config.fontSizeCardTitle ? `font-size:${config.fontSizeCardTitle};` : ""
  }`;

  const bodyHTML = hasSubs
    ? `<div style="position:relative;">
         <div class="card-title" style="${titleStyle}cursor:pointer;"
              onclick="this.closest('.kanban-card').querySelector('details').toggleAttribute('open')">
           ${iconSpacer(18)}${mainContent}
           <span class="kb-expand-arrow" style="position:absolute;top:6px;right:2px;font-size:1.1em;line-height:1;color:var(--kb-accent);user-select:none;">${isExpanded ? "▲" : "▼"}</span>
         </div>
         <details ${isExpanded ? "open" : ""} style="margin:4px 0 0 0;">
           <summary style="display:none;"></summary>
           <div style="padding-left:8px;">${renderSubTree(item.item.subs)}</div>
           <div style="display:flex;justify-content:flex-end;margin-top:4px;">${addSubBtn}</div>
         </details>
       </div>`
    : `<div style="position:relative;">
         <div class="card-title" style="${titleStyle}">${iconSpacer(26)}${mainContent}</div>
         <button class="kb-add-sub" style="${addSubBtnStyle}position:absolute;top:4px;right:0;">+</button>
       </div>`;

  const border = isMulti
    ? "background:var(--background-modifier-error-hover);border:1px solid var(--background-modifier-error);"
    : hasUnmanagedWork
      ? `border:2px solid var(--kb-children-done);background:color-mix(in srgb,var(--kb-children-done) 20%,var(--kb-card-bg));`
      : "border:1px solid var(--background-modifier-border);";

  const src = item.source.path.split("/").pop().replace(/\.md$/, "");
  const href = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(item.filePath)}`;
  const sourceIcon = `<a href="${href}" class="kb-source-icon" title="Open source document" style="flex-shrink:0;display:inline-flex;color:${textColor};">${SOURCE_DOC_ICON}</a>`;

  // A promoted sub-task shows a link back to its parent card instead of the
  // plain "from: <file>" line — clicking the name expands/reveals the parent
  // (see onParentLinkClick); the source-doc icon still opens the file either way.
  const parentEntry = item.parentRef || null;
  const badge = parentEntry
    ? `<div class="kb-parent-row" data-parent-file="${item.filePath}" data-parent-line="${parentEntry.item.line}" style="margin-top:8px;font-size:.8em;color:${textColor};display:flex;align-items:center;gap:5px;">
         <span class="kb-parent-link" title="Open parent card" style="cursor:pointer;color:var(--kb-link);text-decoration:underline dotted;text-underline-offset:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;">${buildParentPreviewHTML(parentEntry.item.text, config, vaultName)}</span>
         ${sourceIcon}
       </div>`
    : `<div style="margin-top:8px;font-size:.8em;color:${textColor};display:flex;align-items:center;gap:5px;">
         <span>from: <a href="${href}" style="color:var(--kb-link);text-decoration:none;">${src}</a></span>
       </div>`;

  const lastSubLn = maxSubLine(item.item.subs) || item.item.line;

  return `<div class="kanban-card"
    data-file="${item.filePath}"
    data-line="${item.item.line}"
    data-last-sub-line="${lastSubLn}"
    data-raw="${rawText.replace(/"/g, "&quot;")}"
    data-digits="${item.digits || ""}"
    data-tags='${JSON.stringify(item.item.tags).replace(/'/g, "&#39;")}'
    data-subs='${JSON.stringify(item.item.subs.map((s: any) => ({ line: s.line, text: s.text, subs: s.subs || [] }))).replace(/'/g, "&#39;")}'
    data-is-promoted="${item.isPromoted || false}"
    data-color="${cardColor || ""}"
    style="padding:10px 14px;margin:8px 0;border-radius:10px;background:var(--kb-card-bg);color:var(--kb-text);
           box-shadow:0 2px 8px rgba(0,0,0,.12);${border};${colorStyle}cursor:move;position:relative;text-align:left;">
    ${item.indent > 0 ? '<span class="demote-btn" style="position:absolute;top:4px;left:6px;font-size:0.75em;color:var(--kb-accent);line-height:1;cursor:pointer;">&#x25B6;</span>' : ''}
    ${bodyHTML}
    ${badge}
  </div>`;
}

// Parses createCardHTML's output into a real (detached) element, for the
// reconciler below to insert/compare/replace without going through
// zone.innerHTML += (which re-parses every already-appended card each time).
function createCardNode(
  item: any,
  isMulti: boolean,
  currentNorm: string,
  config: KanbanConfig,
  vaultName: string,
  doc: Document
): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.innerHTML = createCardHTML(item, isMulti, currentNorm, config, vaultName);
  return wrap.firstElementChild as HTMLElement;
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

// APCA (Accessible Perceptual Contrast Algorithm) — the WCAG 3 candidate
// replacement for the 2.x luminance-ratio contrast formula, and the
// standards-track answer to "are these two colors distinguishable enough to
// read." Unlike a Hue/Lightness heuristic, it's purely a function of
// (gamma-corrected) luminance — hue plays no part in real text legibility.
// Constants and formula are the reference implementation, W3-licensed:
// https://github.com/Myndex/apca-w3 (SA98G / "0.1.9" G-4g constants).
const APCA = {
  sRco: 0.2126729, sGco: 0.7151522, sBco: 0.0721750,
  normBG: 0.56, normTXT: 0.57, revBG: 0.65, revTXT: 0.62,
  blkThrs: 0.022, blkClmp: 1.414,
  scale: 1.14, loBoWoffset: 0.027, loWoBoffset: 0.027,
  deltaYmin: 0.0005, loClip: 0.1,
};

// sRGB hex color to APCA's "Y" luminance (0-1).
function sRGBtoY(hex: string): number {
  const clean = hex.replace(/^#/, "");
  const chan = (h: string) => Math.pow(parseInt(h, 16) / 255, 2.4);
  return APCA.sRco * chan(clean.slice(0, 2)) + APCA.sGco * chan(clean.slice(2, 4)) + APCA.sBco * chan(clean.slice(4, 6));
}

// APCA Lc contrast between text-Y and background-Y: signed, positive for
// dark-on-light and negative for light-on-dark, roughly ±0-108. Order
// matters — swapping text/background changes the result (polarity).
function apcaLc(txtY: number, bgY: number): number {
  const soften = (y: number) => (y > APCA.blkThrs ? y : y + Math.pow(APCA.blkThrs - y, APCA.blkClmp));
  txtY = soften(txtY);
  bgY = soften(bgY);
  if (Math.abs(bgY - txtY) < APCA.deltaYmin) return 0;
  if (bgY > txtY) {
    const sapc = (Math.pow(bgY, APCA.normBG) - Math.pow(txtY, APCA.normTXT)) * APCA.scale;
    return (sapc < APCA.loClip ? 0 : sapc - APCA.loBoWoffset) * 100;
  }
  const sapc = (Math.pow(bgY, APCA.revBG) - Math.pow(txtY, APCA.revTXT)) * APCA.scale;
  return (sapc > -APCA.loClip ? 0 : sapc + APCA.loWoBoffset) * 100;
}

// Column title text color for a given background: `darkColor` (the user's
// chosen dark, hue-selectable color) unless its APCA contrast against the
// background is too weak to read, in which case white is used instead.
// `thresholdPct` is used directly as the minimum required |Lc| (APCA's own
// scale is ~0-108, not a percentage — see https://apcacontrast.com; Lc 45 is
// APCA's documented minimum for bold/large text, Lc 60 for body text). 0
// never switches to white, 108 always does. Falls back to `fallback` (e.g.
// the general Font color) when there's no literal background hex to check.
function columnTitleTextColor(bgHex: string, fallback: string, darkColor: string, thresholdPct: number): string {
  if (!bgHex) return fallback;
  const lc = apcaLc(sRGBtoY(darkColor), sRGBtoY(bgHex));
  return Math.abs(lc) < clamp(thresholdPct, 0, 108) ? "#ffffff" : darkColor;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// h: 0-360, s/l: 0-100
export function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100, lN = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sN * Math.min(lN, 1 - lN);
  const f = (n: number) => lN - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) => Math.round(255 * x).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const clean = hex.replace(/^#/, "");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

// True when two colors read as "the same color" to a viewer — same hue
// family (within 25°), or both effectively gray (low saturation). Used to
// detect when a card's frame color would blend into its column's own
// background, so createCardHTML knows to add a white separator ring.
function sameColorFamily(hexA: string, hexB: string): boolean {
  const a = hexToHsl(hexA);
  const b = hexToHsl(hexB);
  const grayA = a.s < 12;
  const grayB = b.s < 12;
  if (grayA || grayB) return grayA === grayB;
  const d = Math.abs(a.h - b.h) % 360;
  return (d > 180 ? 360 - d : d) <= 25;
}

export function buildColorCSS(config: KanbanConfig): string {
  const cv = (val: string, fb: string) => (val && val.trim()) ? val.trim() : fb;
  const configuredDarkText = (config.colorText && config.colorText.trim()) ? config.colorText.trim() : "#1a1a1a";
  const overLimit = cv(config.colorColumnOverLimit, "#5c1a1a");
  const overText = textOnBg(overLimit, "#ffffff", configuredDarkText);
  // Per-column color is the column's base background. The shared over-limit
  // warning color still wins (via !important) once a column exceeds its max.
  const perColRules = Object.entries(config.columnColors)
    .filter(([, c]) => c)
    .map(([norm, color]) => {
      const text = columnTitleTextColor(color, configuredDarkText, config.colorColumnTitleDark, config.colorTextContrastThreshold);
      return `
      #kanban-wrapper [data-col-container="${norm}"]{background:${color};}
      #kanban-wrapper [data-col-norm="${norm}"]{background:${color};color:${text};}
    `;
    }).join("");
  return `
    :root{--kb-dialog-text:${cv(config.colorText,"var(--text-normal)")};--kb-dialog-muted:${cv(config.colorText,"var(--text-muted)")}}
    #kanban-wrapper{
      --kb-card-bg:#ffffff;
      --kb-col-bg:${cv(config.colorColumnBg,"var(--background-secondary)")};
      --kb-text:${cv(config.colorText,"var(--text-normal)")};
      --kb-accent:${cv(config.colorAccent,"var(--interactive-accent)")};
      --kb-link:${cv(config.colorLink,"var(--text-accent)")};
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
    ${perColRules}
    #kanban-wrapper [data-col-container][data-col-overlimit="1"]{background:${overLimit}!important;}
    #kanban-wrapper [data-col-container][data-col-overlimit="1"] h4,
    #kanban-wrapper [data-col-container][data-col-overlimit="1"] .kb-col-count,
    #kanban-wrapper [data-col-container][data-col-overlimit="1"] .kb-col-add-btn{color:${overText}!important;}
    #kanban-wrapper [data-col-norm][data-col-overlimit="1"]{background:${overLimit}!important;color:${overText}!important;}`;
}

async function tagUntaggedRecurrentCards(app: App, paths: string[], config: KanbanConfig): Promise<void> {
  const annotationRe = new RegExp(`@${config.normRecurrent}\\b`, 'i');
  for (const filePath of paths) {
    const tFile = app.vault.getAbstractFileByPath(filePath) as TFile | null;
    if (!tFile) continue;
    const lines = (await getCachedFileLines(app, filePath)).slice();
    let changed = false;
    // Everything from the Archived callout onward is dead content (see
    // archiveToSection) — a card's own "@recurrent" text surviving into its
    // archived title-only placeholder, or into an archived subtask that was
    // itself a triggered recurring subcard, must not get re-tagged
    // #recurrent, or it resurfaces as a phantom card in Recurrent.
    const calloutIdx = lines.findIndex((l) => l.trim() === ARCHIVE_CALLOUT_HEADER);
    const scanLimit = calloutIdx >= 0 ? calloutIdx : lines.length;
    for (let i = 0; i < scanLimit; i++) {
      if (!annotationRe.test(lines[i])) continue;
      // Only a top-level (unindented) line becomes its own Recurrent card here.
      // An indented "@recurrent" annotation is always a per-subtask trigger (see
      // triggerRecurrentSubs) — it's consumed in place and only ever promoted to
      // Due, never Recurrent, once it actually fires. Previously this was allowed
      // through as long as the immediate parent line didn't itself carry the
      // #recurrent tag, which broke the instant the parent card moved out of
      // Recurrent to any other column: the subtask's now-dormant annotation (still
      // waiting for its own trigger, or simply never stripped) would suddenly pass
      // that check and get wrongly auto-tagged into its own phantom Recurrent card.
      const myIndent = (lines[i].match(/^(\s*)/) || [""])[0].length;
      if (myIndent > 0) continue;
      const tags = extractTags(lines[i]);
      if (tags.some((t: string) => config.normKanban.includes(normalizeTag(t)))) continue;
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
    if (changed) await vaultModify(app, tFile, lines.join('\n'));
  }
}

// Scans every task line (cards and sub-items) for ones that were checked off
// directly in the document — not via the board UI — and (a) swaps their own
// kanban column tag for the done tag, so hand-edited files still land in
// #done, and (b) backfills a missing "✅YYYY-MM-DD" done-date on ANY checked
// line that lacks one, independent of (a). These used to be one combined
// step gated on "not already tagged #done" — which meant a line that was
// checked and tagged #done by some route other than this function or the
// board's own checkbox click (a hand-edit, a promoted subtask stamped
// #done directly, a plain subtask with no kanban tag at all) could end up
// permanently stuck with no done-date at all, since nothing would ever
// revisit it. The date backfill now runs unconditionally on any checked,
// undated line, matching stampMissingCreatedDates' own "if we don't know,
// stamp with today" precedent.
export async function moveCheckedCardsToDone(app: App, paths: string[], config: KanbanConfig): Promise<void> {
  if (!config.normDone) return;
  for (const filePath of paths) {
    const tFile = app.vault.getAbstractFileByPath(filePath) as TFile | null;
    if (!tFile) continue;
    const lines = (await getCachedFileLines(app, filePath)).slice();
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseTaskLine(lines[i]);
      if (parsed.checked !== true) continue;

      let lineChanged = false;
      const hasOwnKanbanTag = parsed.tags.some((t) => matchesKanbanTag(t, config.normKanban));
      const alreadyDone = parsed.tags.some((t) => normalizeTag(t) === config.normDone);
      if (hasOwnKanbanTag && !alreadyDone) {
        parsed.tags = parsed.tags.filter((t) => !matchesKanbanTag(t, config.normKanban));
        parsed.tags.push(config.doneColumn);
        // Stamped immediately rather than left for stampMissingCreatedDates —
        // same reasoning as moveToColumn's Done path: a card landing here
        // undated (e.g. hand-edited straight out of Recurrent/Maybe Someday)
        // shouldn't sit with a Done tag and no @created stamp even briefly.
        if (!parsed.createdDate) {
          const n = new Date();
          parsed.createdDate = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`;
        }
        lineChanged = true;
      }
      if (!parsed.doneDate) {
        const n = new Date();
        parsed.doneDate = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`;
        lineChanged = true;
      }
      if (lineChanged) {
        lines[i] = serializeTaskLine(parsed);
        changed = true;
      }
    }
    if (changed) await vaultModify(app, tFile, lines.join("\n"));
  }
}

// Backfills "%% @created:YYYY-MM-DD %%" onto any card or subtask found without
// one — walks the real card/subtask tree (via collectItems) rather than a flat
// line scan, since only that tree-aware parse knows which checkbox lines are
// actually inside a kanban card (a flat scan would either miss un-tagged
// subtask lines, or, with "scan all vault notes" on, wrongly stamp unrelated
// checklists elsewhere in the vault). Cards are stamped regardless of their
// own syntax (heading or checkbox); subtasks are stamped only when they're a
// real checkbox item (see isCheckboxItem) — plain note bullets inserted by
// formatNoteLines are left alone. #deleted nodes are skipped: every date-based
// stat downstream already excludes them, so stamping one would be a wasted write.
// Cards still sitting in any Maybe Someday column, or in Recurrent, are
// skipped too (and, since the check short-circuits before recursing, so are
// their subtasks) — a Maybe Someday card's "creation" doesn't count until
// it's actually pulled off the shelf, and a Recurrent card's created-date is
// deliberately stripped on entry (see moveToColumn/archiveToSection) since
// it isn't "open work" while parked there. Once either is moved to another
// column, this same backfill stamps it with today's date on the very next
// board render; a card that already had a created date before landing in
// Maybe Someday keeps that date untouched (Recurrent, unlike Maybe Someday,
// actively clears it on entry rather than merely leaving it be).
export async function stampMissingCreatedDates(app: App, paths: string[], config: KanbanConfig): Promise<void> {
  const items = await collectItems(app, paths, config);
  const n = new Date();
  const todayStr = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
  const CREATED_RE = /%% @created:\d{4}-\d{2}-\d{2} %%/;
  const isDeleted = (node: any) => (node.tags ?? []).some((t: string) => normalizeTag(t) === "deleted");
  const isMaybeSomeday = (node: any) =>
    (node.tags ?? []).some((t: string) => config.normMaybeSomeday.includes(normalizeTag(t)));
  const isRecurrent = (node: any) =>
    !!config.normRecurrent && (node.tags ?? []).some((t: string) => normalizeTag(t) === config.normRecurrent);

  const byFile = new Map<string, number[]>();
  const visit = (filePath: string, node: any, isSubtask: boolean) => {
    if (isDeleted(node) || isMaybeSomeday(node) || isRecurrent(node)) return;
    if ((!isSubtask || isCheckboxItem(node)) && !CREATED_RE.test(node.text)) {
      if (!byFile.has(filePath)) byFile.set(filePath, []);
      byFile.get(filePath)!.push(node.line);
    }
    for (const sub of node.subs ?? []) visit(filePath, sub, true);
  };
  for (const card of items) visit(card.filePath, card.item, false);

  for (const [filePath, lineNums] of byFile) {
    const tFile = app.vault.getAbstractFileByPath(filePath) as TFile | null;
    if (!tFile) continue;
    const lines = (await getCachedFileLines(app, filePath)).slice();
    let changed = false;
    for (const lineNum of lineNums) {
      const idx = lineNum - 1;
      if (idx < 0 || idx >= lines.length) continue;
      const parsed = parseTaskLine(lines[idx]);
      if (parsed.createdDate) continue;
      parsed.createdDate = todayStr;
      lines[idx] = serializeTaskLine(parsed);
      changed = true;
    }
    if (changed) await vaultModify(app, tFile, lines.join("\n"));
  }
}

// Normalizes the "%% @ucc %%" shorthand to its canonical long form,
// "%% @uncounted_children %%", directly in each target file — see the
// UNCOUNTED section above. parseTaskLine/serializeTaskLine already treat the
// two spellings identically, so statistics are correct even before this runs;
// this pass just keeps the on-disk text self-documenting. A plain string
// replace (not a parseTaskLine/serializeTaskLine round-trip) so a line with no
// other structural comment isn't otherwise touched. Only writes a file when
// something on it actually changed, same as every other normalizing pass here.
export async function expandUncountedShorthand(app: App, paths: string[]): Promise<void> {
  for (const filePath of paths) {
    const tFile = app.vault.getAbstractFileByPath(filePath) as TFile | null;
    if (!tFile) continue;
    const lines = (await getCachedFileLines(app, filePath)).slice();
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const next = lines[i].replace(/%%\s*@ucc\s*%%/g, "%% @uncounted_children %%");
      if (next !== lines[i]) {
        lines[i] = next;
        changed = true;
      }
    }
    if (changed) await vaultModify(app, tFile, lines.join("\n"));
  }
}

export const KANBAN_NARROW_BREAKPOINT = 700;

export function isNarrowLayout(width: number): boolean {
  const isPhone = /iPhone|iPod|(Android.*Mobile)/i.test(navigator.userAgent);
  return isPhone || width < KANBAN_NARROW_BREAKPOINT;
}

// ─── BOARD RECONCILIATION ─────────────────────────────────────────────────────
// Instead of tearing down and rebuilding the whole board on every render
// (every column, every card — a visible flash for a change to exactly one
// card), buildBoard diffs the freshly computed columns/cards against the DOM
// nodes already on screen (matched by data-col-container / data-file+line)
// and applies only the add/remove/move/update operations actually needed.
// Every render trigger (drag, add, edit, external file change, settings
// change, ...) goes through this same path — none of the action handlers in
// attachListeners needed to change.

// Header contents depend only on (norm, col, config) — rebuilt fresh and
// swapped in whole rather than patched field-by-field, since it holds no
// per-element state worth preserving (no focus/open/scroll state lives here).
function buildColumnHeader(norm: string, col: { rawTag: string; cards: any[] }, config: KanbanConfig, doc: Document): HTMLElement {
  const header = doc.createElement("div");
  header.className = "kb-col-header";
  header.style.cssText = "display:flex;align-items:center;margin-bottom:10px;padding:0 4px;";

  const titleColor = columnTitleTextColor(config.columnColors[norm] || "", "var(--kb-text)", config.colorColumnTitleDark, config.colorTextContrastThreshold);
  const shadowLen = config.columnTitleShadowLength;
  const titleShadow = shadowLen > 0 && titleColor.toLowerCase() !== "#ffffff"
    ? `text-shadow:${shadowLen}px ${shadowLen}px ${shadowLen / 2}px rgba(255,255,255,0.9);`
    : "";

  const h4 = doc.createElement("h4");
  h4.textContent = col.rawTag.replace(/^#/, "").toUpperCase();
  h4.style.cssText = `margin:0;flex-grow:1;font-weight:bold;color:${titleColor};${titleShadow}${
    config.fontSizeColumnTitle ? `font-size:${config.fontSizeColumnTitle};` : ""
  }`;
  header.appendChild(h4);

  const countSpan = doc.createElement("span");
  countSpan.className = "kb-col-count";
  countSpan.textContent = String(col.cards.length);
  countSpan.style.cssText = `margin-right:6px;font-size:.75em;color:${titleColor};background:transparent;border:1px solid var(--background-modifier-border);border-radius:50%;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;`;
  header.appendChild(countSpan);

  const btn = doc.createElement("button");
  btn.className = "kb-col-add-btn";
  (btn as HTMLButtonElement).dataset.column = norm;
  if (norm !== config.normDone) {
    btn.textContent = "+";
    btn.style.cssText = `width:24px;height:24px;border-radius:50%;border:1px solid var(--background-modifier-border);background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:${titleColor};`;
    (btn as HTMLButtonElement).dataset.tag = col.rawTag;
  } else {
    btn.textContent = "Archive";
    btn.style.cssText = `height:24px;padding:0 8px;border-radius:12px;border:1px solid var(--background-modifier-border);background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.75em;color:${titleColor};`;
  }
  header.appendChild(btn);

  return header;
}

// Creates a new column container (shell only — header + empty drop-zone, no
// cards/insert-slots yet) and appends it to scroll. Used only the first time
// a given norm appears; reconcileColumns reuses the container on every
// subsequent render instead of calling this again.
function buildColumnShell(
  scroll: HTMLElement,
  norm: string,
  col: { rawTag: string; cards: any[] },
  doc: Document
): { colDiv: HTMLElement; zone: HTMLElement } {
  const colDiv = doc.createElement("div");
  colDiv.dataset.colContainer = norm;
  scroll.appendChild(colDiv);

  // Placeholder — updateColumnChrome (always called right after, for both
  // new and reused columns) replaces this with a real header immediately.
  const headerPlaceholder = doc.createElement("div");
  headerPlaceholder.className = "kb-col-header";
  colDiv.appendChild(headerPlaceholder);

  const zone = doc.createElement("div");
  zone.className = `drop-zone drop-zone-${norm}`;
  zone.style.cssText = "min-height:200px;border:2px dashed var(--background-modifier-border);border-right:none;border-radius:0;padding:5px;flex-grow:1;display:flex;flex-direction:column;";
  colDiv.appendChild(zone);

  return { colDiv, zone };
}

// Applies (or re-applies) the column's own layout style (narrow/wide,
// narrow-mode active/inactive visibility), the over-limit warning flag, and
// a freshly built header — run on every column on every render, new or
// reused, since any of these can change without the column itself being new
// (a resize, a settings change, a card crossing the max-count threshold).
function updateColumnChrome(
  colDiv: HTMLElement,
  norm: string,
  col: { rawTag: string; cards: any[] },
  config: KanbanConfig,
  isNarrow: boolean,
  activeNorm: string,
  doc: Document
): void {
  const colStyle = isNarrow
    ? `width:calc(100% - 16px);margin:0 8px 20px;padding:10px;`
    : `flex:1;min-width:200px;max-width:260px;padding:10px 0 10px 0;margin:0;display:flex;flex-direction:column;`;
  // Narrow mode never set an explicit `display` before (every column but the
  // active one simply didn't exist) — matching that means "block" (a div's
  // default), not "flex", for the visible one; only "none" is new here.
  colDiv.style.cssText = colStyle + (isNarrow ? `display:${norm === activeNorm ? "block" : "none"};` : "");

  const colMax = config.columnMaxCards[norm] || 0;
  if (colMax > 0 && col.cards.length > colMax) colDiv.dataset.colOverlimit = "1";
  else delete colDiv.dataset.colOverlimit;

  const oldHeader = colDiv.querySelector(":scope > .kb-col-header");
  const newHeader = buildColumnHeader(norm, col, config, doc);
  if (oldHeader) oldHeader.replaceWith(newHeader);
  else colDiv.insertBefore(newHeader, colDiv.firstChild);
}

// Reconciles one column's cards against its drop-zone's current DOM,
// matched by "filePath:line". Cards whose rendered HTML hasn't changed are
// left completely untouched; changed ones are regenerated (via the same
// createCardHTML used for a full build, so there's no separate diffing rule
// to keep in sync) and swapped in place; gone ones are removed; new ones are
// created. Comparing normalized outerHTML-to-outerHTML (not raw string vs
// DOM) avoids false "changed" positives from the browser's own HTML
// normalization on parse.
function reconcileZoneCards(
  zone: HTMLElement,
  cards: any[],
  norm: string,
  config: KanbanConfig,
  vaultName: string,
  doc: Document
): void {
  const existing = new Map<string, HTMLElement>();
  zone.querySelectorAll<HTMLElement>(":scope > .kanban-card").forEach((el) => {
    existing.set(`${el.dataset.file}:${el.dataset.line}`, el);
  });

  const seen = new Set<string>();
  for (const card of cards) {
    const key = `${card.filePath}:${card.item.line}`;
    seen.add(key);
    const current = existing.get(key);
    const fresh = createCardNode(card, card.multiTag, norm, config, vaultName, doc);
    let node: HTMLElement;
    if (current && current.outerHTML === fresh.outerHTML) {
      node = current;
    } else {
      if (current) current.replaceWith(fresh);
      node = fresh;
    }
    zone.appendChild(node); // (re)positions into final order; a no-op if already last
  }

  for (const [key, el] of existing) {
    if (!seen.has(key)) el.remove();
  }

  // Insert-slots are cheap and stateless (drop-target hit-testing only) —
  // simplest to just rebuild them fresh rather than diff them too.
  zone.querySelectorAll(".insert-slot").forEach((s) => s.remove());
  const insertSlot = (idx: number) => {
    const s = doc.createElement("div");
    s.className = "insert-slot";
    s.style.cssText = "height:0;border-top:2px dashed transparent;width:100%";
    s.dataset.index = String(idx);
    return s;
  };
  const cardEls = Array.from(zone.querySelectorAll<HTMLElement>(":scope > .kanban-card"));
  if (cardEls.length > 0) zone.insertBefore(insertSlot(0), cardEls[0]);
  cardEls.forEach((el, i) => {
    if (i < cardEls.length - 1) zone.insertBefore(insertSlot(i + 1), cardEls[i + 1]);
  });
  zone.appendChild(insertSlot(cardEls.length));
}

// Reconciles every column against scroll's current DOM: removes columns no
// longer present (e.g. the due column just emptied), creates newly-present
// ones (e.g. the due column just got its first card), and keeps the rest in
// place — then reconciles each column's own cards. Always builds/reconciles
// every column, even in narrow mode (unlike the old behavior of only ever
// building the active column's DOM) — visibility is CSS-only, via
// updateColumnChrome — so switching tabs never needs a rebuild either.
function reconcileColumns(
  scroll: HTMLElement,
  columns: Record<string, { rawTag: string; cards: any[] }>,
  allNorms: string[],
  activeNorm: string,
  isNarrow: boolean,
  config: KanbanConfig,
  vaultName: string,
  doc: Document
): void {
  let tabBar = scroll.querySelector<HTMLElement>(":scope > .kb-tab-bar");
  if (isNarrow) {
    if (!tabBar) {
      tabBar = doc.createElement("div");
      tabBar.className = "kb-tab-bar";
      scroll.insertBefore(tabBar, scroll.firstChild);
    } else {
      tabBar.innerHTML = "";
      scroll.insertBefore(tabBar, scroll.firstChild);
    }
    tabBar.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;padding:4px 8px 14px;width:100%;box-sizing:border-box;touch-action:none;";
    for (const norm of allNorms) {
      const col = columns[norm];
      const tab = doc.createElement("button");
      tab.textContent = col.rawTag.replace(/^#/, "").toUpperCase();
      tab.style.cssText = `min-height:44px;padding:8px 18px;border-radius:22px;
        border:1px solid var(--background-modifier-border);
        font-size:.9em;cursor:pointer;
        transition:transform .1s,outline .1s;touch-action:none;`;
      (tab as HTMLButtonElement).dataset.colNorm = norm;
      (tab as HTMLButtonElement).dataset.colActive = norm === activeNorm ? "1" : "0";
      const tabMax = config.columnMaxCards[norm] || 0;
      if (tabMax > 0 && col.cards.length > tabMax) (tab as HTMLButtonElement).dataset.colOverlimit = "1";
      tabBar.appendChild(tab);
    }
  } else if (tabBar) {
    tabBar.remove();
  }

  const existingCols = new Map<string, HTMLElement>();
  scroll.querySelectorAll<HTMLElement>(":scope > [data-col-container]").forEach((el) => {
    existingCols.set(el.dataset.colContainer!, el);
  });

  for (const [norm, el] of existingCols) {
    if (!allNorms.includes(norm)) el.remove();
  }

  for (const norm of allNorms) {
    const col = columns[norm];
    let colDiv = existingCols.get(norm) ?? null;
    let zone: HTMLElement;
    if (!colDiv) {
      const built = buildColumnShell(scroll, norm, col, doc);
      colDiv = built.colDiv;
      zone = built.zone;
    } else {
      zone = colDiv.querySelector(".drop-zone") as HTMLElement;
    }
    scroll.appendChild(colDiv); // (re)positions into allNorms order; a no-op if already last

    updateColumnChrome(colDiv, norm, col, config, isNarrow, activeNorm, doc);
    reconcileZoneCards(zone, col.cards, norm, config, vaultName, doc);
  }
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

  // Step A1b: backfill "%% @created %%" onto any card/subtask found without one
  await stampMissingCreatedDates(app, paths, config);

  // Step A1c: normalize "%% @ucc %%" → "%% @uncounted_children %%" on disk
  await expandUncountedShorthand(app, paths);

  let items = await collectItems(app, paths, config);

  // Auto-move past/undated #later items and triggered #later items → due column
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
      await moveToColumn(app, item.filePath, item.item.line, item.item.tags, config.dueColumn, false, config, null, null, null, true);
    items = await collectItems(app, paths, config);
  }

  // Step A2: add the due tag and remove date from dated subtasks of remaining #later cards
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

  // Step B: move triggered #recurrent cards → due column
  if (config.normRecurrent) {
    const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    // A card with a literal @date (interval-based recurrence) fires once that date
    // arrives; a card with weekday/month/day-of-month triggers fires on matching
    // days; a card with no working trigger of its own (missing "@recurrent"
    // outright — a plain container for adding recurring subtasks to, see
    // applyRecurrentTrigger — or carrying it with no schedule set) is only
    // legitimate while it holds at least one properly-triggered recurring
    // subcard anywhere in its subtree — once it doesn't (never did, or every
    // subcard it once held is gone), it's not serving that purpose and fires
    // into Due instead.
    const recurrentToMove = items.filter((i) => {
      if (!i.item.tags.some((t: string) => normalizeTag(t) === config.normRecurrent)) return false;
      if (extractSkipDate(i.item.text) === todayStr) return false;
      if (!hasRecurrentAnnotation(i.item.text, config.normRecurrent) || !hasValidTriggers(i.item.text, config.normRecurrent)) {
        return !hasChildWithTrigger(i.item.subs, config.normRecurrent);
      }
      const repeatDate = parseCardDate(i.item.text);
      if (repeatDate) return repeatDate <= today;
      const triggers = extractTriggerAnnotations(i.item.text, config.normRecurrent);
      return matchesTriggerAnnotations(triggers, today);
    });
    if (recurrentToMove.length) {
      for (const item of recurrentToMove)
        await moveToColumn(app, item.filePath, item.item.line, item.item.tags, config.dueColumn, false, config, null, null, null, true);
      items = await collectItems(app, paths, config);
    }
    // Step C: add the due tag to subtasks of #recurrent cards whose trigger fires today
    let anySubTriggered = false;
    for (const i of items) {
      if (!i.item.tags.some((t: string) => normalizeTag(t) === config.normRecurrent)) continue;
      if (await triggerRecurrentSubs(app, i.item.subs, i.filePath, config, today, todayStr))
        anySubTriggered = true;
    }
    if (anySubTriggered) items = await collectItems(app, paths, config);

    // Step D: pop subtasks that will never fire (see popOrphanedRecurrentSubs) into Due
    if (await popOrphanedRecurrentSubs(app, items, config)) items = await collectItems(app, paths, config);
  }

  // Step E: promote dependent subtasks (">"/"^" markers) whose predecessor/
  // parent is done or deleted into Due (see promoteDependentSubtasks).
  if (await promoteDependentSubtasks(app, items, config)) items = await collectItems(app, paths, config);

  // items is now settled for this build — consume any pending force-expand
  // flags against this final list (collectItems only peeked them, since it
  // may have run several times above while items was still being resolved).
  for (const i of items) pendingForceExpand.delete(forceExpandKey(i.filePath, i.item.line));

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

  // Build (first render) or reuse (every render since) the wrapper/scroll —
  // reused so reconcileColumns below can diff against what's already on
  // screen instead of starting from nothing.
  let wrapper = containerEl.querySelector<HTMLElement>("#kanban-wrapper");
  let scroll: HTMLElement;
  if (!wrapper) {
    wrapper = containerEl.createEl("div", { attr: { id: "kanban-wrapper" } });
    scroll = wrapper.createEl("div", {
      attr: {
        id: "kanban-scroll",
        style:
          "display:flex;overflow-x:auto;gap:0;padding:12px 0;-webkit-overflow-scrolling:touch;",
      },
    });
  } else {
    scroll = wrapper.querySelector<HTMLElement>("#kanban-scroll")!;
  }

  // Search/filter bar — built once and left alone on later renders so the
  // user's in-progress query (and focus) survives a re-render; attachListeners
  // re-applies the filter to whatever cards exist after each reconcile.
  if (!wrapper.querySelector("#kb-search-bar")) {
    const searchBar = boardDoc.createElement("div");
    searchBar.id = "kb-search-bar";
    searchBar.style.cssText =
      "display:flex;gap:8px;align-items:center;padding:10px 6px 0;";
    searchBar.innerHTML = `
      <input id="kb-search-input" type="text" placeholder="Filter cards… (supports * and ?)"
        style="flex:1;padding:7px 10px;border:1px solid var(--background-modifier-border);
               border-radius:6px;background:var(--background-primary);color:var(--kb-text);
               font-size:.9em;box-sizing:border-box;">
      <button id="kb-search-clear" type="button"
        style="padding:7px 14px;border:1px solid var(--background-modifier-border);
               border-radius:6px;background:var(--background-secondary);color:var(--kb-text);
               cursor:pointer;font-size:.9em;white-space:nowrap;">Clear</button>`;
    wrapper.insertBefore(searchBar, wrapper.firstChild);
  }

  const isNarrow = isNarrowLayout(
    wrapper.clientWidth > 0 ? wrapper.clientWidth : window.innerWidth
  );
  wrapper.dataset.narrow = isNarrow ? "1" : "0";

  // The due column (target for auto-moved due-later/recurrent tasks) is hidden while
  // empty and reappears on its own once the board moves a card into it.
  const allNorms = Object.keys(columns).filter(
    (norm) => norm !== config.normDue || columns[norm].cards.length > 0
  );
  let activeNorm = (savedActiveCol && allNorms.includes(savedActiveCol)) ? savedActiveCol : config.normStart;
  if (!allNorms.includes(activeNorm)) activeNorm = allNorms[0];

  reconcileColumns(scroll, columns, allNorms, activeNorm, isNarrow, config, vaultName, boardDoc);

  let statusEl = wrapper.querySelector<HTMLElement>("#kanban-status");
  if (!statusEl) {
    statusEl = wrapper.createEl("p", {
      attr: {
        id: "kanban-status",
        style:
          "margin-top:20px;text-align:center;color:var(--text-muted);font-size:.9em;",
      },
    });
  }
  statusEl.textContent = `Found: ${items.length} items`;
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
  // Isolation is deferred behind this timer (see onCardClick) so the first
  // click of a double-click never gets the chance to reshuffle the board
  // (hiding cards shifts everything under the cursor) before the second
  // click lands — that reshuffle was breaking double-click-to-edit on card
  // and subtask titles.
  let familyIsolateTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Helpers ──
  const cardKey = (card: HTMLElement): string => `${card.dataset.file}:${card.dataset.line}`;

  const cardDataFrom = (el: Element | null) => {
    const c = el?.closest(".kanban-card") as HTMLElement | null;
    if (!c) return null;
    return {
      filePath: c.dataset.file!,
      lineNum: parseInt(c.dataset.line!, 10),
      originalTags: JSON.parse(c.dataset.tags!),
      isPromoted: c.dataset.isPromoted === "true",
      subs: c.dataset.subs ? JSON.parse(c.dataset.subs) as any[] : [],
      rawText: c.dataset.raw || "",
    };
  };

  const siblingDataFrom = (zone: HTMLElement): SiblingData[] =>
    Array.from(zone.querySelectorAll(".kanban-card")).map((c: any) => {
      const digits = c.dataset.digits || "99999";
      return { digits, len: magLen(digits) };
    }).sort((a, b) => compareDigits(a.digits, b.digits));

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
    ownerDoc().querySelectorAll<HTMLElement>(".insert-slot").forEach(
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

  // Walks up from a card to its top-most ancestor within the same file,
  // following the outline nesting. Shared by the hover-highlight coloring
  // below and by the click-to-isolate filter further down, so "family"
  // always means the same set of cards everywhere on the board.
  const topParentOf = (card: HTMLElement, allCards: HTMLElement[]): HTMLElement => {
    const file = card.dataset.file!;
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
    return topParent;
  };

  // BFS: every card reachable downward from a top parent — family members
  // can land in any column, not just the parent's.
  const familyFromRoot = (topParent: HTMLElement, allCards: HTMLElement[]): Set<HTMLElement> => {
    const file = topParent.dataset.file!;
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
    return family;
  };

  const applyHighlights = (card: HTMLElement) => {
    clearHighlights();
    const file = card.dataset.file!;
    const allCards = Array.from(boardEl.querySelectorAll<HTMLElement>(".kanban-card"));
    const topParent = topParentOf(card, allCards);
    const family = familyFromRoot(topParent, allCards);

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

  // boardEl *is* #kanban-wrapper (see KanbanView.renderBoard) — read its
  // dataset directly rather than re-querying by id through the global
  // `document`, which resolves to the wrong window for a popped-out board.
  const isNarrowNow = () => boardEl.dataset.narrow === "1";

  // ── Search / filter ──
  // Strips markdown emphasis markers and all whitespace from card text so
  // "text hig" and "texthig" both match "...**higlightedguy**..." — words
  // glued together without spaces or ** are treated the same as words typed
  // with them. The query gets its own (lighter) normalization below, since
  // "*"/"?" in the query are wildcards, not markdown to strip.
  const normalizeHaystack = (s: string): string =>
    s.toLowerCase().replace(/[*_`]/g, "").replace(/\s+/g, "");

  const normalizeQuery = (s: string): string =>
    s.toLowerCase().replace(/\s+/g, "");

  // "*" → any run of characters, "?" → any single character; everything
  // else is matched literally (regex-escaped first).
  const wildcardToRegExp = (query: string): RegExp => {
    const escaped = query.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped.replace(/\*/g, ".*").replace(/\?/g, "."));
  };

  const subsSearchText = (subs: any[]): string =>
    (subs || []).map((s: any) => (s.text || "") + subsSearchText(s.subs || [])).join("");

  const cardSearchText = (card: HTMLElement): string => {
    let subs: any[] = [];
    try { subs = JSON.parse(card.dataset.subs || "[]"); } catch { /* ignore malformed subs */ }
    return normalizeHaystack((card.dataset.raw || "") + subsSearchText(subs));
  };

  // Narrow (single-column/phone) layout normally shows only the active tab's
  // column, hiding the rest via colDiv display:none — great for browsing, but
  // it would hide filter matches sitting in every other column. While a query
  // is active every column that still has a visible card is shown instead, so
  // results appear as one long list divided by their own column headers (each
  // keeping its own background color, since that's a CSS rule keyed off
  // data-col-container — untouched here) stacked in board order (columns are
  // already in that order in the DOM; only display: toggles). Cleared back to
  // the single active tab once the query empties out.
  const restoreNarrowActiveColumn = () => {
    if (!isNarrowNow()) return;
    const activeNorm = boardEl.querySelector<HTMLElement>(
      '[data-col-norm][data-col-active="1"]'
    )?.dataset.colNorm;
    boardEl.querySelectorAll<HTMLElement>("[data-col-container]").forEach((colDiv) => {
      colDiv.style.display = colDiv.dataset.colContainer === activeNorm ? "block" : "none";
    });
  };

  const showNarrowColumnsWithMatches = () => {
    if (!isNarrowNow()) return;
    boardEl.querySelectorAll<HTMLElement>("[data-col-container]").forEach((colDiv) => {
      const anyVisible = Array.from(colDiv.querySelectorAll<HTMLElement>(".kanban-card")).some(
        (c) => c.style.display !== "none"
      );
      colDiv.style.display = anyVisible ? "block" : "none";
    });
  };

  // Cards that don't match the query are hidden, unless another card in the
  // same family (see topParentOf) does match — then the whole family stays
  // visible, so context (parent/siblings) around a hit is never cut off.
  //
  // Clicking a card (see toggleFamilyIsolation) takes priority over the text
  // query when active: it isolates that one card's family, hiding everything
  // else outright, so the family is visible without having to scroll for it.
  // The stored key lives on boardEl's dataset (not a plain closure variable)
  // so it survives attachListeners being torn down and rebuilt on refresh —
  // same trick as dataset.activeCol/dataset.narrow.
  const applyFilterInner = () => {
    const allCards = Array.from(boardEl.querySelectorAll<HTMLElement>(".kanban-card"));

    const isolatedRootKey = boardEl.dataset.familyIsolate;
    if (isolatedRootKey) {
      const root = allCards.find((c) => cardKey(c) === isolatedRootKey);
      if (root) {
        const family = familyFromRoot(root, allCards);
        allCards.forEach((c) => { c.style.display = family.has(c) ? "" : "none"; });
        showNarrowColumnsWithMatches();
        return;
      }
      delete boardEl.dataset.familyIsolate; // the card that started this is gone — fall through
    }

    const searchInput = boardEl.querySelector<HTMLInputElement>("#kb-search-input");
    const query = normalizeQuery(searchInput?.value ?? "");

    if (!query) {
      allCards.forEach((c) => { c.style.display = ""; });
      restoreNarrowActiveColumn();
      return;
    }

    const regex = wildcardToRegExp(query);
    const matches = new Map<HTMLElement, boolean>();
    for (const card of allCards) matches.set(card, regex.test(cardSearchText(card)));

    const rootOf = new Map<HTMLElement, HTMLElement>();
    const familyMatches = new Set<HTMLElement>();
    for (const card of allCards) {
      const root = topParentOf(card, allCards);
      rootOf.set(card, root);
      if (matches.get(card)) familyMatches.add(root);
    }

    for (const card of allCards) {
      const show = matches.get(card) || familyMatches.has(rootOf.get(card)!);
      card.style.display = show ? "" : "none";
    }

    showNarrowColumnsWithMatches();
  };

  // Hiding/showing cards can shrink the board's content height enough that
  // the browser auto-clamps the pane's scroll position back toward 0 — which
  // un-hides the search bar sitting above #kanban-scroll (scrolled out of
  // view on open, see KanbanView.scrollPastSearchBar) even though nothing
  // asked for it to reappear. Restoring the pre-filter scrollTop re-clamps it
  // against the *new* (smaller) scrollHeight instead, so it only creeps back
  // into view if there's genuinely not enough content left to stay past it.
  const applyFilter = () => {
    const viewContent = boardEl.closest<HTMLElement>(".view-content");
    const prevScrollTop = viewContent?.scrollTop;
    applyFilterInner();
    if (viewContent && prevScrollTop !== undefined) {
      viewContent.scrollTop = prevScrollTop;
      // On some WebKit-based views (iPad's), a scrollTop write made in the
      // same tick as the display-toggling above gets overridden once the
      // browser actually settles layout for the now-shorter content — the
      // write above alone silently loses the race there, letting the search
      // bar creep back into view. Re-applying it once more after that layout
      // pass has run keeps it pinned on those views too.
      requestAnimationFrame(() => { viewContent.scrollTop = prevScrollTop; });
    }
  };

  const searchInputEl = boardEl.querySelector<HTMLInputElement>("#kb-search-input");
  const searchClearEl = boardEl.querySelector<HTMLButtonElement>("#kb-search-clear");

  // Clicking a card isolates its family (hides every other card); clicking
  // any card already inside the isolated family releases it again. Clicking
  // a card outside it switches the isolation to the new family instead.
  const toggleFamilyIsolation = (card: HTMLElement) => {
    const allCards = Array.from(boardEl.querySelectorAll<HTMLElement>(".kanban-card"));
    const topParent = topParentOf(card, allCards);
    // Standalone card (no parent/children/siblings) — isolating it would just
    // hide every other card on the board for no relational reason, so the
    // click isn't offered as a filter trigger at all here (same "no family"
    // check applyHighlights uses to skip coloring).
    if (topParent === card && familyFromRoot(topParent, allCards).size === 1) return;
    const rootKey = cardKey(topParent);
    if (boardEl.dataset.familyIsolate === rootKey) {
      delete boardEl.dataset.familyIsolate;
    } else {
      boardEl.dataset.familyIsolate = rootKey;
      // Isolation and the text search are mutually exclusive — an active
      // query would otherwise sit there silently doing nothing (applyFilter
      // returns before ever reading it), which reads as broken.
      if (searchInputEl) searchInputEl.value = "";
    }
    applyFilter();
  };

  const onSearchInput = () => {
    delete boardEl.dataset.familyIsolate;
    applyFilter();
  };
  const onSearchClear = () => {
    if (searchInputEl) searchInputEl.value = "";
    delete boardEl.dataset.familyIsolate;
    applyFilter();
    searchInputEl?.focus();
  };
  searchInputEl?.addEventListener("input", onSearchInput);
  searchClearEl?.addEventListener("click", onSearchClear);
  // Re-apply immediately: reconcileZoneCards may have swapped in fresh card
  // nodes (whose display style always starts unset) since the last render.
  applyFilter();

  // Shared by the desktop blank-margin click and the mobile card-menu sheet.
  async function openCardColorDialog(card: HTMLElement) {
    const filePath = card.dataset.file!;
    const lineNum = parseInt(card.dataset.line!, 10);
    const existing = card.dataset.color || null;
    const vaultName = app.vault.getName();
    const title = buildParentPreviewHTML(card.dataset.raw || "", config, vaultName);

    // Built from a fresh read (not the DOM's own data-subs snapshot, which
    // may be stale by however long the board's been open) so the dialog's
    // in-memory tree — and every trailingRaw boundary/line number it
    // captures — is guaranteed to match what's actually on disk right now.
    // Also the only place the card's own uncounted markers are read from:
    // card.dataset.raw has its "%% … %%" comments already stripped (see
    // createCardHTML), so it can't answer this.
    let subs: any[] = [];
    let tree: DialogNode[] = [];
    let uncounted = false;
    let uncountedChildren = false;
    try {
      const { lines } = await readFileLines(app, filePath);
      const fileItems = parseFileEntries(lines, filePath, config);
      const cardEntry = fileItems.find((f: any) => f.item.line === lineNum);
      subs = cardEntry?.item.subs || [];
      tree = buildDialogTree(lines, subs);
      uncounted = isUncountedText(cardEntry?.item.text ?? "");
      uncountedChildren = isUncountedChildrenText(cardEntry?.item.text ?? "");
    } catch { /* ignore — dialog opens with no subtasks */ }

    showCardColorDialog(
      app,
      existing,
      title,
      lineNum,
      tree,
      config,
      uncounted,
      uncountedChildren,
      async (hex) => {
        await updateCardColor(app, filePath, lineNum, hex);
        requestAnimationFrame(() => setTimeout(refresh, 50));
      },
      async (newUncounted, newUncountedChildren) => {
        await setLineUncountedFlags(app, filePath, lineNum, { uncounted: newUncounted, uncountedChildren: newUncountedChildren });
        requestAnimationFrame(() => setTimeout(refresh, 50));
      },
      // The whole session's pending reorders/reparents, already folded into
      // `finalTree` — applySubtaskTree re-derives the card's current line
      // range fresh and replaces it in one splice (see its own doc comment
      // for why re-deriving beats trusting this dialog's open-time lines).
      async (finalTree) => {
        await applySubtaskTree(app, filePath, lineNum, { id: lineNum, raw: "", trailingRaw: [], children: finalTree }, config);
        requestAnimationFrame(() => setTimeout(refresh, 50));
      },
      async () => {
        const lastLine = parseInt(card.dataset.lastSubLine || `${lineNum}`, 10);
        const changed = await deleteCardOrSubtask(
          app, filePath, lineNum, lastLine, config,
          true, subs.length > 0, subs, card.dataset.isPromoted === "true"
        );
        if (changed) requestAnimationFrame(() => setTimeout(refresh, 50));
      },
      // Same immediate-save semantics as the board's own inline subtask
      // editor (onSubDblClick): commits right away, independent of this
      // dialog's Apply/Cancel gate for color/reorder.
      async (subLine, newText) => {
        await editCardText(app, filePath, subLine, newText);
        requestAnimationFrame(() => setTimeout(refresh, 50));
        try {
          const { lines } = await readFileLines(app, filePath);
          const rawLine = (lines[subLine - 1] || "").replace(/^\s+/, "");
          return renderSubtaskPreviewHTML({ text: rawLine, line: subLine }, config);
        } catch { return null; }
      },
      // Same soft-delete protection as the board's own subtask editor
      // (onSubDblClick): a subtask something else depends on is always just
      // marked deleted, never physically removed (see deleteCardOrSubtask).
      async (subLine) => {
        const siblingArr = findSiblingArrayContaining(subs, subLine);
        const idx = siblingArr?.findIndex((s: any) => s.line === subLine) ?? -1;
        const node = idx >= 0 ? siblingArr![idx] : null;
        const hasDependents = !!(node && siblingArr && isDependedOn(node, siblingArr, idx));
        const lastLine = maxSubLine(node?.subs || []) || subLine;
        const ok = await deleteCardOrSubtask(app, filePath, subLine, lastLine, config, false, false, [], false, hasDependents);
        if (ok) requestAnimationFrame(() => setTimeout(refresh, 50));
        return ok;
      }
    );
  }

  // True for a click on anything inside the card that already has its own
  // effect — a checkbox, a date/trigger label, promote/demote, the add-sub
  // "+" button, or (only when present — see the hasSubs branch of
  // createCardNode) the title's own expand/collapse toggle. Several of these
  // handlers are registered on boardEl *after* onCardClick and only call
  // stopPropagation (not stopImmediatePropagation), which doesn't stop a
  // same-element listener that already ran — so onCardClick has to opt
  // itself out explicitly rather than rely on those handlers to suppress it.
  const hasOwnClickEffect = (target: Element): boolean => {
    if (target.closest("a,button,.promote-icon,.demote-btn,.kb-date-label,.kb-trigger-label,.kb-sub-check,.kb-add-sub")) {
      return true;
    }
    const titleDiv = target.closest(".card-title") as HTMLElement | null;
    return !!titleDiv?.hasAttribute("onclick");
  };

  function onCardClick(e: MouseEvent) {
    const card = (e.target as Element).closest(".kanban-card") as HTMLElement | null;
    if (!card) {
      // Clicking anywhere else on the board (blank column space, a header,
      // the tab bar, ...) releases an active isolation the same way clicking
      // the isolated card again or pressing Escape does.
      if (boardEl.dataset.familyIsolate) {
        delete boardEl.dataset.familyIsolate;
        applyFilter();
      }
      return;
    }
    applyHighlights(card); // paint-only (outline/background) — safe to run immediately, never shifts layout
    if (familyIsolateTimer) clearTimeout(familyIsolateTimer);
    if (hasOwnClickEffect(e.target as Element)) {
      // Let that element's own handler do its thing undisturbed — no
      // isolation reshuffle competing with it.
      familyIsolateTimer = null;
      return;
    }
    if (e.detail > 1) {
      // Second (or later) click of a double-click — a dblclick handler
      // (title/subtask edit) is about to run on the *current*, undisturbed
      // layout; don't reshuffle the board out from under it.
      familyIsolateTimer = null;
    } else {
      // First click — wait out the double-click window before actually
      // isolating, in case a second click follows and cancels this.
      familyIsolateTimer = setTimeout(() => {
        familyIsolateTimer = null;
        toggleFamilyIsolation(card);
      }, 300);
    }
  }

  // ── Parent-card link (badge row on a promoted sub-task) ──
  function onParentLinkClick(e: MouseEvent) {
    const link = (e.target as Element).closest(".kb-parent-link") as HTMLElement | null;
    if (!link) return;
    e.stopImmediatePropagation(); // don't let onCardClick's own handling (later in the listener list) override the highlight/scroll below
    const row = link.closest(".kb-parent-row") as HTMLElement | null;
    if (!row) return;
    const file = row.dataset.parentFile!;
    const line = row.dataset.parentLine!;

    const findParentCard = () =>
      Array.from(boardEl.querySelectorAll<HTMLElement>(".kanban-card"))
        .find((c) => c.dataset.file === file && c.dataset.line === line) ?? null;

    const jumpToParent = () => {
      const parentCard = findParentCard();
      if (!parentCard) return;
      parentCard.querySelector("details")?.setAttribute("open", "");
      parentCard.scrollIntoView({ behavior: "smooth", block: "center" });
      applyHighlights(parentCard);
    };

    // Narrow/mobile layout only renders the active tab's column — switch to
    // the parent's tab first (same as clicking it) so it's actually visible,
    // then wait for that re-render before opening/scrolling to it.
    if (isNarrowNow()) {
      const parentCol = findParentCard()?.closest<HTMLElement>("[data-col-container]")?.dataset.colContainer;
      const wrapper = ownerDoc().getElementById("kanban-wrapper");
      if (parentCol && wrapper && wrapper.dataset.activeCol !== parentCol) {
        wrapper.dataset.activeCol = parentCol;
        refresh();
        requestAnimationFrame(() => setTimeout(jumpToParent, 50));
        return;
      }
    }
    jumpToParent();
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
      const confirmed = await showConfirmDialog(app, `Create a project document for "${plainTitle}"?`);
      if (confirmed) {
        await moveCardToNewDoc(app, card.filePath, card.lineNum, plainTitle, targetTag, config);
        requestAnimationFrame(() => setTimeout(refresh, 50));
        currentInsertIndex = -1;
        return;
      }
    }

    const isDone = targetNorm === config.normDone;
    const siblings = zone ? siblingDataFrom(zone) : [];
    const insertIdx = (zone && currentInsertIndex >= 0) ? currentInsertIndex : siblings.length;
    const isMulti = card.originalTags
      .map(normalizeTag)
      .filter((t: string) => config.normKanban.includes(t)).length > 1;
    const newCalc = calcInsertOrder(siblings, insertIdx, isMulti);
    const colTitle = targetTag
      .replace(/^#/, "")
      .replace(/\b\w/g, (l: string) => l.toUpperCase());
    // Leaving Later for any other column: the @date annotation was Later's trigger
    // date, which is meaningless once the card is no longer in Later.
    const wasLater = card.originalTags.some((t: string) => normalizeTag(t) === config.normLater);

    if (config.normRecurrent && targetNorm === config.normRecurrent) {
      const { lines } = await readFileLines(app, card.filePath);
      const lineTxt = lines[card.lineNum - 1] || "";
      // Already legitimate — either genuinely scheduled itself, or a container
      // already holding a properly-triggered recurring subtask — so moving it
      // around the board (drag, reorder, click-to-advance) never re-prompts.
      if (!hasValidTriggers(lineTxt, config.normRecurrent) && !hasChildWithTrigger(card.subs, config.normRecurrent)) {
        showRecurrentTriggerDialog(app, async (trigger) => {
          await moveToColumn(app, card.filePath, card.lineNum, card.originalTags, targetTag, false, config, null, newCalc.digits, trigger, wasLater);
          await uncheckSubtasks(app, card.filePath, card.subs, config);
          requestAnimationFrame(() => setTimeout(refresh, 50));
        }, [], extractRepeatSpec(lineTxt));
        return;
      }
      const ok = await moveToColumn(app, card.filePath, card.lineNum, card.originalTags, targetTag, false, config, null, newCalc.digits, null, wasLater);
      if (ok) await uncheckSubtasks(app, card.filePath, card.subs, config);
      if (ok) requestAnimationFrame(() => setTimeout(refresh, 50));
    } else if (targetNorm === config.normLater) {
      const { lines } = await readFileLines(app, card.filePath);
      const lineTxt = lines[card.lineNum - 1] || "";
      const dateMatch = lineTxt
        .replace(/%%[\s\S]*?@\s*\d+\s*[cx]?\s*%%/g, "")
        .trim()
        .match(/@(\d{4}-\d{2}-\d{2})/);
      const existing = dateMatch
        ? new Date(dateMatch[1] + "T00:00:00")
        : null;
      const defDate = getDefaultDate(existing).toISOString().split("T")[0];

      showDateDialog(
        `Set date for ${colTitle}`,
        defDate,
        app,
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
            null,
            dateStr === null
          );
          requestAnimationFrame(() => setTimeout(refresh, 50));
        }
      );
    } else {
      // A card moved to Done that still has open subtasks shouldn't land
      // collapsed — open it so the unchecked work is visible (it also gets
      // the Done-column "unmanaged work" highlight, see hasUnmanagedWork).
      // The force-expand is a session-only flag, not written to the file —
      // see pendingForceExpand.
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
        null,
        wasLater
      );
      if (ok) {
        if (openOnDone) pendingForceExpand.add(forceExpandKey(card.filePath, card.lineNum));
        requestAnimationFrame(() => setTimeout(refresh, 50));
      }
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
    // A parent that's tagged #recurrent but has no working "@recurrent" trigger of
    // its own (missing the annotation outright, or carrying it with no schedule
    // set) will never fire — so a subtask added under it must be given a real
    // trigger of its own, or it'd be just as permanently stuck. "No trigger" is
    // only offered when the parent itself actually has a working trigger.
    const parentRaw = card.dataset.raw || "";
    const parentHasWorkingTrigger =
      !!config.normRecurrent &&
      hasRecurrentAnnotation(parentRaw, config.normRecurrent) &&
      hasValidTriggers(parentRaw, config.normRecurrent);

    const doAdd = async (text: string) => {
      if (await addSubtaskToCard(app, filePath, afterLine, cardLine, text))
        requestAnimationFrame(() => setTimeout(refresh, 50));
    };

    showSubtaskDialog(app, async (text) => {
      if (isLater) {
        const defDate = getDefaultDate().toISOString().split("T")[0];
        showDateDialog("Set date for subtask", defDate, app, async (dateStr) => {
          await doAdd(dateStr ? appendToFirstLine(text, dateStr) : text);
        });
      } else if (isRecurrent) {
        showRecurrentTriggerDialog(app, async (triggerStr) => {
          const n = new Date();
          const skipStr = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
          const triggerPart = triggerStr ? ` ${triggerStr}` : '';
          await doAdd(appendToFirstLine(text, `@${config.normRecurrent}${triggerPart} %% @skip:${skipStr} %%`));
        }, [], null, { allowNoTrigger: parentHasWorkingTrigger });
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
      icon.dataset.parentDigits || "0",
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
    showDateDialog("Change date", defDate, app, async (dateStr) => {
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
    showRecurrentTriggerDialog(app, async (newTriggerStr) => {
      await updateCardTriggers(app, card.dataset.file!, parseInt(card.dataset.line!, 10), config.normRecurrent, newTriggerStr);
      requestAnimationFrame(() => setTimeout(refresh, 50));
    }, existing, extractRepeatSpec(rawText));
  }

  // ── Inline card text editing ──
  async function onDblClick(e: MouseEvent) {
    const card = (e.target as Element).closest(".kanban-card") as HTMLElement | null;
    if (!card) return;
    if ((e.target as Element).closest("a,button,.promote-icon,.demote-btn,.kb-date-label,.kb-trigger-label")) return;

    const titleDiv = (e.target as Element).closest(".card-title") as HTMLElement | null;
    if (titleDiv) {
      if (isNarrowNow()) {
        showCardMenu(card);
        return;
      }
      await startTitleEdit(card, titleDiv);
      return;
    }

    // Double-click on the card's own blank margin — e.target is the card
    // element itself, not any child (title, subtask row, parent-link badge,
    // button, checkbox, ...) — opens the color/reorder-subtasks dialog.
    // Narrow layout offers the same thing via the card-menu sheet instead
    // (same as the title double-click above).
    if (e.target !== card) return;
    if (isNarrowNow()) {
      showCardMenu(card);
      return;
    }
    openCardColorDialog(card);
  }

  async function startTitleEdit(card: HTMLElement, titleDivArg?: HTMLElement | null) {
    const titleDiv = titleDivArg ?? (card.querySelector(".card-title") as HTMLElement | null);
    if (!titleDiv) return;
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

    // Guards against finishEdit running twice for the same session: refresh()
    // (scheduled below) rebuilds the board and detaches this still-focused
    // input, which makes the browser fire another "blur" — re-entering here
    // with a lineNum that may now point at a different line if the first
    // pass archived/moved content. titleDiv.contains(input) alone doesn't
    // catch this, since input stays a DOM child of titleDiv even once
    // titleDiv itself has been detached from the document.
    const popModEnterScope = withNewlineOnModEnter(app, input, autoResize);
    let finished = false;
    const finishEdit = async (save: boolean) => {
      if (finished || !titleDiv.contains(input)) return;
      finished = true;
      popModEnterScope();
      const newText = input.value.trim();
      if (card.querySelector("details")) {
        titleDiv.onclick = function () {
          (this as HTMLElement).closest(".kanban-card")
            ?.querySelector("details")
            ?.toggleAttribute("open");
        };
      }
      if (save && !newText) {
        // Clearing a card's title asks whether to mark it #deleted (then
        // archive it, like a normal Archive click but leaving the checkbox
        // unticked and never re-arming a recurring card) or remove it
        // outright — unless it has subtasks, in which case removing it
        // outright would silently discard all of them, so it's always just
        // marked deleted.
        let subs: any[] = [];
        try { subs = JSON.parse(card.dataset.subs || "[]"); } catch { /* ignore malformed subs */ }
        const lastLine = parseInt(card.dataset.lastSubLine || `${lineNum}`, 10);
        const changed = await deleteCardOrSubtask(
          app, filePath, lineNum, lastLine, config,
          true, subs.length > 0, subs, card.dataset.isPromoted === "true"
        );
        if (changed) requestAnimationFrame(() => setTimeout(refresh, 50));
        else titleDiv.innerHTML = savedHTML;
      } else if (save && newText !== raw) {
        card.dataset.raw = newText;
        await editCardText(app, filePath, lineNum, newText);
        requestAnimationFrame(() => setTimeout(refresh, 50));
      } else {
        titleDiv.innerHTML = savedHTML;
      }
    };

    input.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        await finishEdit(true);
      }
      if (e.key === "Escape") {
        // Not stopping propagation here would let the keydown bubble past the
        // card/column/board out to Obsidian's own workspace handling — which
        // is exactly what caused Escape to switch to a neighboring tab.
        e.stopPropagation();
        await finishEdit(false);
      }
    });
    input.addEventListener("input", autoResize);
    input.addEventListener("blur", () => finishEdit(true));
    input.addEventListener("dblclick", (e) => e.stopPropagation());
    requestAnimationFrame(() => requestAnimationFrame(() => {
      autoResize();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }));
  }

  // ── Inline subtask text editing ──
  async function onSubDblClick(e: MouseEvent) {
    if ((e.target as Element).closest("a,button,.promote-icon,.demote-btn,.kb-date-label,.kb-trigger-label,.kb-sub-check")) return;
    const subRow = (e.target as Element).closest(".kb-sub-row") as HTMLElement | null;
    if (!subRow) return;
    const card = subRow.closest(".kanban-card") as HTMLElement | null;
    if (!card) return;
    if (subRow.querySelector(".card-edit-input")) return;

    const raw = subRow.dataset.subRaw || "";
    const filePath = card.dataset.file!;
    const lineNum = parseInt(subRow.dataset.subLine!, 10);
    if (isNaN(lineNum)) return;

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

    // See the matching guard in startTitleEdit's finishEdit: refresh() detaches
    // this still-focused input, which fires another "blur" and would otherwise
    // re-enter here a second time.
    const popModEnterScope = withNewlineOnModEnter(app, input, autoResize);
    let finished = false;
    const finishEdit = async (save: boolean) => {
      if (finished || !subRow.contains(input)) return;
      finished = true;
      popModEnterScope();
      const newText = input.value.trim();
      if (save && !newText) {
        // Clearing a subtask's text asks whether to mark it #deleted (it then
        // stays out of the board's rendering and counts, riding along
        // normally whenever its parent card is next archived) or remove it
        // outright, along with anything nested under it — unless a later
        // sibling's dependency reaches back to this one, in which case only
        // marking it deleted is offered (see deleteCardOrSubtask).
        const lastLine = parseInt(subRow.dataset.subLastLine || `${lineNum}`, 10);
        let hasDependents = false;
        try {
          const cardSubs = JSON.parse(card.dataset.subs || "[]");
          const siblingArr = findSiblingArrayContaining(cardSubs, lineNum);
          if (siblingArr) {
            const idx = siblingArr.findIndex((s: any) => s.line === lineNum);
            hasDependents = idx >= 0 && isDependedOn(siblingArr[idx], siblingArr, idx);
          }
        } catch { /* ignore malformed subs */ }
        const changed = await deleteCardOrSubtask(
          app, filePath, lineNum, lastLine, config,
          false, false, [], false, hasDependents
        );
        if (changed) requestAnimationFrame(() => setTimeout(refresh, 50));
        else subRow.innerHTML = savedHTML;
      } else if (save && newText !== raw) {
        subRow.dataset.subRaw = newText;
        await editCardText(app, filePath, lineNum, newText);
        requestAnimationFrame(() => setTimeout(refresh, 50));
      } else {
        subRow.innerHTML = savedHTML;
      }
    };

    input.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        await finishEdit(true);
      }
      if (e.key === "Escape") {
        // Not stopping propagation here would let the keydown bubble past the
        // card/column/board out to Obsidian's own workspace handling — which
        // is exactly what caused Escape to switch to a neighboring tab.
        e.stopPropagation();
        await finishEdit(false);
      }
    });
    input.addEventListener("input", autoResize);
    input.addEventListener("blur", () => finishEdit(true));
    input.addEventListener("dblclick", (e) => e.stopPropagation());
    requestAnimationFrame(() => requestAnimationFrame(() => {
      autoResize();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }));
  }

  // ── Details toggle → remember the last card opened by hand ──
  // No file write and no other bookkeeping — just enough for
  // expireLastExpandedIfStale to re-open this same card if the user comes
  // back to the board within a few minutes of navigating away from it.
  function onToggle(e: Event) {
    const details = e.target as HTMLDetailsElement;
    if (details.tagName !== "DETAILS") return;
    const card = details.closest(".kanban-card") as HTMLElement | null;
    if (!card) return;
    const key = forceExpandKey(card.dataset.file!, parseInt(card.dataset.line!, 10));
    if (details.open) {
      currentlyExpandedKey = key;
    } else if (currentlyExpandedKey === key) {
      currentlyExpandedKey = null;
    }
  }

  // ── Touch interaction ──
  let touchCard: HTMLElement | null = null;
  let ghost: HTMLElement | null = null;
  let isTouchDrag = false;
  let touchTimer: ReturnType<typeof setTimeout> | null = null;
  let selectedCard: HTMLElement | null = null;
  let colPickerOverlay: HTMLElement | null = null;
  const DRAG_DELAY = 450,
    MOVE_THRESHOLD = 8;
  let touchStartX = 0,
    touchStartY = 0;
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panScrollStart = 0;
  let panScrollTopStart = 0;

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

  const showCardMenu = (card: HTMLElement) => {
    closeColPicker();
    const savedCard = cardDataFrom(card)!;
    selectedCard = card;
    card.style.outline = "2px solid var(--kb-accent)";
    card.style.transform = "scale(1.02)";

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

    const editBtn = doc.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.style.cssText =
      "margin-top:12px;padding:14px;border-radius:10px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);width:100%;cursor:pointer;font-size:1em;font-weight:500;";
    editBtn.addEventListener("click", () => {
      closeColPicker();
      clearSelection();
      touchCard = null;
      startTitleEdit(card);
    });
    sheet.appendChild(editBtn);

    const bottomRow = doc.createElement("div");
    bottomRow.style.cssText = "display:flex;gap:8px;margin-top:8px;";
    sheet.appendChild(bottomRow);

    const colorBtn = doc.createElement("button");
    colorBtn.textContent = "Color";
    colorBtn.style.cssText =
      "flex:1;padding:14px;border-radius:10px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);cursor:pointer;font-size:1em;font-weight:500;";
    colorBtn.addEventListener("click", () => {
      closeColPicker();
      clearSelection();
      touchCard = null;
      openCardColorDialog(card);
    });
    bottomRow.appendChild(colorBtn);

    const deleteBtn = doc.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.style.cssText =
      "flex:1;padding:14px;border-radius:10px;border:none;background:var(--text-error, #e03e3e);color:#fff;cursor:pointer;font-size:1em;font-weight:500;";
    deleteBtn.addEventListener("click", async () => {
      closeColPicker();
      clearSelection();
      touchCard = null;
      const confirmed = await showConfirmDialog(app, "Delete this card?");
      if (!confirmed) return;
      const filePath = card.dataset.file!;
      const lineNum = parseInt(card.dataset.line!, 10);
      const lastLine = parseInt(card.dataset.lastSubLine || `${lineNum}`, 10);
      await deleteLineRange(app, filePath, lineNum, lastLine);
      requestAnimationFrame(() => setTimeout(refresh, 50));
    });
    bottomRow.appendChild(deleteBtn);

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
    // ".card-title span" would grab whichever span comes first in the title —
    // a date or recurrence-trigger badge (also plain <span>s) if the card's
    // text has one, clobbering that label instead of flipping the arrow.
    const arrow = el.querySelector<HTMLElement>(".kb-expand-arrow");
    if (arrow) arrow.textContent = "▼";
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

    if (!card) {
      if (isNarrowNow()) return; // let the browser handle native vertical scroll
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
    const defaultDocName = computeDefaultDocName(config.newTaskInsert, tag, config);

    if (norm === config.normLater) {
      const defDate = getDefaultDate().toISOString().split("T")[0];
      showDateDialog(title, defDate, app, async (dateStr, text, notes, docName, uncounted) => {
        if (text && await addNewItem(app, tag, text, dateStr, config, notes, docName, defaultDocName, uncounted))
          requestAnimationFrame(() => setTimeout(refresh, 50));
      }, { withText: true, defaultDocName });
    } else if (config.normRecurrent && norm === config.normRecurrent) {
      showInputDialog(title, app, defaultDocName, (text: string, notes: string, docName: string, uncounted: boolean) => {
        showRecurrentTriggerDialog(app, async (triggerStr) => {
          const n = new Date();
          const skipStr = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
          // "No trigger" stays a plain container (no "@recurrent") — see
          // applyRecurrentTrigger for why; skip-dated today either way so a
          // brand-new empty container isn't immediately swept into Due.
          const recurrentPart = triggerStr ? ` @${config.normRecurrent} ${triggerStr}` : '';
          const annotated = `${text}${recurrentPart} %% @skip:${skipStr} %%`;
          if (await addNewItem(app, tag, annotated, null, config, notes, docName, defaultDocName, uncounted))
            requestAnimationFrame(() => setTimeout(refresh, 50));
        });
      });
    } else {
      showInputDialog(title, app, defaultDocName, async (text: string, notes: string, docName: string, uncounted: boolean) => {
        if (await addNewItem(app, tag, text, null, config, notes, docName, defaultDocName, uncounted))
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
    let opened = 0;
    for (const card of cards) {
      let subs: any[] = [];
      try { subs = JSON.parse(card.dataset.subs || "[]"); } catch { /* ignore malformed subs */ }

      // A card with open (unchecked) subtasks shouldn't be archived silently —
      // expand it instead so the open work is visible. Once the user has
      // already opened it (acknowledging the open subtasks), archive anyway.
      // The force-expand is a session-only flag so it survives the refresh
      // between this click and the next one, without writing to the file —
      // see pendingForceExpand.
      const alreadyOpen = card.querySelector("details")?.open === true;
      const lineNum = parseInt(card.dataset.line!, 10);
      if (hasUnchecked(subs) && !alreadyOpen) {
        pendingForceExpand.add(forceExpandKey(card.dataset.file!, lineNum));
        card.querySelector("details")?.setAttribute("open", "");
        opened++;
        continue;
      }

      const archiveKey = forceExpandKey(card.dataset.file!, lineNum);
      pendingForceExpand.delete(archiveKey);
      if (currentlyExpandedKey === archiveKey) currentlyExpandedKey = null;
      const ok = await archiveToSection(
        app,
        card.dataset.file!,
        lineNum,
        subs,
        config,
        card.dataset.isPromoted !== "true"
      );
      if (ok) count++;
    }
    if (count || opened) {
      const parts: string[] = [];
      if (count) parts.push(`Archived ${count} item${count === 1 ? "" : "s"}.`);
      if (opened) parts.push(`Opened ${opened} card${opened === 1 ? "" : "s"} with open subtasks.`);
      new Notice(parts.join(" "));
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
  boardEl.addEventListener("click", onParentLinkClick);
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
  boardEl.addEventListener("touchstart", onTouchStart as unknown as EventListener, { passive: true });
  boardEl.addEventListener("touchmove", onTouchMove as unknown as EventListener, { passive: false });
  boardEl.addEventListener("touchend", onTouchEnd as unknown as EventListener, { passive: false });
  boardEl.addEventListener("touchcancel", clearTouch, { passive: true });

  return () => {
    if (familyIsolateTimer) clearTimeout(familyIsolateTimer);
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
    boardEl.removeEventListener("click", onParentLinkClick);
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
    boardEl.removeEventListener("touchstart", onTouchStart as unknown as EventListener);
    boardEl.removeEventListener("touchmove", onTouchMove as unknown as EventListener);
    boardEl.removeEventListener("touchend", onTouchEnd as unknown as EventListener);
    boardEl.removeEventListener("touchcancel", clearTouch);
    searchInputEl?.removeEventListener("input", onSearchInput);
    searchClearEl?.removeEventListener("click", onSearchClear);
  };
}
