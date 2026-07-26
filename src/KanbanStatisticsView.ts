import { App, ItemView, TFile, WorkspaceLeaf } from "obsidian";
import KanbanPlugin from "./main";
import {
  buildColorCSS,
  buildConfig,
  collectItems,
  formatInlineEmphasis,
  getTargetFilePaths,
  KanbanConfig,
  linksToHtml,
  moveCheckedCardsToDone,
  normalizeTag,
  stampMissingCreatedDates,
  validateConfig,
} from "./kanban";

export const VIEW_TYPE_KANBAN_STATS = "kanban-statistics-view";

type TrendRangeMode = "last7" | "sinceSaturday" | "last30" | "last12weeks" | "thisYear" | "last12months";
type StatsTab = "open" | "done";

const WEEKDAYS_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Bucket {
  label: string;
  start: Date;
  endExclusive: Date;
}

// One level of a hover list item's ancestor chain — its title (for context)
// and its own checked/done state (shown as a checkbox glyph on its header
// line, so it's visible whether that ancestor itself is done without having
// to separately look it up).
interface HoverParent {
  title: string;
  checked: boolean;
}

interface EventDates {
  createdDate: Date | null;
  doneDate: Date | null;
  title: string;
  // Has its own kanban column tag — a top-level card, or a subtask "spun
  // out" into its own column — as opposed to a plain checkbox subtask with
  // no column of its own. Drives which items are worth listing individually
  // in the Done/Deleted hover (a plain subtask being ticked off isn't an
  // independently interesting event, even though it's still counted), and,
  // for Newly opened, which checked-off items are stale noise.
  isOwnCard: boolean;
  checked: boolean;
  // Every ancestor from the top-level card down to (not including) this
  // node itself, root first — empty for a top-level card. Shown alongside a
  // subtask in the hover list so it isn't meaningless out of context; the
  // full chain (not just the immediate parent) is what lets a deeply nested
  // completion still be traced back to which top-level card it belongs to,
  // even when a name like "child" repeats across several different cards.
  ancestors: HoverParent[];
  // Its own tags include Later/Recurrent/#MaybeSomeday — excluded from
  // "New this week" (tile, chart, and hover) regardless of isOwnCard.
  excludedFromNew: boolean;
}

// A node in the open-task tree shown (collapsed by default) under a card row
// in the "Oldest open tasks" table — either the card itself or one of its
// (possibly several levels deep) checkbox subtasks. Mirrors DoneNode's shape
// below, for the analogous "Done this week" tab.
interface TaskNode {
  filePath: string;
  line: number;
  checked: boolean;
  column: string; // which kanban column(s) this node itself belongs to, "" if none (a plain, non-promoted subtask)
  createdDate: Date | null;
  doneDate: Date | null;
  displayHtml: string;
  children: TaskNode[];
}

interface OpenCardRow extends TaskNode {
  tags: string[];
  subCount: number;
  openSubCount: number;
  // createdDate, unless some subtask (at any depth) has been completed more
  // recently — in which case that completion is what the row's displayed/
  // sorted "Age" actually measures from. A card whose subtasks keep getting
  // checked off is being actively worked, however old the card itself is, so
  // its age here reflects "time since last progress," not "time since
  // creation." Falls back to createdDate when no subtask has a done date.
  ageDate: Date | null;
}

// A node in the completed-task tree shown on the "Done this week" tab —
// either a top-level card or one of its (possibly several levels deep)
// subtasks. Once a card qualifies to appear (it or some descendant matched
// within range), its full subtask tree is included — completed and still-
// open alike — so the card's actual progress is visible, not just the path
// down to what was completed. Unmatched nodes (matched=false) render with no
// day and an unchecked box.
interface DoneNode {
  filePath: string;
  line: number;
  depth: number;
  matched: boolean;
  date: Date | null;
  displayHtml: string;
  children: DoneNode[];
}

interface DoneGroup {
  root: DoneNode;
  maxDate: number;
}

// Live DOM/state handle for a rendered row (both tabs' tables), used to
// drive nested collapse — see applyVisibility in render().
interface RenderedRow {
  row: HTMLTableRowElement;
  children: RenderedRow[];
  expanded: boolean;
}

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function getLast7DaysStart(): Date {
  const d = startOfToday();
  d.setDate(d.getDate() - 6);
  return d;
}

// Always at least a full week: starts from the Saturday before the most
// recent Saturday, so checking mid-week still shows a complete prior week of
// context (8-14 days back). On Saturday itself, the most recent Saturday IS
// today, so this collapses to exactly one week back rather than reaching an
// extra week beyond that. Shared by the range toggle and the Done tab.
function getSinceSaturdayStart(): Date {
  const d = startOfToday();
  const daysSinceLastSaturday = (d.getDay() + 1) % 7; // Sat=6 -> 0, Sun=0 -> 1, Mon=1 -> 2, ...
  d.setDate(d.getDate() - daysSinceLastSaturday - 7);
  return d;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// Weekday word for a daily bucket/row in the two short, rolling ranges
// (Last 7 days / Since Saturday) — abbreviated (Sun/Mon/...) so every bucket
// can carry a label along the chart's x-axis without crowding. "Today"/
// "Yesterday" override the weekday name for those two days specifically,
// since Since Saturday's range (8-14 days) is long enough that a weekday
// name alone can refer to either of two different dates.
function dayLabel(d: Date, today: Date): string {
  const diffDays = Math.round((today.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return WEEKDAYS_ABBR[d.getDay()];
}

// The three longer ranges are bucketed weekly and read as a line chart — a
// trend across that many points is the point. The three short ranges are
// bucketed daily and read as a bar chart instead — day-level counts are
// small, discrete numbers a bar reads better than a line for.
function isLongRangeMode(mode: TrendRangeMode): boolean {
  return mode === "last12weeks" || mode === "thisYear" || mode === "last12months";
}

// Saturday-anchored weekly buckets (matching getSinceSaturdayStart's own
// definition of "week") from whichever week rangeStart falls in, through
// today. The most recent bucket always ends "today" (inclusive,
// in-progress), capped via min() rather than index-based special-casing so
// any range length works the same way.
function buildWeeklyBuckets(rangeStart: Date, today: Date): Bucket[] {
  const daysSinceSat = (rangeStart.getDay() + 1) % 7; // Sat=6 -> 0, Sun=0 -> 1, ...
  const cap = addDays(today, 1);
  const buckets: Bucket[] = [];
  for (let start = addDays(rangeStart, -daysSinceSat); start.getTime() <= today.getTime(); start = addDays(start, 7)) {
    const naturalEnd = addDays(start, 7);
    const endExclusive = naturalEnd.getTime() < cap.getTime() ? naturalEnd : cap;
    buckets.push({ start, endExclusive, label: `${start.getMonth() + 1}/${start.getDate()}` });
  }
  return buckets;
}

// Daily buckets from a range start through today (rolling 7 days, since-
// Saturday, or a fixed last 30) — the most recent bucket always ends "today"
// (inclusive, in-progress), not at a fixed period boundary, so the chart
// never lags behind what's actually true today.
function buildBuckets(mode: TrendRangeMode): Bucket[] {
  const today = startOfToday();

  if (isLongRangeMode(mode)) {
    let rangeStart: Date;
    if (mode === "last12weeks") {
      const daysSinceSat = (today.getDay() + 1) % 7; // Sat=6 -> 0, Sun=0 -> 1, ...
      rangeStart = addDays(today, -daysSinceSat - 7 * 11);
    } else if (mode === "thisYear") {
      rangeStart = new Date(today.getFullYear(), 0, 1);
    } else {
      rangeStart = new Date(today.getFullYear(), today.getMonth() - 12, today.getDate());
    }
    return buildWeeklyBuckets(rangeStart, today);
  }

  const buckets: Bucket[] = [];
  const rangeStart =
    mode === "last7" ? getLast7DaysStart() : mode === "sinceSaturday" ? getSinceSaturdayStart() : addDays(today, -29);
  const useWeekdayLabel = mode === "last7" || mode === "sinceSaturday";
  for (let start = rangeStart; start.getTime() <= today.getTime(); start = addDays(start, 1)) {
    const label = useWeekdayLabel ? dayLabel(start, today) : `${start.getMonth() + 1}/${start.getDate()}`;
    buckets.push({ start, endExclusive: addDays(start, 1), label });
  }
  return buckets;
}

function countInBucket(dates: (Date | null)[], bucket: Bucket): number {
  return dates.filter((d) => d && d.getTime() >= bucket.start.getTime() && d.getTime() < bucket.endExclusive.getTime()).length;
}

// Same bucket filter as countInBucket, but returning the matching entries'
// titles instead of just a count — feeds the bar charts' hover tooltip so it
// can list which tasks/subtasks actually make up that day's number.
function entriesInBucket<T>(entries: T[], bucket: Bucket, getDate: (entry: T) => Date): T[] {
  return entries.filter((e) => {
    const d = getDate(e).getTime();
    return d >= bucket.start.getTime() && d < bucket.endExclusive.getTime();
  });
}

// Formats a bucket's hover items in order as a tree: a subtask's title is
// meaningless out of context, so its FULL ancestor chain — root card down to
// its immediate parent, not just the immediate parent alone — is listed
// above it, one ancestor per indent level, each on its own line. Consecutive
// entries collapse their shared leading path (an already-shown ancestor
// isn't repeated) and re-show only the levels where the path actually
// diverges — so a run of items under one card reads as a group, but a
// deeply nested completion is still traceable back to which top-level card
// it belongs to, even when an intermediate name like "child" repeats across
// several different cards. The comparison is against the PREVIOUS entry's
// full path INCLUDING its own leaf (not just its ancestors) — otherwise a
// card that's independently done (its own leaf line) and also happens to be
// the very next entry's parent would get shown twice in a row: once as its
// own leaf, once again as that entry's ancestor header. The indent is
// non-breaking spaces, not plain ones (which HTML would collapse to
// nothing).
function formatHoverList(entries: { title: string; checked: boolean; ancestors: HoverParent[] }[]): string[] {
  const INDENT = "\u00A0\u00A0\u00A0\u00A0";
  const CHECKED_BOX = "\u2611"; // checked ballot box
  const UNCHECKED_BOX = "\u2610"; // empty ballot box
  const box = (checked: boolean) => (checked ? CHECKED_BOX : UNCHECKED_BOX);
  const lines: string[] = [];
  let prevPath: HoverParent[] = [];
  for (const e of entries) {
    const title = e.title || "(untitled)";
    let common = 0;
    while (
      common < prevPath.length &&
      common < e.ancestors.length &&
      prevPath[common].title === e.ancestors[common].title
    ) {
      common++;
    }
    for (let level = common; level < e.ancestors.length; level++) {
      const a = e.ancestors[level];
      lines.push(`${INDENT.repeat(level)}${box(a.checked)} ${a.title}`);
    }
    lines.push(`${INDENT.repeat(e.ancestors.length)}${box(e.checked)} ${title}`);
    prevPath = [...e.ancestors, { title, checked: e.checked }];
  }
  return lines;
}

// ─── TEXT MINING (%% ... %% / ✅ stamps are mined directly off the raw
// node.text, rather than round-tripping through kanban.ts's internal
// TaskLine parser) ───────────────────────────────────────────────────────

function extractCreatedDate(text: string): Date | null {
  const m = (text ?? "").match(/%% @created:(\d{4}-\d{2}-\d{2}) %%/);
  if (!m) return null;
  const d = new Date(m[1] + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}

function extractDoneDate(text: string): Date | null {
  const m = (text ?? "").match(/✅(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const d = new Date(m[1] + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}

function isDeletedNode(node: any): boolean {
  return (node.tags ?? []).some((t: string) => normalizeTag(t) === "deleted");
}

function isCheckboxItemText(text: string): boolean {
  return /^[-*+]\s+\[[ xX]\]/.test((text ?? "").trim());
}

function isCheckedItemText(text: string): boolean {
  return /^[-*+]\s+\[[xX]\]/.test((text ?? "").trim());
}

// "#MaybeSomeday" -> "Maybesomeday", "#due" -> "Due" — same title-casing
// KanbanView's doMove already uses for a column's display name.
function columnLabel(tag: string): string {
  return tag.replace(/^#/, "").replace(/\b\w/g, (l: string) => l.toUpperCase());
}

// A node's own current column(s), by matching its tags against the
// configured kanban column list — "" for a plain (non-promoted) subtask,
// which has no independent column membership of its own. A multi-tagged
// card shows every matching column, comma-separated.
function nodeColumnLabel(tags: string[], config: KanbanConfig): string {
  const norms = new Set(tags.map(normalizeTag));
  return config.kanban
    .filter((t) => norms.has(normalizeTag(t)))
    .map(columnLabel)
    .join(", ");
}

// Shared by both tabs' row rendering: strips structural %% %% comments
// (order/skip/color/created/deleted — all share the same generic %%...%%
// shape), the ✅ done-date stamp, the leading bullet/checkbox marker, and
// every inline #tag/@annotation — internal plumbing that isn't meaningful in
// a plain task list.
function cleanTaskText(raw: string): string {
  let text = raw
    .replace(/\s*%%[\s\S]*?%%\s*/g, " ")
    .replace(/\s*✅\d{4}-\d{2}-\d{2}/, "")
    .trim()
    .replace(/^- \[[ xX]\] /, "")
    .replace(/^[-*+]\s+/, "")
    .trim();
  text = text
    .replace(/(?<!\w)#\w+/g, "")
    .replace(/(?<!\S)@\S+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return text;
}

// Walks every card's full tree (cards + subtasks, #deleted nodes excluded —
// the same exclusion every date-based stat on this page applies) to build
// the flat "creation"/"completion" event list the trend chart and "new/done
// this week" tiles are computed from, plus the list of currently open
// (not-done) top-level cards the tile group + table use.
function collectOpenAndEvents(
  items: any[],
  config: KanbanConfig,
  vaultName: string
): { events: EventDates[]; openCards: OpenCardRow[] } {
  const events: EventDates[] = [];

  // "New this week" excludes creation events for anything tagged into one
  // of these three columns — a #recurrent card cycles by design, and
  // #later/"maybe someday" cards are deliberately parked, so their creation
  // isn't "new work" in the sense that tile/chart is for.
  const NEW_EXCLUDED_TAGS = new Set([config.normLater, config.normRecurrent, "maybesomeday"]);

  const visitForEvents = (node: any, ancestors: HoverParent[]) => {
    if (isDeletedNode(node)) return;
    const norms = (node.tags ?? []).map(normalizeTag);
    const title = cleanTaskText(node.text);
    const checked = isCheckedItemText(node.text);
    events.push({
      createdDate: extractCreatedDate(node.text),
      doneDate: extractDoneDate(node.text),
      title,
      isOwnCard: norms.some((t: string) => config.normKanban.includes(t)),
      checked,
      ancestors,
      excludedFromNew: norms.some((t: string) => NEW_EXCLUDED_TAGS.has(t)),
    });
    for (const sub of node.subs ?? []) visitForEvents(sub, [...ancestors, { title, checked }]);
  };

  const countSubs = (subs: any[]): { total: number; open: number } => {
    let total = 0;
    let open = 0;
    for (const s of subs ?? []) {
      if (isDeletedNode(s)) continue;
      if (isCheckboxItemText(s.text)) {
        total++;
        if (!isCheckedItemText(s.text)) open++;
      }
      const nested = countSubs(s.subs);
      total += nested.total;
      open += nested.open;
    }
    return { total, open };
  };

  // Builds the expandable subtree for a card's row in the "Oldest open tasks"
  // table — same total/open scope as countSubs above (only real checkbox
  // items become a node; a plain note bullet is skipped but still recursed
  // into, so a checkbox nested a level below one isn't lost).
  const buildTaskChildren = (filePath: string, subs: any[]): TaskNode[] => {
    const result: TaskNode[] = [];
    for (const s of subs ?? []) {
      if (isDeletedNode(s)) continue;
      if (isCheckboxItemText(s.text)) {
        result.push({
          filePath,
          line: s.line,
          checked: isCheckedItemText(s.text),
          column: nodeColumnLabel(s.tags ?? [], config),
          createdDate: extractCreatedDate(s.text),
          doneDate: extractDoneDate(s.text),
          displayHtml: formatInlineEmphasis(linksToHtml(cleanTaskText(s.text), vaultName)),
          children: buildTaskChildren(filePath, s.subs),
        });
      } else {
        result.push(...buildTaskChildren(filePath, s.subs));
      }
    }
    return result;
  };

  // The most recent doneDate among a card's subtasks, at any depth — see
  // OpenCardRow.ageDate for why. null when no subtask (or nested subtask)
  // has one.
  const maxSubtaskDoneDate = (nodes: TaskNode[]): Date | null => {
    let max: Date | null = null;
    for (const n of nodes) {
      if (n.doneDate && (!max || n.doneDate.getTime() > max.getTime())) max = n.doneDate;
      const childMax = maxSubtaskDoneDate(n.children);
      if (childMax && (!max || childMax.getTime() > max.getTime())) max = childMax;
    }
    return max;
  };

  // A "promoted" subtask (one that carries its own kanban tag, e.g. a
  // #recurrent or #later item written as a sub-item under a parent card)
  // shows up both as its own top-level entry in `items` and nested inside its
  // true parent's .subs tree — same dedup trick collectDoneGroups below uses,
  // but ONLY needed for the events walk below: since visitForEvents recurses
  // into every node's .subs, a promoted subtask would otherwise get its
  // created/done events counted twice. It must NOT be applied to openCards —
  // unlike the Done tab's nested tree view, this table is flat, so skipping a
  // promoted card here doesn't mean "shown nested under its parent instead,"
  // it means the card silently vanishes. `items` itself never has
  // duplicates, so openCards is built from every top-level entry
  // unconditionally.
  const childKeys = new Set<string>();
  const collectChildKeys = (filePath: string, subs: any[]) => {
    for (const sub of subs || []) {
      childKeys.add(`${filePath}::${sub.line}`);
      if (sub.subs?.length) collectChildKeys(filePath, sub.subs);
    }
  };
  for (const card of items) collectChildKeys(card.filePath, card.item.subs);

  // "Open" excludes Done (obviously) as well as Recurrent (cycles by design,
  // not aging backlog), Later, and #MaybeSomeday (both deliberately parked,
  // not neglected) — a card sitting in any of these isn't "open work" in the
  // sense the Open tasks / Avg. age tiles and the Oldest open tasks table
  // are for.
  const OPEN_EXCLUDED_TAGS = new Set([config.normDone, config.normLater, config.normRecurrent, "maybesomeday"]);

  const openCards: OpenCardRow[] = [];
  for (const card of items) {
    if (!childKeys.has(`${card.filePath}::${card.item.line}`)) {
      visitForEvents(card.item, []);
    }
    const norms = card.item.tags.map(normalizeTag);
    if (!norms.some((t) => OPEN_EXCLUDED_TAGS.has(t))) {
      const subCounts = countSubs(card.item.subs);
      const createdDate = extractCreatedDate(card.item.text);
      const children = buildTaskChildren(card.filePath, card.item.subs);
      openCards.push({
        filePath: card.filePath,
        line: card.item.line,
        checked: false,
        column: nodeColumnLabel(card.item.tags, config),
        tags: card.item.tags,
        createdDate,
        doneDate: extractDoneDate(card.item.text),
        ageDate: maxSubtaskDoneDate(children) ?? createdDate,
        displayHtml: formatInlineEmphasis(linksToHtml(cleanTaskText(card.item.text), vaultName)),
        children,
        subCount: subCounts.total,
        openSubCount: subCounts.open,
      });
    }
  }

  return { events, openCards };
}

interface DeletedEvent {
  date: Date;
  title: string;
  isOwnCard: boolean;
  checked: boolean;
  ancestors: HoverParent[];
}

// Deletions can't be found via the card/subtask tree — markLineDeleted strips
// a card's own kanban tag when it's soft-deleted, so a deleted top-level card
// stops matching any kanban column at all and collectItems can no longer see
// it. The %% @deleted:... %% stamp itself is proof of provenance (only ever
// written by markLineDeleted), so a flat per-line scan across the same target
// files is the only — and a perfectly safe — way to recover deletion dates.
// The title comes along too (cleaned the same way as any other row) so the
// "Newly opened / Done / Deleted" charts' hover tooltip can list what was
// actually deleted, not just a count.
//
// isOwnCard/ancestors are reconstructed from raw indentation rather than
// tags, since markLineDeleted already stripped the very kanban tag that
// would otherwise mark this line as "its own card" — indentation is the
// only evidence left. A line at the outline's root (no leading whitespace)
// is treated as its own card; anything indented under it is treated as a
// plain subtask of whatever outline path precedes it (the running `stack`
// below), whether or not any of those ancestors actually carried their own
// column tag before deletion. Each ancestor's checked state comes along the
// same way, from that same preceding line.
async function collectDeletedEvents(app: App, paths: string[]): Promise<DeletedEvent[]> {
  const results: DeletedEvent[] = [];
  const RE = /%% @deleted:(\d{4}-\d{2}-\d{2}) %%/;
  for (const filePath of paths) {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) continue;
    let raw: string;
    try {
      raw = await app.vault.cachedRead(file);
    } catch {
      continue;
    }
    const stack: { indent: number; title: string; checked: boolean }[] = [];
    for (const rawLine of raw.split("\n")) {
      // A deleted card is archived into a blockquoted "> " callout
      // (see archiveToSection), which would otherwise make its bullet
      // unrecognizable here and silently drop it from this scan.
      const line = rawLine.replace(/^(?:>\s?)+/, "");
      const bulletMatch = line.match(/^(\s*)[-*+]\s/);
      if (!bulletMatch) continue;
      const indent = bulletMatch[1].length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const m = line.match(RE);
      if (m) {
        const d = new Date(m[1] + "T00:00:00");
        if (!isNaN(d.getTime())) {
          results.push({
            date: d,
            title: cleanTaskText(line),
            isOwnCard: indent === 0,
            checked: isCheckedItemText(line),
            ancestors: stack.map((a) => ({ title: a.title, checked: a.checked })),
          });
        }
      }
      stack.push({ indent, title: cleanTaskText(line), checked: isCheckedItemText(line) });
    }
  }
  return results;
}

// Builds the "Done this week" tab's card/subtask groups from the already-
// collected `items` tree (same data collectOpenAndEvents works from) — no
// separate vault fetch needed now that both tabs live in one view. A card
// qualifies (and its full subtask tree — completed and still-open alike —
// is shown) whenever it or some descendant's ✅ done-date stamp falls within
// [rangeStart, rangeEnd]; a #deleted node is dropped, subtree and all.
function collectDoneGroups(
  items: any[],
  vaultName: string,
  rangeStart: Date,
  rangeEnd: Date
): DoneGroup[] {
  const inRange = (d: Date) => d.getTime() >= rangeStart.getTime() && d.getTime() <= rangeEnd.getTime();

  const matchDate = (node: { text: string; tags: string[] }): Date | null => {
    if ((node.tags ?? []).some((t: string) => normalizeTag(t) === "deleted")) return null;
    const m = (node.text ?? "").match(/✅(\d{4}-\d{2}-\d{2})/);
    if (!m) return null;
    const date = new Date(m[1] + "T00:00:00");
    if (isNaN(date.getTime()) || !inRange(date)) return null;
    return date;
  };

  // Same "promoted subtask" dedup as collectOpenAndEvents, but for this
  // tab's own purpose: a subtask carrying its own kanban tag is rendered
  // once, nested under its true parent, instead of also becoming a
  // duplicate standalone group.
  const childKeys = new Set<string>();
  const collectChildKeys = (filePath: string, subs: any[]) => {
    for (const sub of subs || []) {
      childKeys.add(`${filePath}::${sub.line}`);
      if (sub.subs?.length) collectChildKeys(filePath, sub.subs);
    }
  };
  for (const card of items) collectChildKeys(card.filePath, card.item.subs);

  const buildNode = (filePath: string, node: any): DoneNode => {
    const date = matchDate(node);
    const children: DoneNode[] = (node.subs || [])
      .filter((sub: any) => !(sub.tags ?? []).some((t: string) => normalizeTag(t) === "deleted"))
      .map((sub: any) => buildNode(filePath, sub));

    return {
      filePath,
      line: node.line,
      depth: node.hierarchy_level ?? 0,
      matched: !!date,
      date,
      displayHtml: formatInlineEmphasis(linksToHtml(cleanTaskText(node.text), vaultName)),
      children,
    };
  };

  const maxDateOf = (node: DoneNode): number => {
    let max = node.date ? node.date.getTime() : -Infinity;
    for (const c of node.children) max = Math.max(max, maxDateOf(c));
    return max;
  };

  const containsMatch = (node: DoneNode): boolean => node.matched || node.children.some(containsMatch);

  const groups: DoneGroup[] = [];
  for (const card of items) {
    const key = `${card.filePath}::${card.item.line}`;
    if (childKeys.has(key)) continue;
    if ((card.item.tags ?? []).some((t: string) => normalizeTag(t) === "deleted")) continue;
    const root = buildNode(card.filePath, card.item);
    if (!containsMatch(root)) continue;
    groups.push({ root, maxDate: maxDateOf(root) });
  }

  groups.sort((a, b) => b.maxDate - a.maxDate);
  return groups;
}

// ─── SVG LINE CHART ───────────────────────────────────────────────────────────

function svgEl<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Record<string, string | number> = {}
): SVGElementTagNameMap[K] {
  const el = doc.createElementNS("http://www.w3.org/2000/svg", tag) as SVGElementTagNameMap[K];
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// A soft grey band behind a Saturday or Sunday slot, drawn first so every
// later mark (gridlines, bars, zero axis) sits on top of it. Only meaningful
// where one bucket == one calendar day — renderBarChart/renderStackedBarChart
// (the three short, daily-bucketed ranges), never renderLineChart's weekly
// buckets, where a single bucket spans a whole week rather than one day.
function drawWeekendBands(
  doc: Document,
  svg: SVGSVGElement,
  buckets: Bucket[],
  slotX: (i: number) => number,
  slotW: number,
  plotTop: number,
  plotBottom: number
): void {
  for (let i = 0; i < buckets.length; i++) {
    const day = buckets[i].start.getDay();
    if (day !== 0 && day !== 6) continue;
    const band = svgEl(doc, "rect", { x: slotX(i), y: plotTop, width: slotW, height: plotBottom - plotTop });
    band.style.setProperty("fill", "var(--background-modifier-border)");
    band.style.opacity = "0.35";
    svg.appendChild(band);
  }
}

interface ChartSeries {
  name: string;
  color: string;
  values: number[];
  // Per-bucket list of display lines behind that bucket's value — optional,
  // consumed only by the bar-chart tooltips (renderBarChart/
  // renderStackedBarChart) to list the actual tasks/subtasks on hover. A
  // parent header counts as an extra line but isn't itself a counted item,
  // so `labels[i].length` is a line count, not an item count — see
  // labelCounts.
  labels?: string[][];
  // Per-bucket count of actual items behind labels[i] (pre-formatting, so a
  // synthetic parent-header line is never mistaken for a counted item). The
  // tooltip's bold number is this, not labels[i].length.
  labelCounts?: number[];
}

// A single series' row inside an open bar-chart tooltip: its color key,
// value, and name — followed by the full list of the actual task/subtask
// titles behind that number, when the series carries them (every one, not a
// truncated sample — the count above is redundant with the list otherwise).
function appendTooltipSeriesRow(tooltip: HTMLElement, s: ChartSeries, i: number): void {
  const row = tooltip.createDiv();
  row.style.cssText = "display:flex;align-items:center;gap:6px;";
  const key = row.createSpan();
  key.style.cssText = `width:10px;height:10px;border-radius:2px;background:${s.color};display:inline-block;flex:none;`;

  const titles = s.labels?.[i];
  // The bold number always matches the count of actual items behind the
  // list below it — labelCounts, never labels[i].length, since a synthetic
  // parent-header line inflates the line count without being a counted item
  // itself. For a series with no item list at all (e.g. Net change), it's
  // just the raw value. When some items are filtered out of the list (a
  // plain checkbox isn't its own trackable card, so it's counted in the bar
  // but not itemized), the true total is still shown alongside, so nothing
  // is silently hidden — the number just never contradicts what you can see.
  const shown = s.labelCounts ? s.labelCounts[i] : s.values[i];
  row.createSpan({ text: String(shown), attr: { style: "font-weight:600;" } });
  row.createSpan({ text: s.name, attr: { style: "opacity:.75;" } });
  if (s.labelCounts && shown !== s.values[i]) {
    row.createSpan({ text: `(${s.values[i]} total)`, attr: { style: "opacity:.55;font-size:.9em;" } });
  }

  if (titles && titles.length) {
    const list = tooltip.createDiv();
    list.style.cssText = "margin:2px 0 6px 16px;";
    for (const line of titles) {
      // One line per item — a long title truncates with an ellipsis rather
      // than wrapping, so a busy bucket's list stays scannable. The bullet
      // (and, for a subtask, its indent) is already baked into `line` by
      // formatHoverList — a bare parent-header line gets neither.
      list.createDiv({
        text: line,
        attr: { style: "max-width:550px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8;line-height:1.35;" },
      });
    }
  }
}

// A responsive (viewBox-scaled, preserveAspectRatio="none") line chart: 2px
// series lines, r=4 markers ringed in the surface color, hairline recessive
// gridlines, a legend row whenever there's more than one series (a single
// series needs no legend — the chart's own title already names it), and a
// shared crosshair + single tooltip listing every series' value at the
// pointer's nearest bucket (a single hit-rect spanning the plot, not
// per-point hit circles — simpler, and already bigger than the mark).
function renderLineChart(parent: HTMLElement, doc: Document, buckets: Bucket[], series: ChartSeries[], yMaxOverride?: number, zeroLineColor?: string): void {
  const VB_W = 760;
  const VB_H = 200;
  const PAD = { top: 12, right: 14, bottom: 24, left: 34 };
  const plotW = VB_W - PAD.left - PAD.right;
  const plotH = VB_H - PAD.top - PAD.bottom;
  const n = buckets.length;
  const xAt = (i: number) => (n > 1 ? PAD.left + (plotW * i) / (n - 1) : PAD.left + plotW / 2);

  let yMin = 0;
  // A shared yMaxOverride (passed when this chart is paired with another one
  // in the same row) keeps both charts' gridlines at the same scale, so the
  // two are directly comparable at a glance instead of each auto-scaling to
  // its own data and coincidentally lining up gridlines with different values.
  let yMax = yMaxOverride ?? 0;
  for (const s of series) for (const v of s.values) {
    if (v < yMin) yMin = v;
    if (yMaxOverride === undefined && v > yMax) yMax = v;
  }
  if (yMin === yMax) yMax = yMin + 1;
  const yRange = yMax - yMin;
  const yAt = (v: number) => PAD.top + plotH - ((v - yMin) / yRange) * plotH;

  const wrap = parent.createDiv();
  wrap.style.cssText = "position:relative;";

  // A single series needs no legend box (the chart's title already names
  // it) — but the row is still reserved, just hidden, so this chart's plot
  // starts at the same height as a paired chart that DOES have a multi-
  // series legend. Otherwise the two charts' y-axes drift out of alignment
  // despite sharing the same value scale (sharedMax above only aligns the
  // scale, not the vertical offset the legend row itself takes up).
  const legend = wrap.createDiv();
  legend.style.cssText = `display:flex;gap:16px;flex-wrap:wrap;margin-bottom:6px;font-size:.82em;${series.length > 1 ? "" : "visibility:hidden;"}`;
  for (const s of series) {
    const row = legend.createDiv();
    row.style.cssText = "display:flex;align-items:center;gap:6px;";
    const dot = row.createSpan();
    dot.style.cssText = `width:9px;height:9px;border-radius:50%;background:${s.color};display:inline-block;flex:none;`;
    row.createSpan({ text: s.name, attr: { style: "color:var(--kb-text);opacity:.85;" } });
  }

  const svg = svgEl(doc, "svg", {
    viewBox: `0 0 ${VB_W} ${VB_H}`,
    width: "100%",
    height: VB_H,
    preserveAspectRatio: "none",
  });
  svg.style.display = "block";
  wrap.appendChild(svg);

  // Gridlines + y-tick labels (3 evenly spaced ticks across the data range).
  const ticks = 3;
  for (let t = 0; t <= ticks; t++) {
    const v = yMin + (yRange * t) / ticks;
    const y = yAt(v);
    const line = svgEl(doc, "line", { x1: PAD.left, x2: VB_W - PAD.right, y1: y, y2: y, "stroke-width": "1" });
    line.style.setProperty("stroke", "var(--background-modifier-border)");
    svg.appendChild(line);
    const label = svgEl(doc, "text", { x: PAD.left - 6, y: y + 3, "text-anchor": "end", "font-size": "9" });
    label.style.setProperty("fill", "var(--kb-text)");
    label.style.opacity = "0.6";
    label.textContent = String(Math.round(v));
    svg.appendChild(label);
  }

  // A bolder zero axis, when zero actually falls strictly inside the data's
  // range (e.g. Net change, which can dip negative) rather than sitting at
  // one of the ticks above. An all-non-negative series (a plain count) never
  // triggers this — its zero is already the plot's own bottom edge.
  if (yMin < 0 && yMax > 0) {
    const zeroLine = svgEl(doc, "line", { x1: PAD.left, x2: VB_W - PAD.right, y1: yAt(0), y2: yAt(0), "stroke-width": "1.5" });
    zeroLine.style.setProperty("stroke", zeroLineColor ?? "var(--kb-text)");
    zeroLine.style.opacity = zeroLineColor ? "0.7" : "0.45";
    svg.appendChild(zeroLine);
  }

  // Sparse x-axis labels — never one per point (see dataviz mark spec).
  const stride = Math.max(1, Math.ceil(n / 6));
  const labelIndices = new Set<number>();
  for (let i = 0; i < n; i += stride) labelIndices.add(i);
  labelIndices.add(n - 1);
  for (const i of labelIndices) {
    const label = svgEl(doc, "text", { x: xAt(i), y: VB_H - 4, "text-anchor": "middle", "font-size": "9" });
    label.style.setProperty("fill", "var(--kb-text)");
    label.style.opacity = "0.6";
    label.textContent = buckets[i].label;
    svg.appendChild(label);
  }

  // Series lines + markers.
  for (const s of series) {
    const d = s.values.map((v, i) => `${i === 0 ? "M" : "L"} ${xAt(i)},${yAt(v)}`).join(" ");
    const path = svgEl(doc, "path", { d, fill: "none", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" });
    path.style.setProperty("stroke", s.color);
    svg.appendChild(path);
    s.values.forEach((v, i) => {
      const c = svgEl(doc, "circle", { cx: xAt(i), cy: yAt(v), r: "4", "stroke-width": "2" });
      c.style.setProperty("fill", s.color);
      c.style.setProperty("stroke", "var(--background-primary)");
      svg.appendChild(c);
    });
  }

  // Crosshair + hit-rect + HTML tooltip overlay.
  const crosshair = svgEl(doc, "line", { x1: 0, x2: 0, y1: PAD.top, y2: VB_H - PAD.bottom, "stroke-width": "1" });
  crosshair.style.setProperty("stroke", "var(--kb-text)");
  crosshair.style.opacity = "0.35";
  crosshair.style.display = "none";
  svg.appendChild(crosshair);

  const hit = svgEl(doc, "rect", { x: PAD.left, y: 0, width: plotW, height: VB_H, fill: "transparent" });
  svg.appendChild(hit);

  const tooltip = wrap.createDiv();
  tooltip.style.cssText =
    "position:absolute;pointer-events:none;background:var(--background-primary);border:1px solid var(--background-modifier-border);" +
    "border-radius:6px;padding:6px 9px;font-size:.8em;color:var(--kb-text);box-shadow:0 2px 6px rgba(0,0,0,.15);display:none;white-space:nowrap;z-index:5;";

  const move = (clientX: number) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const relX = ((clientX - rect.left) / rect.width) * VB_W;
    const stepX = n > 1 ? plotW / (n - 1) : plotW;
    let idx = Math.round((relX - PAD.left) / stepX);
    idx = Math.max(0, Math.min(n - 1, idx));

    const xPix = (xAt(idx) / VB_W) * rect.width;
    crosshair.setAttribute("x1", String(xAt(idx)));
    crosshair.setAttribute("x2", String(xAt(idx)));
    crosshair.style.display = "";

    tooltip.empty();
    tooltip.createDiv({ text: buckets[idx].label, attr: { style: "font-weight:600;margin-bottom:3px;" } });
    for (const s of series) {
      const row = tooltip.createDiv();
      row.style.cssText = "display:flex;align-items:center;gap:6px;";
      const key = row.createSpan();
      key.style.cssText = `width:10px;height:2px;background:${s.color};display:inline-block;flex:none;`;
      row.createSpan({ text: String(s.values[idx]), attr: { style: "font-weight:600;" } });
      row.createSpan({ text: s.name, attr: { style: "opacity:.75;" } });
    }
    tooltip.style.display = "";
    const tw = tooltip.offsetWidth;
    let left = xPix + 10;
    if (left + tw > rect.width) left = xPix - tw - 10;
    tooltip.style.left = `${Math.max(0, left)}px`;
    tooltip.style.top = "4px";
  };

  hit.addEventListener("pointermove", (e) => move((e as PointerEvent).clientX));
  hit.addEventListener("pointerleave", () => {
    crosshair.style.display = "none";
    tooltip.style.display = "none";
  });
}

// A responsive grouped bar chart for the short (daily-bucketed) ranges —
// small discrete day-level counts read better as bars than as a line. Same
// legend/gridline/axis-label conventions as renderLineChart: 4px rounded
// bar ends, a 2px surface gap between bars in the same group, bars grow from
// a single zero baseline (so a negative value, e.g. net change, extends
// below it instead of needing a second scale). Hover is per-bucket (not
// per-bar): one hit-rect per slot lifts that slot's bars slightly and shows
// a single tooltip listing every series' value there, same as the line
// chart's crosshair — the pointer never has to land on a specific bar.
function renderBarChart(parent: HTMLElement, doc: Document, buckets: Bucket[], series: ChartSeries[], yMaxOverride?: number, zeroLineColor?: string): void {
  const VB_W = 760;
  const VB_H = 200;
  const PAD = { top: 12, right: 14, bottom: 24, left: 34 };
  const plotW = VB_W - PAD.left - PAD.right;
  const plotH = VB_H - PAD.top - PAD.bottom;
  const n = buckets.length;
  const slotW = n > 0 ? plotW / n : plotW;
  const slotX = (i: number) => PAD.left + i * slotW;

  let yMin = 0;
  // A shared yMaxOverride (passed when this chart is paired with another one
  // in the same row) keeps both charts' gridlines at the same scale, so the
  // two are directly comparable at a glance instead of each auto-scaling to
  // its own data and coincidentally lining up gridlines with different values.
  let yMax = yMaxOverride ?? 0;
  for (const s of series) for (const v of s.values) {
    if (v < yMin) yMin = v;
    if (yMaxOverride === undefined && v > yMax) yMax = v;
  }
  if (yMin === yMax) yMax = yMin + 1;
  const yRange = yMax - yMin;
  const yAt = (v: number) => PAD.top + plotH - ((v - yMin) / yRange) * plotH;
  const zeroY = yAt(0);

  const wrap = parent.createDiv();
  wrap.style.cssText = "position:relative;";

  // A single series needs no legend box (the chart's title already names
  // it) — but the row is still reserved, just hidden, so this chart's plot
  // starts at the same height as a paired chart that DOES have a multi-
  // series legend. Otherwise the two charts' y-axes drift out of alignment
  // despite sharing the same value scale (sharedMax above only aligns the
  // scale, not the vertical offset the legend row itself takes up).
  const legend = wrap.createDiv();
  legend.style.cssText = `display:flex;gap:16px;flex-wrap:wrap;margin-bottom:6px;font-size:.82em;${series.length > 1 ? "" : "visibility:hidden;"}`;
  for (const s of series) {
    const row = legend.createDiv();
    row.style.cssText = "display:flex;align-items:center;gap:6px;";
    const dot = row.createSpan();
    dot.style.cssText = `width:9px;height:9px;border-radius:50%;background:${s.color};display:inline-block;flex:none;`;
    row.createSpan({ text: s.name, attr: { style: "color:var(--kb-text);opacity:.85;" } });
  }

  const svg = svgEl(doc, "svg", {
    viewBox: `0 0 ${VB_W} ${VB_H}`,
    width: "100%",
    height: VB_H,
    preserveAspectRatio: "none",
  });
  svg.style.display = "block";
  wrap.appendChild(svg);

  drawWeekendBands(doc, svg, buckets, slotX, slotW, PAD.top, VB_H - PAD.bottom);

  const ticks = 3;
  for (let t = 0; t <= ticks; t++) {
    const v = yMin + (yRange * t) / ticks;
    const y = yAt(v);
    const line = svgEl(doc, "line", { x1: PAD.left, x2: VB_W - PAD.right, y1: y, y2: y, "stroke-width": "1" });
    line.style.setProperty("stroke", "var(--background-modifier-border)");
    svg.appendChild(line);
    const label = svgEl(doc, "text", { x: PAD.left - 6, y: y + 3, "text-anchor": "end", "font-size": "9" });
    label.style.setProperty("fill", "var(--kb-text)");
    label.style.opacity = "0.6";
    label.textContent = String(Math.round(v));
    svg.appendChild(label);
  }

  // Every bucket gets its own label rather than a sparse subset — the day
  // words (Today/Yesterday/Sun/Mon/...) this chart is normally fed are short
  // enough that even a 2-3 week span fits without crowding. Only a much
  // longer, wider-labeled run (e.g. "7/21" dates) falls back to thinning.
  const stride = n <= 16 ? 1 : Math.max(1, Math.ceil(n / 8));
  const labelIndices = new Set<number>();
  for (let i = 0; i < n; i += stride) labelIndices.add(i);
  labelIndices.add(n - 1);
  for (const i of labelIndices) {
    const label = svgEl(doc, "text", { x: slotX(i) + slotW / 2, y: VB_H - 4, "text-anchor": "middle", "font-size": "9" });
    label.style.setProperty("fill", "var(--kb-text)");
    label.style.opacity = "0.6";
    label.textContent = buckets[i].label;
    svg.appendChild(label);
  }

  // Bars: each slot holds series.length bars side by side, separated by a
  // 2px surface-color gap. Each bar is capped at 32px — capping here, not
  // just insetting a percentage of the slot, is what keeps this chart's bars
  // the same thickness as renderStackedBarChart's single bar instead of
  // ballooning to fill a wide slot. The (possibly narrower than the slot)
  // group is centered in the slot.
  const GAP = 2;
  const inset = slotW * 0.12;
  const rawGroupW = Math.max(1, slotW - inset * 2);
  const rawBarW = (rawGroupW - GAP * (series.length - 1)) / series.length;
  const barW = Math.max(2, Math.min(32, rawBarW));
  const groupW = barW * series.length + GAP * (series.length - 1);
  const slotBarEls: SVGRectElement[][] = buckets.map(() => []);

  for (let i = 0; i < n; i++) {
    const groupX = slotX(i) + (slotW - groupW) / 2;
    series.forEach((s, si) => {
      const v = s.values[i];
      const barX = groupX + si * (barW + GAP);
      const y = yAt(v);
      const top = Math.min(y, zeroY);
      const h = Math.max(Math.abs(y - zeroY), 1);
      const bar = svgEl(doc, "rect", { x: barX, y: top, width: barW, height: h, rx: 2, ry: 2 });
      bar.style.setProperty("fill", s.color);
      svg.appendChild(bar);
      slotBarEls[i].push(bar);
    });
  }

  // Zero baseline, drawn over the bars so it stays crisp when a series dips
  // negative. Bolder than the recessive tick gridlines above — it's the one
  // line every bar actually measures from, so it reads as the chart's real
  // axis rather than blending into the grid.
  const zeroLine = svgEl(doc, "line", { x1: PAD.left, x2: VB_W - PAD.right, y1: zeroY, y2: zeroY, "stroke-width": "1.5" });
  zeroLine.style.setProperty("stroke", zeroLineColor ?? "var(--kb-text)");
  zeroLine.style.opacity = zeroLineColor ? "0.7" : "0.45";
  svg.appendChild(zeroLine);

  const tooltip = wrap.createDiv();
  tooltip.style.cssText =
    "position:absolute;pointer-events:none;max-width:650px;background:var(--background-primary);border:1px solid var(--background-modifier-border);" +
    "border-radius:6px;padding:6px 9px;font-size:.8em;color:var(--kb-text);box-shadow:0 2px 6px rgba(0,0,0,.15);display:none;white-space:normal;z-index:5;";

  for (let i = 0; i < n; i++) {
    const hit = svgEl(doc, "rect", { x: slotX(i), y: 0, width: slotW, height: VB_H, fill: "transparent" });
    svg.appendChild(hit);

    hit.addEventListener("pointerenter", () => {
      for (const bar of slotBarEls[i]) bar.style.opacity = "0.75";

      const rect = svg.getBoundingClientRect();
      const xPix = ((slotX(i) + slotW / 2) / VB_W) * rect.width;
      tooltip.empty();
      tooltip.createDiv({ text: buckets[i].label, attr: { style: "font-weight:600;margin-bottom:3px;" } });
      for (const s of series) appendTooltipSeriesRow(tooltip, s, i);
      tooltip.style.display = "";
      const tw = tooltip.offsetWidth;
      let left = xPix + 10;
      if (left + tw > rect.width) left = xPix - tw - 10;
      tooltip.style.left = `${Math.max(0, left)}px`;
      tooltip.style.top = "4px";
    });
    hit.addEventListener("pointerleave", () => {
      for (const bar of slotBarEls[i]) bar.style.opacity = "1";
      tooltip.style.display = "none";
    });
  }
}

// Path for a rect whose top corners only are rounded — the "4px rounded
// data-end, square at the baseline" mark spec, adapted to a stacked bar's
// topmost segment (its own bottom edge sits against the segment below, not
// a baseline, but the same "square where another mark touches it" logic
// applies).
function roundedTopRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, h, w / 2));
  return `M ${x},${y + h} L ${x},${y + rr} Q ${x},${y} ${x + rr},${y} L ${x + w - rr},${y} Q ${x + w},${y} ${x + w},${y + rr} L ${x + w},${y + h} Z`;
}

// A stacked bar chart — used for "Done / Deleted", where the two counts are
// read as parts of one whole (total completions that day) rather than
// compared side by side. One bar per bucket, segments stacked bottom-up in
// `series` order with a 2px surface gap between them (same spacer the
// grouped bar chart uses between neighbors); only the visually topmost
// non-zero segment of each bar gets the rounded "data-end", since a
// segment's other edges all touch either the baseline or another segment.
function renderStackedBarChart(parent: HTMLElement, doc: Document, buckets: Bucket[], series: ChartSeries[], yMaxOverride?: number): void {
  const VB_W = 760;
  const VB_H = 200;
  const PAD = { top: 12, right: 14, bottom: 24, left: 34 };
  const plotW = VB_W - PAD.left - PAD.right;
  const plotH = VB_H - PAD.top - PAD.bottom;
  const n = buckets.length;
  const slotW = n > 0 ? plotW / n : plotW;
  const slotX = (i: number) => PAD.left + i * slotW;

  // A shared yMaxOverride (passed when this chart is paired with another one
  // in the same row) keeps both charts' gridlines at the same scale, so the
  // two are directly comparable at a glance instead of each auto-scaling to
  // its own data and coincidentally lining up gridlines with different values.
  let yMax = yMaxOverride ?? Math.max(0, ...buckets.map((_, i) => series.reduce((sum, s) => sum + s.values[i], 0)));
  if (yMax === 0) yMax = 1;
  const yAt = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  const zeroY = yAt(0);

  const wrap = parent.createDiv();
  wrap.style.cssText = "position:relative;";

  if (series.length > 1) {
    const legend = wrap.createDiv();
    legend.style.cssText = "display:flex;gap:16px;flex-wrap:wrap;margin-bottom:6px;font-size:.82em;";
    for (const s of series) {
      const row = legend.createDiv();
      row.style.cssText = "display:flex;align-items:center;gap:6px;";
      const dot = row.createSpan();
      dot.style.cssText = `width:9px;height:9px;border-radius:50%;background:${s.color};display:inline-block;flex:none;`;
      row.createSpan({ text: s.name, attr: { style: "color:var(--kb-text);opacity:.85;" } });
    }
  }

  const svg = svgEl(doc, "svg", {
    viewBox: `0 0 ${VB_W} ${VB_H}`,
    width: "100%",
    height: VB_H,
    preserveAspectRatio: "none",
  });
  svg.style.display = "block";
  wrap.appendChild(svg);

  drawWeekendBands(doc, svg, buckets, slotX, slotW, PAD.top, VB_H - PAD.bottom);

  const ticks = 3;
  for (let t = 0; t <= ticks; t++) {
    const v = (yMax * t) / ticks;
    const y = yAt(v);
    const line = svgEl(doc, "line", { x1: PAD.left, x2: VB_W - PAD.right, y1: y, y2: y, "stroke-width": "1" });
    line.style.setProperty("stroke", "var(--background-modifier-border)");
    svg.appendChild(line);
    const label = svgEl(doc, "text", { x: PAD.left - 6, y: y + 3, "text-anchor": "end", "font-size": "9" });
    label.style.setProperty("fill", "var(--kb-text)");
    label.style.opacity = "0.6";
    label.textContent = String(Math.round(v));
    svg.appendChild(label);
  }

  // Every bucket gets its own label rather than a sparse subset — see
  // renderBarChart's identical reasoning.
  const stride = n <= 16 ? 1 : Math.max(1, Math.ceil(n / 8));
  const labelIndices = new Set<number>();
  for (let i = 0; i < n; i += stride) labelIndices.add(i);
  labelIndices.add(n - 1);
  for (const i of labelIndices) {
    const label = svgEl(doc, "text", { x: slotX(i) + slotW / 2, y: VB_H - 4, "text-anchor": "middle", "font-size": "9" });
    label.style.setProperty("fill", "var(--kb-text)");
    label.style.opacity = "0.6";
    label.textContent = buckets[i].label;
    svg.appendChild(label);
  }

  // One bar per slot (not grouped), capped at 32px — matching
  // renderBarChart's cap so the two charts in a row read as one system —
  // and centered in the slot.
  const GAP = 2;
  const inset = slotW * 0.18;
  const barW = Math.min(32, Math.max(4, slotW - inset * 2));
  const barX = (i: number) => slotX(i) + (slotW - barW) / 2;
  const slotSegEls: SVGElement[][] = buckets.map(() => []);

  for (let i = 0; i < n; i++) {
    const x = barX(i);
    let topSegIdx = -1;
    for (let si = series.length - 1; si >= 0; si--) {
      if (series[si].values[i] > 0) { topSegIdx = si; break; }
    }
    let cumBottom = 0;
    series.forEach((s, si) => {
      const v = s.values[i];
      if (v <= 0) return;
      const rawTop = yAt(cumBottom + v);
      const rawBottom = yAt(cumBottom);
      const isBottom = si === 0;
      const isTop = si === topSegIdx;
      const top = rawTop + (isTop ? 0 : GAP / 2);
      const bottom = rawBottom - (isBottom ? 0 : GAP / 2);
      const h = Math.max(bottom - top, 1);
      cumBottom += v;

      const d = isTop ? roundedTopRectPath(x, top, barW, h, 2) : `M ${x},${top} h ${barW} v ${h} h ${-barW} Z`;
      const seg = svgEl(doc, "path", { d });
      seg.style.setProperty("fill", s.color);
      svg.appendChild(seg);
      slotSegEls[i].push(seg);
    });
  }

  // Bolder than the recessive tick gridlines above — see renderBarChart's
  // identical reasoning.
  const zeroLine = svgEl(doc, "line", { x1: PAD.left, x2: VB_W - PAD.right, y1: zeroY, y2: zeroY, "stroke-width": "1.5" });
  zeroLine.style.setProperty("stroke", "var(--kb-text)");
  zeroLine.style.opacity = "0.45";
  svg.appendChild(zeroLine);

  const tooltip = wrap.createDiv();
  tooltip.style.cssText =
    "position:absolute;pointer-events:none;max-width:650px;background:var(--background-primary);border:1px solid var(--background-modifier-border);" +
    "border-radius:6px;padding:6px 9px;font-size:.8em;color:var(--kb-text);box-shadow:0 2px 6px rgba(0,0,0,.15);display:none;white-space:normal;z-index:5;";

  for (let i = 0; i < n; i++) {
    const hit = svgEl(doc, "rect", { x: slotX(i), y: 0, width: slotW, height: VB_H, fill: "transparent" });
    svg.appendChild(hit);

    hit.addEventListener("pointerenter", () => {
      for (const seg of slotSegEls[i]) seg.style.opacity = "0.75";

      const rect = svg.getBoundingClientRect();
      const xPix = ((slotX(i) + slotW / 2) / VB_W) * rect.width;
      tooltip.empty();
      tooltip.createDiv({ text: buckets[i].label, attr: { style: "font-weight:600;margin-bottom:3px;" } });
      for (const s of series) appendTooltipSeriesRow(tooltip, s, i);
      tooltip.style.display = "";
      const tw = tooltip.offsetWidth;
      let left = xPix + 10;
      if (left + tw > rect.width) left = xPix - tw - 10;
      tooltip.style.left = `${Math.max(0, left)}px`;
      tooltip.style.top = "4px";
    });
    hit.addEventListener("pointerleave", () => {
      for (const seg of slotSegEls[i]) seg.style.opacity = "1";
      tooltip.style.display = "none";
    });
  }
}

// ─── VIEW ───────────────────────────────────────────────────────────────────

export class KanbanStatisticsView extends ItemView {
  plugin: KanbanPlugin;
  private rangeMode: TrendRangeMode = "last7";
  private activeTab: StatsTab = "done";
  private isRefreshing = false;
  private refreshPending = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: KanbanPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_KANBAN_STATS;
  }

  getDisplayText(): string {
    return "Kanban Statistics";
  }

  getIcon(): string {
    return "bar-chart-3";
  }

  async onOpen() {
    this.registerEvent(this.app.vault.on("modify", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh()));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf === this.leaf) this.scheduleRefresh(100);
      })
    );
    await this.render();
  }

  async onClose() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  async refresh() {
    await this.render();
  }

  private scheduleRefresh(delay = 400) {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.render(), delay);
  }

  private async render() {
    if (this.isRefreshing) {
      this.refreshPending = true;
      return;
    }
    this.isRefreshing = true;

    const container = this.contentEl;
    const scrollTop = container.scrollTop;

    try {
      container.empty();
      container.style.cssText = "padding:16px;overflow-y:auto;";

      const config = buildConfig(this.plugin.settings);

      // Re-declare buildColorCSS's --kb-* variables scoped to this container —
      // those are otherwise scoped to #kanban-wrapper (the board's own container).
      const cv = (val: string, fb: string) => ((val && val.trim()) ? val.trim() : fb);
      container.style.setProperty("--kb-text", cv(config.colorText, "var(--text-normal)"));
      container.style.setProperty("--kb-accent", cv(config.colorAccent, "var(--interactive-accent)"));
      container.style.setProperty("--kb-link", cv(config.colorLink, "var(--text-accent)"));
      container.style.setProperty("--kb-bold-color", cv(config.colorBold, "color-mix(in srgb, var(--kb-text) 75%, black)"));
      container.style.setProperty("--kb-italic-star-color", cv(config.colorItalicStar, "color-mix(in srgb, var(--kb-text) 85%, white)"));
      container.style.setProperty("--kb-italic-underscore-color", cv(config.colorItalicUnderscore, "color-mix(in srgb, var(--kb-text) 55%, teal)"));
      container.style.color = "var(--kb-text)";

      const error = validateConfig(this.plugin.settings);
      if (error) {
        container.createEl("h3", { text: "Kanban Configuration Error" });
        container.createEl("p", { text: error });
        container.createEl("p", { text: "Open Settings → Kanban Board to configure the plugin." });
        return;
      }

      const doc = container.ownerDocument;
      let colorCss = doc.getElementById("kanban-color-vars");
      if (!colorCss) {
        colorCss = doc.createElement("style");
        colorCss.id = "kanban-color-vars";
        doc.head.appendChild(colorCss);
      }
      (colorCss as HTMLStyleElement).textContent = buildColorCSS(config);

      const header = container.createDiv();
      header.style.cssText = "display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:6px;";
      header.createEl("h2", { text: "Kanban Statistics", attr: { style: "margin:0;color:var(--kb-text);" } });

      const toggleBar = header.createDiv();
      toggleBar.style.cssText = "display:flex;gap:4px;border:1px solid var(--background-modifier-border);border-radius:6px;padding:2px;";
      const modes: [TrendRangeMode, string][] = [
        ["last7", "Last 7 days"],
        ["sinceSaturday", "Since Saturday"],
        ["last30", "Last 30 days"],
        ["last12weeks", "Last 12 weeks"],
        ["thisYear", "This year"],
        ["last12months", "Last 12 months"],
      ];
      for (const [mode, label] of modes) {
        const active = this.rangeMode === mode;
        const btn = toggleBar.createEl("button", { text: label });
        btn.style.cssText = `border:none;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:.9em;${
          active
            ? "background:var(--interactive-accent);color:var(--text-on-accent);"
            : "background:transparent;color:var(--kb-text);"
        }`;
        btn.addEventListener("click", () => {
          if (this.rangeMode === mode) return;
          this.rangeMode = mode;
          this.render();
        });
      }

      const nav = container.createDiv();
      nav.style.cssText = "margin-bottom:18px;font-size:.85em;";
      const navLink = (text: string, onClick: () => void) => {
        const a = nav.createEl("a", { text });
        a.style.cssText = "color:var(--kb-link, var(--text-muted));text-decoration:underline dotted;cursor:pointer;margin-right:14px;";
        a.addEventListener("click", (e) => {
          e.preventDefault();
          onClick();
        });
      };
      navLink("📋 Kanban board", () => this.plugin.activateView());

      const vaultName = this.app.vault.getName();
      const paths = await getTargetFilePaths(this.app, config);
      await stampMissingCreatedDates(this.app, paths, config);
      // So a checked item that's missing its ✅ done-date (a hand-edit, or
      // anything else that bypassed the board's own checkbox click) gets
      // backfilled here too — this page shouldn't depend on the Kanban
      // board having been opened first for its own numbers to be complete.
      await moveCheckedCardsToDone(this.app, paths, config);

      const items = await collectItems(this.app, paths, config);
      const { events, openCards } = collectOpenAndEvents(items, config, vaultName);
      const deletedEvents = await collectDeletedEvents(this.app, paths);

      const today = startOfToday();
      const weekStart = getLast7DaysStart();
      const inLast7 = (d: Date) => d.getTime() >= weekStart.getTime() && d.getTime() <= today.getTime();

      const totalOpen = openCards.length;
      const newThisWeek = events.filter((e) => e.createdDate && inLast7(e.createdDate) && !e.excludedFromNew).length;
      const doneThisWeek = events.filter((e) => e.doneDate && inLast7(e.doneDate)).length;
      const agedCards = openCards.filter((c) => c.createdDate);
      const avgAgeDays = agedCards.length
        ? Math.round(agedCards.reduce((sum, c) => sum + (today.getTime() - c.createdDate!.getTime()) / 86400000, 0) / agedCards.length)
        : 0;

      const tileRow = container.createDiv();
      tileRow.style.cssText = "display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px;";
      const tile = (label: string, value: string, explain: string) => {
        const t = tileRow.createDiv();
        t.style.cssText = "position:relative;flex:1;min-width:130px;background:var(--background-secondary);border-radius:8px;padding:12px 14px;cursor:help;";
        t.createDiv({ text: label, attr: { style: "font-size:.78em;color:var(--kb-text);opacity:.65;margin-bottom:4px;" } });
        t.createDiv({ text: value, attr: { style: "font-size:1.6em;font-weight:600;color:var(--kb-accent);" } });
        const tip = t.createDiv({ text: explain });
        tip.style.cssText =
          "position:absolute;left:0;top:100%;margin-top:6px;z-index:6;display:none;width:220px;white-space:normal;line-height:1.35;" +
          "pointer-events:none;background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:6px;" +
          "padding:8px 10px;font-size:.78em;color:var(--kb-text);opacity:1;box-shadow:0 2px 6px rgba(0,0,0,.15);";
        t.addEventListener("pointerenter", () => { tip.style.display = ""; });
        t.addEventListener("pointerleave", () => { tip.style.display = "none"; });
      };
      tile(
        "Open tasks",
        String(totalOpen),
        "Cards not in Done, Later, Recurrent, or tagged #MaybeSomeday — including subtasks that have been spun out into their own kanban column, counted the same as any other card."
      );
      tile(
        "New this week",
        String(newThisWeek),
        "Cards or subtasks whose creation stamp falls in the last 7 days (today and the 6 days before it) — except ones tagged Later, Recurrent, or #MaybeSomeday."
      );
      tile("Done this week", String(doneThisWeek), "Cards or subtasks whose ✅ done-date stamp falls in the last 7 days (today and the 6 days before it).");
      tile("Avg. age of open (days)", String(avgAgeDays), "Average of (today − creation date) across open cards (same definition as the Open tasks tile) with a recorded creation date. Cards with no recorded date aren't counted.");

      const buckets = buildBuckets(this.rangeMode);
      // "Newly opened" — same exclusion as the New this week tile, so the
      // chart and tile never disagree about what counts as new work.
      const createdDates = events.filter((e) => !e.excludedFromNew).map((e) => e.createdDate);
      const doneDates = events.map((e) => e.doneDate);
      const deletedDates = deletedEvents.map((e) => e.date);
      const openedCounts = buckets.map((b) => countInBucket(createdDates, b));
      const doneCounts = buckets.map((b) => countInBucket(doneDates, b));
      const deletedCounts = buckets.map((b) => countInBucket(deletedDates, b));

      // Per-bucket task/subtask entries behind each of the counts above, for
      // the "Newly opened" / "Done / Deleted" charts' hover tooltip.
      const createdEntries = events.filter(
        (e): e is EventDates & { createdDate: Date } => e.createdDate !== null && !e.excludedFromNew
      );
      const doneEntries = events.filter((e): e is EventDates & { doneDate: Date } => e.doneDate !== null);

      // Newly opened: hide a checked-off item only if it's not a card in its
      // own right — a resolved plain subtask is stale noise once it's no
      // longer part of what's actually open, but a still-open plain subtask
      // (shown with its parent for context) or any card/spun-out subtask
      // (checked or not) still belongs in the list.
      const openedBucketEntries = buckets.map((b) =>
        entriesInBucket(createdEntries, b, (e) => e.createdDate).filter((e) => e.isOwnCard || !e.checked)
      );
      const openedTitles = openedBucketEntries.map((entries) => formatHoverList(entries));
      const openedListedCounts = openedBucketEntries.map((entries) => entries.length);

      // Done/Deleted: every completed/deleted item in range is listed, own
      // card or plain subtask alike — unlike Newly opened, whether it's an
      // independently-tracked card is irrelevant here. Still shown with its
      // parent for context when it's a subtask.
      const doneBucketEntries = buckets.map((b) => entriesInBucket(doneEntries, b, (e) => e.doneDate));
      const doneTitles = doneBucketEntries.map((entries) => formatHoverList(entries));
      const doneListedCounts = doneBucketEntries.map((entries) => entries.length);

      const deletedBucketEntries = buckets.map((b) => entriesInBucket(deletedEvents, b, (e) => e.date));
      const deletedTitles = deletedBucketEntries.map((entries) => formatHoverList(entries));
      const deletedListedCounts = deletedBucketEntries.map((entries) => entries.length);

      // Opened minus done minus deleted, per bucket — not a running total:
      // this is how much the backlog grew or shrank that day/week on its
      // own, so a bad week doesn't stay baked into every bar after it.
      const netChange = buckets.map((_, i) => openedCounts[i] - doneCounts[i] - deletedCounts[i]);

      const isLongRange = isLongRangeMode(this.rangeMode);
      const renderChart = isLongRange ? renderLineChart : renderBarChart;
      // Done/Deleted are parts of one whole (completions that day), so they
      // stack — but only in bar mode. A stacked *line* chart would need area
      // fills the long-range chart doesn't have, so the 3 long, weekly-
      // bucketed ranges fall back to two plain overlaid lines instead.
      const renderDoneDeletedChart = isLongRange ? renderLineChart : renderStackedBarChart;

      // Newly opened and Done/Deleted sit side by side specifically to be
      // compared at a glance, so they share one y-axis scale (the taller of
      // the two datasets' own maxes) rather than each auto-scaling to fill
      // its own plot height with unrelated tick values.
      const doneDeletedTotals = buckets.map((_, i) => doneCounts[i] + deletedCounts[i]);
      const sharedMax = Math.max(0, ...openedCounts, ...doneDeletedTotals);

      const chartRow = container.createDiv();
      chartRow.style.cssText = "display:flex;gap:20px;flex-wrap:wrap;margin-bottom:28px;";

      const chart1Wrap = chartRow.createDiv();
      chart1Wrap.style.cssText = "flex:1;min-width:320px;";
      chart1Wrap.createEl("h3", { text: "Newly opened", attr: { style: "margin:0 0 8px;color:var(--kb-text);font-size:1em;" } });
      renderChart(chart1Wrap, doc, buckets, [{ name: "Newly opened", color: config.colorChartOpened, values: openedCounts, labels: openedTitles, labelCounts: openedListedCounts }], sharedMax);

      const chart2Wrap = chartRow.createDiv();
      chart2Wrap.style.cssText = "flex:1;min-width:320px;";
      chart2Wrap.createEl("h3", { text: "Done / Deleted", attr: { style: "margin:0 0 8px;color:var(--kb-text);font-size:1em;" } });
      renderDoneDeletedChart(chart2Wrap, doc, buckets, [
        { name: "Done", color: config.colorChartDone, values: doneCounts, labels: doneTitles, labelCounts: doneListedCounts },
        { name: "Deleted", color: config.colorChartDeleted, values: deletedCounts, labels: deletedTitles, labelCounts: deletedListedCounts },
      ], sharedMax);

      const chart3Wrap = container.createDiv();
      chart3Wrap.style.cssText = "margin-bottom:28px;";
      chart3Wrap.createEl("h3", { text: "Net change", attr: { style: "margin:0 0 8px;color:var(--kb-text);font-size:1em;" } });
      renderChart(chart3Wrap, doc, buckets, [{ name: "Net change", color: "var(--kb-accent)", values: netChange }], undefined, config.colorChartZeroAxis);

      const tabBar = container.createDiv();
      tabBar.style.cssText = "display:flex;gap:4px;border:1px solid var(--background-modifier-border);border-radius:6px;padding:2px;margin-bottom:12px;width:fit-content;";
      const tabs: [StatsTab, string][] = [
        ["done", "Done this week"],
        ["open", "Oldest open tasks"],
      ];
      for (const [tab, label] of tabs) {
        const active = this.activeTab === tab;
        const btn = tabBar.createEl("button", { text: label });
        btn.style.cssText = `border:none;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:.9em;${
          active
            ? "background:var(--interactive-accent);color:var(--text-on-accent);"
            : "background:transparent;color:var(--kb-text);"
        }`;
        btn.addEventListener("click", () => {
          if (this.activeTab === tab) return;
          this.activeTab = tab;
          this.render();
        });
      }

      const tableWrap = container.createDiv();
      tableWrap.style.cssText = "overflow-x:auto;";

      // A row's own visibility is decided by its parent (hidden whenever the
      // parent is collapsed); a row's children are visible only when the row
      // itself is visible AND currently expanded — shared by both tabs' tables.
      const applyVisibility = (r: RenderedRow, visible: boolean) => {
        r.row.style.display = visible ? "" : "none";
        const childrenVisible = visible && r.expanded;
        for (const c of r.children) applyVisibility(c, childrenVisible);
      };

      if (this.activeTab === "open") {
        const sortedOpen = [...openCards].sort((a, b) => {
          if (a.ageDate && b.ageDate) return a.ageDate.getTime() - b.ageDate.getTime();
          if (a.ageDate) return -1;
          if (b.ageDate) return 1;
          return a.filePath === b.filePath ? a.line - b.line : a.filePath.localeCompare(b.filePath);
        });
        const oldest = sortedOpen.slice(0, 15);

        if (!oldest.length) {
          tableWrap.createEl("p", { text: "No open tasks.", attr: { style: "color:var(--kb-text);opacity:.7;" } });
        } else {
          const table = tableWrap.createEl("table");
          // table-layout:fixed makes every column width an explicit, content-
          // independent decision (taken from this header row) instead of the
          // browser's auto-layout handing most of the row to whichever column
          // has the longest text — which is what let Task balloon out to most
          // of the row width, pushing Subtasks/File far from the task text.
          table.style.cssText = "width:100%;table-layout:fixed;border-collapse:collapse;color:var(--kb-text);";
          const AGE_COL_W = "90px";
          const TASK_COL_W = "40%";
          const SUB_COL_W = "90px";
          const COLUMN_COL_W = "110px";
          const headRow = table.createEl("thead").createEl("tr");
          for (const label of ["Age (days)", "Task", "Subtasks", "Column", "File"]) {
            const th = headRow.createEl("th", { text: label });
            th.style.cssText = "text-align:left;padding:8px 10px;border-bottom:2px solid var(--background-modifier-border);white-space:nowrap;";
            if (label === "Age (days)") {
              th.style.cssText += `width:${AGE_COL_W};min-width:${AGE_COL_W};max-width:${AGE_COL_W};cursor:help;`;
              th.title = "Days since this card was created — or, if a subtask has been completed more recently, days since that completion instead. A card with subtasks still getting checked off isn't stale, however old the card itself is.";
            }
            if (label === "Task") th.style.cssText += `width:${TASK_COL_W};`;
            if (label === "Subtasks") th.style.cssText += `width:${SUB_COL_W};min-width:${SUB_COL_W};max-width:${SUB_COL_W};`;
            if (label === "Column") th.style.cssText += `width:${COLUMN_COL_W};min-width:${COLUMN_COL_W};max-width:${COLUMN_COL_W};`;
          }
          const tbody = table.createEl("tbody");

          const renderTaskNode = (node: TaskNode, depth: number, isRoot: boolean, rootAgeDate?: Date | null): RenderedRow => {
            const row = tbody.createEl("tr");
            row.style.cssText = "border-bottom:1px solid var(--background-modifier-border);";

            // Age is shown for any open node, not just the root card — a still-
            // open subtask has been sitting there just as long, once expanded.
            // A checked (done) subtask shows no age: it isn't "open" anymore.
            // The root card's age uses ageDate (createdDate, unless a subtask
            // was completed more recently) — a subtask row further down still
            // measures its own age from its own createdDate.
            const isOpen = isRoot || !node.checked;
            const ageSourceDate = isRoot ? rootAgeDate : node.createdDate;
            const ageDays = ageSourceDate ? Math.round((today.getTime() - ageSourceDate.getTime()) / 86400000) : null;
            const ageCell = row.createEl("td", { text: isOpen ? (ageDays === null ? "—" : String(ageDays)) : "" });
            ageCell.style.cssText = `padding:8px 10px;white-space:nowrap;vertical-align:top;width:${AGE_COL_W};min-width:${AGE_COL_W};max-width:${AGE_COL_W};`;

            const taskCell = row.createEl("td");
            taskCell.style.cssText = `padding:8px 10px 8px ${10 + depth * 18}px;`;
            const checkboxEl = taskCell.createEl("input", { attr: { type: "checkbox" } });
            checkboxEl.disabled = true;
            checkboxEl.checked = isRoot ? false : node.checked;
            checkboxEl.style.cssText = "margin-right:6px;vertical-align:middle;cursor:default;";
            const hasChildren = node.children.length > 0;
            const toggleSpan = taskCell.createSpan({ text: hasChildren ? "▶" : "" });
            toggleSpan.style.cssText = `display:inline-block;width:1.2em;color:var(--kb-accent);user-select:none;${
              hasChildren ? "cursor:pointer;" : "visibility:hidden;"
            }`;
            const textSpan = taskCell.createSpan({ attr: { style: isRoot ? "font-weight:600;" : "" } });
            textSpan.innerHTML = node.displayHtml;

            const subCell = row.createEl("td", { text: hasChildren ? String(node.children.length) : "" });
            subCell.style.cssText = `padding:8px 10px;white-space:nowrap;vertical-align:top;color:var(--kb-text);opacity:.7;width:${SUB_COL_W};min-width:${SUB_COL_W};max-width:${SUB_COL_W};`;

            const columnCell = row.createEl("td", { text: node.column || "—" });
            columnCell.style.cssText = `padding:8px 10px;white-space:nowrap;vertical-align:top;color:var(--kb-text);opacity:.7;width:${COLUMN_COL_W};min-width:${COLUMN_COL_W};max-width:${COLUMN_COL_W};`;

            const fileCell = row.createEl("td");
            fileCell.style.cssText = "padding:8px 10px;white-space:nowrap;vertical-align:top;";
            const basename = node.filePath.split("/").pop()!.replace(/\.md$/, "");
            const link = fileCell.createEl("a", { text: basename });
            link.style.cssText = "color:var(--kb-link);text-decoration:underline dotted;cursor:pointer;";
            link.addEventListener("click", (e) => {
              e.preventDefault();
              void this.openSource(node.filePath, node.line);
            });

            const rendered: RenderedRow = { row, children: [], expanded: false };
            for (const child of node.children) {
              rendered.children.push(renderTaskNode(child, depth + 1, false));
            }

            if (hasChildren) {
              toggleSpan.addEventListener("click", () => {
                rendered.expanded = !rendered.expanded;
                toggleSpan.textContent = rendered.expanded ? "▼" : "▶";
                applyVisibility(rendered, true); // this row is visible whenever its own toggle is clickable
              });
            }

            return rendered;
          };

          for (const row of oldest) {
            const rendered = renderTaskNode(row, 0, true, row.ageDate);
            applyVisibility(rendered, true); // root rows always visible; children start collapsed
          }
        }
      } else {
        // Always the same fixed rolling 7-day window as the "Done this week"
        // tile above, regardless of the chart range toggle — otherwise this
        // tab's own total silently disagreed with the tile whenever the
        // toggle wasn't set to "Last 7 days" (e.g. the page's default,
        // "Since Saturday", covers more days than the tile counts).
        const doneGroups = collectDoneGroups(items, vaultName, weekStart, today);

        if (!doneGroups.length) {
          tableWrap.createEl("p", { text: "No completed tasks in this range.", attr: { style: "color:var(--kb-text);opacity:.7;" } });
        } else {
          const table = tableWrap.createEl("table");
          // table-layout:fixed makes every column width an explicit, content-
          // independent decision (taken from this header row) instead of the
          // browser's auto-layout handing most of the row to whichever column
          // has the longest text — which is what let Task balloon out to most
          // of the row width, pushing Subtasks/File far from the task text.
          table.style.cssText = "width:100%;table-layout:fixed;border-collapse:collapse;color:var(--kb-text);";
          // Fixed wide enough for "Yesterday" (the longest label dayLabel can
          // produce) so the column never reflows narrower/wider as different
          // rows' days change between renders (e.g. switching range mode).
          const DAY_COL_W = "100px";
          const TASK_COL_W = "40%";
          const SUB_COL_W = "90px";
          const headRow = table.createEl("thead").createEl("tr");
          for (const label of ["Day", "Task", "Subtasks", "File"]) {
            const th = headRow.createEl("th", { text: label });
            th.style.cssText = "text-align:left;padding:8px 10px;border-bottom:2px solid var(--background-modifier-border);white-space:nowrap;";
            if (label === "Day") th.style.cssText += `width:${DAY_COL_W};min-width:${DAY_COL_W};max-width:${DAY_COL_W};`;
            if (label === "Task") th.style.cssText += `width:${TASK_COL_W};`;
            if (label === "Subtasks") th.style.cssText += `width:${SUB_COL_W};min-width:${SUB_COL_W};max-width:${SUB_COL_W};`;
          }
          const tbody = table.createEl("tbody");

          const renderDoneNode = (node: DoneNode, isRoot: boolean): RenderedRow => {
            const row = tbody.createEl("tr");
            row.style.cssText = "border-bottom:1px solid var(--background-modifier-border);";

            const dayCell = row.createEl("td", { text: node.matched && node.date ? dayLabel(node.date, today) : "—" });
            dayCell.style.cssText = `padding:8px 10px;white-space:nowrap;vertical-align:top;width:${DAY_COL_W};min-width:${DAY_COL_W};max-width:${DAY_COL_W};`;

            const taskCell = row.createEl("td");
            taskCell.style.cssText = `padding:8px 10px 8px ${10 + node.depth * 18}px;`;
            const checkboxEl = taskCell.createEl("input", { attr: { type: "checkbox" } });
            checkboxEl.disabled = true;
            checkboxEl.checked = node.matched;
            checkboxEl.style.cssText = "margin-right:6px;vertical-align:middle;cursor:default;";
            const hasChildren = node.children.length > 0;
            const toggleSpan = taskCell.createSpan({ text: hasChildren ? "▶" : "" });
            toggleSpan.style.cssText = `display:inline-block;width:1.2em;color:var(--kb-accent);user-select:none;${
              hasChildren ? "cursor:pointer;" : "visibility:hidden;"
            }`;
            const textSpan = taskCell.createSpan({ attr: { style: isRoot ? "font-weight:600;" : "" } });
            textSpan.innerHTML = node.displayHtml;

            const subCell = row.createEl("td", { text: hasChildren ? String(node.children.length) : "" });
            subCell.style.cssText = `padding:8px 10px;white-space:nowrap;vertical-align:top;color:var(--kb-text);opacity:.7;width:${SUB_COL_W};min-width:${SUB_COL_W};max-width:${SUB_COL_W};`;

            const fileCell = row.createEl("td");
            fileCell.style.cssText = "padding:8px 10px;white-space:nowrap;vertical-align:top;";
            const basename = node.filePath.split("/").pop()!.replace(/\.md$/, "");
            const link = fileCell.createEl("a", { text: basename });
            link.style.cssText = "color:var(--kb-link);text-decoration:underline dotted;cursor:pointer;";
            link.addEventListener("click", (e) => {
              e.preventDefault();
              void this.openSource(node.filePath, node.line);
            });

            const rendered: RenderedRow = { row, children: [], expanded: false };
            for (const child of node.children) {
              rendered.children.push(renderDoneNode(child, false));
            }

            if (hasChildren) {
              toggleSpan.addEventListener("click", () => {
                rendered.expanded = !rendered.expanded;
                toggleSpan.textContent = rendered.expanded ? "▼" : "▶";
                applyVisibility(rendered, true);
              });
            }

            return rendered;
          };

          for (const group of doneGroups) {
            const rendered = renderDoneNode(group.root, true);
            applyVisibility(rendered, true);
          }

          // Grand totals — cards vs. subtasks completed, counted from the same
          // matched-node data the rows above were built from.
          let totalCards = 0;
          let totalSubtasks = 0;
          const tallyMatched = (node: DoneNode, isRoot: boolean) => {
            if (node.matched) {
              if (isRoot) totalCards++; else totalSubtasks++;
            }
            for (const c of node.children) tallyMatched(c, false);
          };
          for (const g of doneGroups) tallyMatched(g.root, true);
          const totalCompleted = totalCards + totalSubtasks;

          const tfoot = table.createEl("tfoot");
          const totalRow = tfoot.createEl("tr");
          totalRow.style.cssText = "border-top:2px solid var(--background-modifier-border);font-weight:600;";
          totalRow.createEl("td"); // Day column stays blank on the totals row
          const totalLabelCell = totalRow.createEl("td", {
            text: `Total: ${totalCompleted} completed (${totalCards} card${totalCards === 1 ? "" : "s"}, ${totalSubtasks} subtask${totalSubtasks === 1 ? "" : "s"})`,
          });
          totalLabelCell.style.cssText = "padding:10px;";
          const totalSubtaskCell = totalRow.createEl("td", { text: String(totalSubtasks) });
          totalSubtaskCell.style.cssText = "padding:10px;";
          totalRow.createEl("td"); // File column stays blank on the totals row
        }
      }
    } catch (e: any) {
      console.error("Kanban Statistics render error:", e);
      container.empty();
      container.createEl("h3", { text: "Kanban Statistics — Error" });
      container.createEl("p", { text: e?.message ?? String(e) });
    } finally {
      container.scrollTop = scrollTop;
      this.isRefreshing = false;
      if (this.refreshPending) {
        this.refreshPending = false;
        void this.render();
      }
    }
  }

  private async openSource(filePath: string, line: number) {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { eState: { line: line - 1 } });
  }
}
