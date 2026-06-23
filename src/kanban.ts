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
  newTaskInsert: string;
  normKanban: string[];
  normDone: string;
  normToday: string;
  normLater: string;
  normProject: string[];
  projectsDocument: string;
  allChildrenDoneColor: string;
  allCheckedColor: string;
  // Colors (empty string → fall back to Obsidian theme variable)
  columnColors: Record<string, string>;
  colorCardBg: string;
  colorColumnBg: string;
  colorText: string;
  colorAccent: string;
  colorLink: string;
  colorFamilySelf: string;
  colorFamilyParent: string;
  colorFamilySibling: string;
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
    normProject: (settings.projectColumns || []).map(normalizeTag),
    projectsDocument: settings.projectsDocument || "",
    allChildrenDoneColor: settings.allChildrenDoneColor,
    allCheckedColor: settings.allCheckedColor || "#2db55d",
    columnColors: Object.fromEntries(
      (settings.kanban || []).map((tag, i) => [normalizeTag(tag), (settings.columnColors || [])[i] || ""])
    ),
    colorCardBg: settings.colorCardBg || "",
    colorColumnBg: settings.colorColumnBg || "",
    colorText: settings.colorText || "",
    colorAccent: settings.colorAccent || "",
    colorLink: settings.colorLink || "",
    colorFamilySelf: settings.colorFamilySelf || "#e03e3e",
    colorFamilyParent: settings.colorFamilyParent || "#2db55d",
    colorFamilySibling: settings.colorFamilySibling || "#4a90d9",
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

  return { indent, bullet, checked, text, tags, date, doneDate, orderDigits, orderState };
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

function getNextMonday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const diff = (8 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d;
}

function getDefaultDate(existing: Date | null = null): Date {
  if (!(existing instanceof Date) || isNaN(existing.getTime()))
    return getNextMonday();
  const c = new Date(existing);
  c.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return c <= today ? getNextMonday() : c;
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
  newState: "expanded" | "collapsed" | null = null
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

    if (parsed.checked !== null) parsed.checked = isDone;
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
      const safeTitle = cardText.replace(/[\\/:*?"<>|#\[\]]/g, " ").replace(/\s+/g, " ").trim();
      const docPath = `${safeTitle}.md`;

      let projFile = app.vault.getAbstractFileByPath(docPath) as TFile | null;
      if (!projFile) {
        projFile = await app.vault.create(docPath, "");
        showInfoDialog(`Created new note "${safeTitle}.md".`);
      }

      let newLine = `- [ ] ${cardText} ${columnTag}`;
      if (dateStr) newLine += ` ${dateStr}`;
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

    // ── Normal path: monthly document structure ──────────────────────────────
    // {baseName}/{baseName}-YYYY-MM.md  — tasks live here
    // {baseName}/{baseName}.md          — index linking to each month (newest on top)
    const baseName = rawInsertTarget.trim().split("#")[0].replace(/\.md$/, "").trim();
    const dirPath = baseName;
    const now = new Date();
    const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const monthlyFileName = `${baseName}-${monthStr}`;
    const monthlyPath = `${dirPath}/${monthlyFileName}.md`;
    const indexPath = `${dirPath}/${baseName}.md`;

    if (!(app.vault.getAbstractFileByPath(dirPath) instanceof TFolder)) {
      await app.vault.createFolder(dirPath);
    }

    let monthlyFile = app.vault.getAbstractFileByPath(monthlyPath) as TFile | null;
    if (!monthlyFile) {
      monthlyFile = await app.vault.create(monthlyPath, `# ${monthlyFileName}\n`);
    }

    // Add link to index only if not already present
    const linkLine = `[[${monthlyFileName}]]`;
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
    const monthlyLines = (await app.vault.read(monthlyFile)).split("\n");
    let insertAt = afterFrontMatter(monthlyLines);
    if (monthlyLines[insertAt]?.match(/^#\s/)) insertAt++;
    monthlyLines.splice(insertAt, 0, newLine);
    await app.vault.modify(monthlyFile, monthlyLines.join("\n"));

    new Notice(`Added "${userText}" to ${columnTag.replace(/^#/, "").toUpperCase()}.`);
    return true;
  } catch (e: any) {
    console.error("addNewItem failed:", e);
    new Notice(`Failed to add item: ${e.message}`);
    return false;
  }
}

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

    function archiveLine(idx: number, tickBox: boolean) {
      if (idx < 0 || idx >= lines.length) return;
      const parsed = parseTaskLine(lines[idx]);
      if (tickBox && parsed.checked !== null) parsed.checked = true;
      parsed.tags = parsed.tags.filter((t) => !config.normKanban.includes(normalizeTag(t)));
      parsed.orderDigits = null;
      parsed.orderState = null;
      lines[idx] = serializeTaskLine(parsed);
    }

    archiveLine(mainLineNum - 1, true);
    const recurse = (subs: any[]) => {
      for (const sub of subs) {
        archiveLine(sub.line - 1, false);
        if (sub.subs?.length) recurse(sub.subs);
      }
    };
    recurse(subLines);

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
        isPromoted: ownTags.some((t: string) =>
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
  config: KanbanConfig
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

function makeOverlay(id: string) {
  document.getElementById(id)?.remove();
  const overlay = document.createElement("div");
  overlay.id = id;
  overlay.style.cssText =
    "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;";
  document.body.appendChild(overlay);
  const dialog = document.createElement("div");
  dialog.style.cssText =
    "background:var(--background-primary);color:var(--text-normal);padding:20px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:300px;max-width:400px;text-align:center;";
  overlay.appendChild(dialog);
  const close = () => overlay.remove();
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
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

function showDateDialog(
  title: string,
  defaultDate: string,
  onSubmit: (v: string) => void
) {
  const { dialog, close } = makeOverlay("kanban-date-dialog");
  dialog.innerHTML = `<h3 style="margin:0 0 10px;font-size:1.1em;">${title}</h3>
    <input id="k-date" type="date" value="${defaultDate}" style="${inputStyle()}" autofocus>
    <div style="display:flex;gap:10px;justify-content:center;">${buttonHtml("Set", true)}${buttonHtml("Cancel", false)}</div>`;

  const [setBtn, cancelBtn] = dialog.querySelectorAll("button");
  const dateInput = dialog.querySelector("#k-date") as HTMLInputElement;
  const submit = () => {
    const v = dateInput.value;
    close();
    if (v) onSubmit("@" + v);
  };
  setBtn.onclick = submit;
  cancelBtn.onclick = close;
  dateInput.onkeydown = (e) => {
    if (e.key === "Enter") submit();
    if (e.key === "Escape") close();
  };
  dateInput.focus();
}

function showLaterAddDialog(
  title: string,
  defaultCreateDoc: boolean,
  onSubmit: (text: string, dateStr: string, createDoc: boolean) => void
) {
  const { dialog, close } = makeOverlay("kanban-later-add-dialog");
  const defDate = getDefaultDate().toISOString().split("T")[0];
  const chk = defaultCreateDoc ? "checked" : "";
  dialog.innerHTML = `<h3 style="margin:0 0 10px;font-size:1.1em;">${title}</h3>
    <input id="k-text" type="text" placeholder="Enter new item text..." style="${inputStyle()}" autofocus>
    <input id="k-date" type="date" value="${defDate}" style="${inputStyle()}">
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;font-size:.9em;">
      <input id="k-doc" type="checkbox" ${chk}> Create new document
    </label>
    <div style="display:flex;gap:10px;justify-content:center;">${buttonHtml("Add", true)}${buttonHtml("Cancel", false)}</div>`;

  const [addBtn, cancelBtn] = dialog.querySelectorAll("button");
  const textInput = dialog.querySelector("#k-text") as HTMLInputElement;
  const dateInput = dialog.querySelector("#k-date") as HTMLInputElement;
  const docCheck = dialog.querySelector("#k-doc") as HTMLInputElement;
  const submit = () => {
    const t = textInput.value.trim(),
      d = dateInput.value;
    const createDoc = docCheck.checked;
    close();
    if (t && d) onSubmit(t, "@" + d, createDoc);
  };
  addBtn.onclick = submit;
  cancelBtn.onclick = close;
  [textInput, dateInput].forEach((el) => {
    el.onkeydown = (e) => {
      if (e.key === "Enter") submit();
      if (e.key === "Escape") close();
    };
  });
  textInput.focus();
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
  const tagToRemove = extractTags(display).find(
    (t: string) => normalizeTag(t) === currentNorm
  );
  if (tagToRemove)
    display = display
      .split(/\s+/)
      .filter((w: string) => w !== tagToRemove)
      .join(" ")
      .trim();
  display = display.replace(/%% @\d+\w %%/g, "").trim();

  const rawText = display
    .replace(/^- \[[ xX]\] /, "")
    .replace(/^[-*+]\s+/, "")
    .trim();
  const mainContent = linksToHtml(rawText, vaultName);

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
  // Any unchecked descendant that has an active (non-done) kanban tag.
  function hasActiveKanban(subs: any[]): boolean {
    for (const s of subs ?? []) {
      if (isCheckboxItem(s) && !isCheckedItem(s)) {
        const tags: string[] = s.tags ?? [];
        if (tags.some((t: string) => {
          const norm = normalizeTag(t);
          return config.normKanban.includes(norm) && norm !== config.normDone;
        })) return true;
      }
      if (s.subs?.length && hasActiveKanban(s.subs)) return true;
    }
    return false;
  }

  const hasCheckboxSubs = hasAnyCheckbox(item.item.subs);
  // Green: has checkboxes and all are checked.
  const allSubsChecked   = hasCheckboxSubs && !hasUnchecked(item.item.subs);
  // Red: has unchecked checkboxes but none are tracked as a kanban card.
  const hasUnmanagedWork = hasCheckboxSubs && hasUnchecked(item.item.subs) && !hasActiveKanban(item.item.subs);

  function renderSub(sub: any, depth: number): string {
    const parentTag =
      item.item.tags.find((t: string) => normalizeTag(t) === currentNorm) || "";
    const hasCheckbox = /^- \[[ xX]\] /.test(sub.text);
    const alreadyTagged = extractTags(sub.text).some((t: string) =>
      config.normKanban.includes(normalizeTag(t))
    );
    let subText = sub.text
      .replace(/%% @\d+\w %%/g, "")
      .trim()
      .split(/\s+/)
      .filter((w: string) => !config.normKanban.includes(normalizeTag(w)))
      .join(" ")
      .trim();
    const indent = "&nbsp;".repeat(depth * 3);
    const rendered = renderCheckbox(subText, {
      isSub: true,
      showCheckbox: hasCheckbox,
      vaultName,
      enablePromotion: hasCheckbox && !alreadyTagged,
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
         </details>
       </div>`
    : `<div class="card-title" style="padding:6px 0;font-weight:600;color:var(--kb-text);">${mainContent}</div>`;

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

  return `<div draggable="true" class="kanban-card"
    data-file="${item.filePath}"
    data-line="${item.item.line}"
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

function buildColorCSS(config: KanbanConfig): string {
  const cv = (val: string, fb: string) => (val && val.trim()) ? val.trim() : fb;
  const perColRules = Object.entries(config.columnColors)
    .filter(([, c]) => c)
    .map(([norm, color]) => `
      #kanban-wrapper [data-col-container="${norm}"]{background:${color};}
      #kanban-wrapper [data-col-norm="${norm}"]{background:${color};color:var(--text-normal);}
      #kanban-wrapper [data-col-norm="${norm}"][data-col-active="1"]{background:color-mix(in srgb,${color} 75%,black);color:var(--text-normal);}
    `).join("");
  return `
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
      color:var(--kb-text);
    }
    #kanban-wrapper [data-col-container]{background:var(--kb-col-bg);}
    #kanban-wrapper [data-col-norm]{background:var(--kb-col-bg);color:var(--kb-text);}
    #kanban-wrapper [data-col-norm][data-col-active="1"]{background:var(--kb-accent);color:var(--text-on-accent);font-weight:600;}
    #kanban-wrapper .kanban-card,.card-title{color:var(--kb-text);}
    ${perColRules}`;
}

export function refreshColorVars(config: KanbanConfig): void {
  const el = document.getElementById("kanban-color-vars") as HTMLStyleElement | null;
  if (el) el.textContent = buildColorCSS(config);
}

export async function buildBoard(
  app: App,
  containerEl: HTMLElement,
  config: KanbanConfig,
  savedActiveCol?: string | null
): Promise<void> {
  const vaultName = app.vault.getName();

  // Auto-move past/undated "later" items → default column
  const paths = await getTargetFilePaths(app, config);
  let items = await collectItems(app, paths, config);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const laterToMove = items.filter(
    (i) =>
      i.item.tags.some((t: string) => normalizeTag(t) === config.normLater) &&
      (() => {
        const d = parseCardDate(i.item.text);
        return !d || d <= today;
      })()
  );
  if (laterToMove.length) {
    for (const item of laterToMove)
      await moveToColumn(
        app,
        item.filePath,
        item.item.line,
        item.item.tags,
        config.todayColumn,
        false,
        config
      );
    items = await collectItems(app, paths, config);
  }

  const columns = groupByColumns(items, config);
  await assignInitialOrders(app, columns, config);

  // Color vars — updated live via refreshColorVars() without a full re-render
  let _colorCss = document.getElementById("kanban-color-vars");
  if (!_colorCss) { _colorCss = document.createElement("style"); _colorCss.id = "kanban-color-vars"; document.head.appendChild(_colorCss); }
  (_colorCss as HTMLStyleElement).textContent = buildColorCSS(config);

  // Static styles — updated only on board build
  let _css = document.getElementById("kanban-board-styles");
  if (!_css) { _css = document.createElement("style"); _css.id = "kanban-board-styles"; document.head.appendChild(_css); }
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

  const isPhone = /iPhone|iPod|(Android.*Mobile)/i.test(navigator.userAgent);
  const isNarrow =
    isPhone ||
    (wrapper.clientWidth > 0
      ? wrapper.clientWidth < 700
      : window.innerWidth < 700);
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
    }
  }

  const colKeys = isNarrow ? [activeNorm] : allNorms;

  for (const norm of colKeys) {
    const col = columns[norm];
    if (!col) continue;

    const colStyle = isNarrow
      ? `width:calc(100% - 16px);margin:0 8px 20px;padding:10px;`
      : `flex:1;min-width:200px;max-width:260px;padding:10px 0 10px 0;margin:0;display:flex;flex-direction:column;`;
    const colDiv = scroll.createEl("div", { attr: { style: colStyle, "data-col-container": norm } });

    const header = colDiv.createEl("div", {
      attr: { style: "display:flex;align-items:center;margin-bottom:10px;padding:0 4px;" },
    });
    header.createEl("h4", {
      text: col.rawTag.replace(/^#/, "").toUpperCase(),
      attr: { style: "margin:0;flex-grow:1;font-weight:bold;color:var(--kb-text);" },
    });

    if (norm !== config.normDone) {
      const btn = header.createEl("button", {
        text: "+",
        attr: {
          style:
            "width:24px;height:24px;border-radius:50%;border:1px solid var(--background-modifier-border);background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;",
        },
      });
      (btn as HTMLButtonElement).dataset.column = norm;
      (btn as HTMLButtonElement).dataset.tag = col.rawTag;
    } else {
      const btn = header.createEl("button", {
        text: "Archive",
        attr: { style: "background:none;border:none;cursor:pointer;color:var(--kb-text);" },
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
      const s = document.createElement("div");
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
  const vaultName = app.vault.getName();
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
          subsHasLine(JSON.parse(o.dataset.subs || "[]"), tpLine)
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
        if (subsHasLine(subs, parseInt(other.dataset.line!, 10))) {
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

    const isDone = targetNorm === config.normDone;
    const newState: "expanded" | "collapsed" = [
      config.normDone,
      config.normLater,
    ].includes(targetNorm)
      ? "collapsed"
      : "expanded";
    const siblings = zone ? siblingDataFrom(zone) : [];
    const insertIdx = zone ? currentInsertIndex : siblings.length;
    const isMulti = card.originalTags
      .map(normalizeTag)
      .filter((t: string) => config.normKanban.includes(t)).length > 1;
    const newCalc = calcInsertOrder(siblings, insertIdx, isMulti);
    const colTitle = targetTag
      .replace(/^#/, "")
      .replace(/\b\w/g, (l: string) => l.toUpperCase());

    if (targetNorm === config.normLater) {
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
            newState
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
    await writeFileLines(app, tFile, lines);
    refresh();
  }

  // ── Inline card text editing ──
  async function onDblClick(e: MouseEvent) {
    if ((e.target as Element).closest("a,button,.promote-icon,.demote-btn")) return;
    const titleDiv = (e.target as Element).closest(".card-title") as HTMLElement | null;
    if (!titleDiv) return;
    const card = titleDiv.closest(".kanban-card") as HTMLElement | null;
    if (!card) return;
    if (titleDiv.querySelector(".card-edit-input")) return;

    const raw = card.dataset.raw || "";
    const filePath = card.dataset.file!;
    const lineNum = parseInt(card.dataset.line!, 10);

    const savedHTML = titleDiv.innerHTML;

    const input = document.createElement("input");
    input.type = "text";
    input.value = raw;
    input.className = "card-edit-input";
    input.style.cssText = `
      width:100%;box-sizing:border-box;
      background:var(--background-primary);
      color:var(--text-normal);
      border:none;border-bottom:2px solid var(--kb-accent);
      outline:none;padding:2px 0;font-size:inherit;font-weight:600;
      font-family:inherit;border-radius:0;`;

    card.setAttribute("draggable", "false");
    const arrow = titleDiv.querySelector<HTMLElement>("span[style*='position:absolute']");
    titleDiv.innerHTML = "";
    titleDiv.appendChild(input);
    if (arrow) titleDiv.appendChild(arrow);
    titleDiv.onclick = null;

    const finishEdit = async (save: boolean) => {
      if (!titleDiv.contains(input)) return;
      const newText = input.value.trim();
      card.setAttribute("draggable", "true");
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
    input.addEventListener("blur", () => finishEdit(true));
    input.addEventListener("dblclick", (e) => e.stopPropagation());
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
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

  // ── Mouse drag ──
  function onDragStart(e: DragEvent) {
    const card = (e.target as Element).closest(".kanban-card") as HTMLElement | null;
    if (!card) return;
    draggedCard = cardDataFrom(card);
    card.style.opacity = ".5";
    e.dataTransfer!.effectAllowed = "move";
    applyHighlights(card);
  }
  function onDragEnd(e: DragEvent) {
    draggedCard = null;
    const card = (e.target as Element).closest(".kanban-card") as HTMLElement | null;
    if (card) card.style.opacity = "1";
    document.querySelectorAll<HTMLElement>(".insert-slot").forEach(
      (s) => (s.style.borderTopColor = "transparent")
    );
    clearHighlights();
  }
  function onDragOver(e: DragEvent) {
    e.preventDefault();
    const zone = (e.target as Element).closest(".drop-zone") as HTMLElement | null;
    if (!zone) return;
    e.dataTransfer!.dropEffect = "move";
    zone.style.borderColor = "var(--kb-accent)";
    highlightNearestSlot(zone, e.clientY);
  }
  function onDragLeave(e: DragEvent) {
    const zone = (e.target as Element).closest(".drop-zone") as HTMLElement | null;
    if (zone) zone.style.borderColor = "var(--background-modifier-border)";
    document.querySelectorAll<HTMLElement>(".insert-slot").forEach(
      (s) => (s.style.borderTopColor = "transparent")
    );
  }
  async function onDrop(e: DragEvent) {
    e.preventDefault();
    if (!draggedCard) return;
    const zone = (e.target as Element).closest(".drop-zone") as HTMLElement | null;
    if (!zone) return;
    const norm = resolveTargetNorm(zone);
    if (norm) await doMove(draggedCard, norm, zone);
  }

  // ── Touch interaction ──
  let touchCard: HTMLElement | null = null;
  let ghost: HTMLElement | null = null;
  let isTouchDrag = false;
  let touchTimer: ReturnType<typeof setTimeout> | null = null;
  let selectedCard: HTMLElement | null = null;
  const HOLD_DELAY = 450,
    DRAG_DELAY = 450,
    MOVE_THRESHOLD = 8;
  let touchStartX = 0,
    touchStartY = 0;

  const isNarrowNow = () => {
    const w = document.getElementById("kanban-wrapper");
    return w ? w.dataset.narrow === "1" : false;
  };

  const clearSelection = () => {
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

  const clearTouch = () => {
    if (touchTimer) clearTimeout(touchTimer);
    isTouchDrag = false;
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

  const makeGhost = (card: HTMLElement) => {
    const rect = card.getBoundingClientRect();
    const g = card.cloneNode(true) as HTMLElement;
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
    document.body.appendChild(g);
    return g;
  };

  const targetFromPoint = (x: number, y: number) => {
    if (ghost) ghost.style.display = "none";
    const el = document.elementFromPoint(x, y);
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
    if ((e.target as Element).closest("button,a,.promote-icon,.demote-btn")) return;

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
          boardEl.querySelectorAll<HTMLElement>("[data-col-norm]").forEach((t) => {
            if (t.dataset.colActive !== "1") {
              const cc = config.columnColors[t.dataset.colNorm || ""] || "";
              t.style.background = cc
                ? `color-mix(in srgb,${cc} 85%,var(--kb-accent))`
                : `color-mix(in srgb,var(--kb-accent) 15%,var(--kb-col-bg))`;
            }
            t.style.outline = "1px dashed var(--kb-accent)";
          });
        }
      }, HOLD_DELAY);
    } else {
      if (!card) return;
      touchCard = card;
      draggedCard = cardDataFrom(card);
      touchTimer = setTimeout(() => {
        if (!isTouchDrag) {
          isTouchDrag = true;
          ghost = makeGhost(card);
          card.style.opacity = ".35";
        }
      }, DRAG_DELAY);
    }
  }

  function onTouchMove(e: TouchEvent) {
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
    const { clientX, clientY } = e.changedTouches[0];

    if (isNarrowNow()) {
      const tappedTab = document
        .elementFromPoint(clientX, clientY)
        ?.closest("[data-col-norm]") as HTMLElement | null;

      if (selectedCard && tappedTab) {
        const tabNorm = tappedTab.dataset.colNorm!;
        const savedCard = draggedCard;
        clearSelection();
        touchCard = null;
        currentInsertIndex = -1;
        await doMove(savedCard, tabNorm, null);
        e.preventDefault();
        return;
      }

      if (selectedCard && !tappedTab) {
        clearSelection();
        touchCard = null;
        e.preventDefault();
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
    clearTouch();
    if (zone) {
      const norm = resolveTargetNorm(zone);
      if (norm) await doMove(savedCard, norm, zone);
    } else if (tabNorm) {
      await doMove(savedCard, tabNorm, null);
    }
    e.preventDefault();
  }

  // ── Phone column tabs ──
  function onTabClick(e: MouseEvent) {
    if (selectedCard) return;
    const tab = (e.target as Element).closest("button[data-col-norm]") as HTMLElement | null;
    if (!tab) return;
    const wrapper = document.getElementById("kanban-wrapper");
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
      showLaterAddDialog(title, isProject, async (text: string, dateStr: string, createDoc: boolean) => {
        if (await addNewItem(app, config.newTaskInsert, tag, text, dateStr, config, createDoc))
          requestAnimationFrame(() => setTimeout(refresh, 50));
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

    let count = 0;
    for (const card of Array.from(zone.querySelectorAll<HTMLElement>(".kanban-card"))) {
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

  // Attach all listeners
  boardEl.addEventListener("mouseover", onMouseOver);
  boardEl.addEventListener("mouseout", onMouseOut);
  boardEl.addEventListener("click", onSubCheckClick);
  boardEl.addEventListener("click", onCardClick);
  boardEl.addEventListener("click", onPromoteClick);
  boardEl.addEventListener("click", onDemoteClick);
  boardEl.addEventListener("click", onTabClick);
  boardEl.addEventListener("click", onAddClick);
  boardEl.addEventListener("click", onArchiveClick);
  boardEl.addEventListener("dblclick", onDblClick);
  boardEl.addEventListener("toggle", onToggle, true);
  boardEl.addEventListener("dragstart", onDragStart);
  boardEl.addEventListener("dragend", onDragEnd);
  boardEl.addEventListener("dragover", onDragOver);
  boardEl.addEventListener("dragleave", onDragLeave);
  boardEl.addEventListener("drop", onDrop);
  boardEl.addEventListener("touchstart", onTouchStart as unknown as EventListener, { passive: true });
  boardEl.addEventListener("touchmove", onTouchMove as unknown as EventListener, { passive: false });
  boardEl.addEventListener("touchend", onTouchEnd as unknown as EventListener, { passive: false });
  boardEl.addEventListener("touchcancel", clearTouch, { passive: true });

  return () => {
    boardEl.removeEventListener("mouseover", onMouseOver);
    boardEl.removeEventListener("mouseout", onMouseOut);
    boardEl.removeEventListener("click", onSubCheckClick);
    boardEl.removeEventListener("click", onCardClick);
    boardEl.removeEventListener("click", onPromoteClick);
    boardEl.removeEventListener("click", onDemoteClick);
    boardEl.removeEventListener("click", onTabClick);
    boardEl.removeEventListener("click", onAddClick);
    boardEl.removeEventListener("click", onArchiveClick);
    boardEl.removeEventListener("dblclick", onDblClick);
    boardEl.removeEventListener("toggle", onToggle, true);
    boardEl.removeEventListener("dragstart", onDragStart);
    boardEl.removeEventListener("dragend", onDragEnd);
    boardEl.removeEventListener("dragover", onDragOver);
    boardEl.removeEventListener("dragleave", onDragLeave);
    boardEl.removeEventListener("drop", onDrop);
    boardEl.removeEventListener("touchstart", onTouchStart as unknown as EventListener);
    boardEl.removeEventListener("touchmove", onTouchMove as unknown as EventListener);
    boardEl.removeEventListener("touchend", onTouchEnd as unknown as EventListener);
    boardEl.removeEventListener("touchcancel", clearTouch);
  };
}
