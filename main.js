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
    todayColumn: settings.todayColumn,
    laterColumn: settings.laterColumn,
    newTaskInsert: settings.newTaskInsert,
    normKanban,
    normDone: normalizeTag(settings.doneColumn),
    normToday: normalizeTag(settings.todayColumn),
    normLater: normalizeTag(settings.laterColumn),
    allChildrenDoneColor: settings.allChildrenDoneColor,
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
    colorFamilySibling: settings.colorFamilySibling || "#4a90d9"
  };
}
function validateConfig(settings) {
  const normKanban = settings.kanban.map(normalizeTag);
  const normDone = normalizeTag(settings.doneColumn);
  const normToday = normalizeTag(settings.todayColumn);
  const normLater = normalizeTag(settings.laterColumn);
  if (!settings.kanban.length)
    return "Missing/empty 'Kanban columns' setting.";
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
  const order = parseFloat("0." + m[1]);
  return order > 0 && order < 1 ? { order, digits: m[1], state, len: m[1].length } : null;
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
  rest = rest.replace(/\s*%%[\s\S]*?%%/g, "").trim();
  let date = null;
  const dm = rest.match(/(^|\s)(@\d{4}-\d{2}-\d{2})\b/);
  if (dm)
    date = dm[2];
  rest = rest.replace(/\s*(?:^|\s)@\d{4}-\d{2}-\d{2}\b/g, "").trim();
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
  return { indent, bullet, checked, text, tags, date, orderDigits, orderState };
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
  if (t.orderDigits && t.orderState !== null) {
    parts.push(`%% @${t.orderDigits}${t.orderState === "expanded" ? "x" : "c"} %%`);
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
function calcMidDigits(prev, next, isEnd) {
  const l = Math.max(prev.len || 1, next?.len || 1);
  const a = BigInt(prev.digits.padEnd(l, "0"));
  const b = isEnd ? 10n ** BigInt(l) : BigInt((next.digits || "0").padEnd(l, "0"));
  const sum = a + b;
  const mid = sum / 2n;
  if (sum % 2n === 0n) {
    return {
      order: parseFloat("0." + mid.toString().padStart(l, "0")),
      digits: mid.toString().padStart(l, "0"),
      len: l
    };
  }
  const digs = (mid * 10n + 5n).toString().padStart(l + 1, "0");
  return { order: parseFloat("0." + digs), digits: digs, len: l + 1 };
}
function calcInsertOrder(siblingData, insertIndex, isMulti = false) {
  const n = siblingData.length;
  if (insertIndex === 0 || isMulti) {
    return n === 0 ? { order: 0.5, digits: "5", len: 1 } : calcMidDigits({ digits: "0", len: 1, order: 0 }, siblingData[0], false);
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
function getNextMonday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const diff = (8 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d;
}
function getDefaultDate(existing = null) {
  if (!(existing instanceof Date) || isNaN(existing.getTime()))
    return getNextMonday();
  const c = new Date(existing);
  c.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return c <= today ? getNextMonday() : c;
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
  text = text.replace(/(?<!href=")https?:\/\/[^\s<>"]+/g, (url) => {
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
    parentOrder = null
  } = opts;
  let content = text.trim();
  let cbHtml = "";
  if (/^- \[[ xX]\] /.test(content)) {
    const checked = content[3] !== " ";
    content = content.slice(6);
    cbHtml = showCheckbox ? `<input type="checkbox" disabled${checked ? " checked" : ""} style="margin-right:5px;">` : "";
  } else if (/^[-*+]\s+/.test(content)) {
    content = content.replace(/^[-*+]\s+/, "");
    cbHtml = showCheckbox ? `<input type="checkbox" disabled style="margin-right:5px;">` : "\u2022 ";
  }
  if (vaultName)
    content = linksToHtml(content, vaultName);
  const promoteHtml = enablePromotion && isSub && subLine && parentTag && parentOrder !== null ? `<span class="promote-icon" style="margin-left:6px;font-size:1.2em;cursor:pointer;color:var(--kb-accent);"
           data-line="${subLine}" data-parent-tag="${parentTag}" data-parent-order="${parentOrder}">&#9655</span>` : "";
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
async function moveToColumn(app, filePath, lineNum, originalTags, targetTag, isDone, config, dateStrToAppend = null, newDigits = null, newState = null) {
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
    if (parsed.checked !== null)
      parsed.checked = isDone;
    if (dateStrToAppend)
      parsed.date = dateStrToAppend;
    if (newDigits !== null) {
      parsed.orderDigits = newDigits;
      parsed.orderState = newState ?? ([config.normDone, config.normLater].includes(normalizeTag(targetTag)) ? "collapsed" : "expanded");
    }
    lines[idx] = serializeTaskLine(parsed);
    await writeFileLines(app, tFile, lines);
    return true;
  } catch (e) {
    console.error("moveToColumn failed:", e);
    return false;
  }
}
async function addNewItem(app, rawInsertTarget, columnTag, userText, dateStr, config) {
  try {
    if (!userText?.trim())
      return false;
    let [notePath, heading = ""] = rawInsertTarget.trim().split("#");
    if (!notePath.endsWith(".md"))
      notePath += ".md";
    let tFile = app.vault.getAbstractFileByPath(notePath);
    if (!tFile) {
      tFile = await app.vault.create(notePath, "");
    }
    const lines = (await app.vault.read(tFile)).split("\n");
    let yamlEnd = 0;
    if (lines[0]?.trim() === "---") {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === "---") {
          yamlEnd = i + 1;
          break;
        }
      }
    }
    let insertIdx = yamlEnd;
    if (heading) {
      const hi = lines.findIndex(
        (l, i) => i >= yamlEnd && l.trim().startsWith("#") && l.replace(/^#{1,6}\s+/, "") === heading
      );
      if (hi === -1) {
        lines.splice(insertIdx, 0, `## ${heading}`);
        insertIdx++;
      } else {
        insertIdx = hi + 1;
      }
    }
    let newLine = `- [ ] ${userText.trim()} ${columnTag}`;
    if (dateStr)
      newLine += ` ${dateStr}`;
    lines.splice(insertIdx, 0, newLine);
    await app.vault.modify(tFile, lines.join("\n"));
    new import_obsidian.Notice(`Added "${userText}" to ${columnTag.replace(/^#/, "").toUpperCase()}.`);
    return true;
  } catch (e) {
    console.error("addNewItem failed:", e);
    new import_obsidian.Notice(`Failed to add item: ${e.message}`);
    return false;
  }
}
async function archiveToSection(app, filePath, mainLineNum, subLines, config, _isTopLevel = true) {
  try {
    let archiveLine = function(idx, tickBox) {
      if (idx < 0 || idx >= lines.length)
        return;
      const parsed = parseTaskLine(lines[idx]);
      if (tickBox && parsed.checked !== null)
        parsed.checked = true;
      parsed.tags = parsed.tags.filter((t) => !config.normKanban.includes(normalizeTag(t)));
      parsed.orderDigits = null;
      parsed.orderState = null;
      lines[idx] = serializeTaskLine(parsed);
    };
    const { tFile, lines } = await readFileLines(app, filePath);
    archiveLine(mainLineNum - 1, true);
    const recurse = (subs) => {
      for (const sub of subs) {
        archiveLine(sub.line - 1, false);
        if (sub.subs?.length)
          recurse(sub.subs);
      }
    };
    recurse(subLines);
    await writeFileLines(app, tFile, lines);
    return true;
  } catch (e) {
    console.error("archiveToSection failed:", e);
    return false;
  }
}
async function promoteSubToChild(app, filePath, subLineNum, parentTag, parentOrder, config, refresh) {
  try {
    const normParent = normalizeTag(parentTag);
    const targetPaths = await getTargetFilePaths(app, config);
    const allItems = await collectItems(app, targetPaths, config);
    const columns = groupByColumns(allItems, config);
    const parentCard = (columns[normParent]?.cards || []).find((c) => c.order !== null && Math.abs(c.order - parentOrder) < 1e-10);
    const prevSibling = parentCard ? { digits: parentCard.digits || "0", len: parentCard.len || 1, order: parentOrder } : { digits: parentOrder.toString().split(".")[1] || "0", len: (parentOrder.toString().split(".")[1] || "0").length, order: parentOrder };
    const higher = (columns[normParent]?.cards || []).filter((c) => c.order !== null && c.order > parentOrder).sort((a, b) => a.order - b.order);
    let newCalc;
    if (higher.length) {
      newCalc = calcMidDigits(prevSibling, higher[0], false);
    } else {
      const fallback = Math.min(0.999, parentOrder + 0.1);
      newCalc = { digits: fallback.toFixed(Math.max(prevSibling.len, 3)).split(".")[1], len: Math.max(prevSibling.len, 3) };
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
            order: parsed2?.order ?? null,
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
        order: parsed?.order ?? null,
        state: parsed?.state ?? "collapsed",
        digits: parsed?.digits ?? null,
        len: parsed?.len ?? null,
        isPromoted: ownTags.some(
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
  const cmp = (a, b) => {
    const oa = a.order ?? 999, ob = b.order ?? 999;
    return Math.abs(oa - ob) < 1e-10 ? (a.discoveryIndex || 0) - (b.discoveryIndex || 0) : oa - ob;
  };
  Object.values(columns).forEach((col) => col.cards.sort(cmp));
  return columns;
}
async function assignInitialOrders(app, columns, config) {
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
        (c) => `${c.filePath}:${c.item.line}` === key ? { ...c, order: 0, digits: "0" } : c
      );
    }
  }
  for (const col of Object.values(columns)) {
    const ordered = col.cards.filter(
      (c) => c.order !== null && !c.multiTag
    );
    const unordered = col.cards.filter((c) => c.order === null && !c.multiTag).sort((a, b) => a.discoveryIndex - b.discoveryIndex);
    if (!unordered.length)
      continue;
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
    const cmp = (a, b) => (a.order ?? 999) - (b.order ?? 999) || (a.discoveryIndex || 0) - (b.discoveryIndex || 0);
    col.cards.sort(cmp);
  }
}
function makeOverlay(id) {
  document.getElementById(id)?.remove();
  const overlay = document.createElement("div");
  overlay.id = id;
  overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;";
  document.body.appendChild(overlay);
  const dialog = document.createElement("div");
  dialog.style.cssText = "background:var(--background-primary);color:var(--text-normal);padding:20px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:300px;max-width:400px;text-align:center;";
  overlay.appendChild(dialog);
  const close = () => overlay.remove();
  overlay.onclick = (e) => {
    if (e.target === overlay)
      close();
  };
  return { overlay, dialog, close };
}
function inputStyle() {
  return "width:100%;padding:8px;margin-bottom:10px;border:1px solid var(--background-modifier-border);border-radius:4px;box-sizing:border-box;background:var(--background-secondary);color:var(--text-normal);";
}
function buttonHtml(label, accent) {
  const bg = accent ? "var(--kb-accent)" : "var(--background-modifier-error)";
  const color = accent ? "var(--text-on-accent)" : "var(--text-normal)";
  return `<button style="padding:8px 16px;background:${bg};color:${color};border:none;border-radius:4px;cursor:pointer;">${label}</button>`;
}
function showInputDialog(title, onSubmit) {
  const { dialog, close } = makeOverlay("kanban-input-dialog");
  dialog.innerHTML = `<h3 style="margin:0 0 10px;font-size:1.1em;">${title}</h3>
    <input id="k-text" type="text" placeholder="Enter new item text..." style="${inputStyle()}" autofocus>
    <div style="display:flex;gap:10px;justify-content:center;">${buttonHtml("Add", true)}${buttonHtml("Cancel", false)}</div>`;
  const [addBtn, cancelBtn] = dialog.querySelectorAll("button");
  const input = dialog.querySelector("#k-text");
  const submit = () => {
    const v = input.value.trim();
    close();
    if (v)
      onSubmit(v);
  };
  addBtn.onclick = submit;
  cancelBtn.onclick = close;
  input.onkeydown = (e) => {
    if (e.key === "Enter")
      submit();
    if (e.key === "Escape")
      close();
  };
  input.focus();
}
function showDateDialog(title, defaultDate, onSubmit) {
  const { dialog, close } = makeOverlay("kanban-date-dialog");
  dialog.innerHTML = `<h3 style="margin:0 0 10px;font-size:1.1em;">${title}</h3>
    <input id="k-date" type="date" value="${defaultDate}" style="${inputStyle()}" autofocus>
    <div style="display:flex;gap:10px;justify-content:center;">${buttonHtml("Set", true)}${buttonHtml("Cancel", false)}</div>`;
  const [setBtn, cancelBtn] = dialog.querySelectorAll("button");
  const dateInput = dialog.querySelector("#k-date");
  const submit = () => {
    const v = dateInput.value;
    close();
    if (v)
      onSubmit("@" + v);
  };
  setBtn.onclick = submit;
  cancelBtn.onclick = close;
  dateInput.onkeydown = (e) => {
    if (e.key === "Enter")
      submit();
    if (e.key === "Escape")
      close();
  };
  dateInput.focus();
}
function showLaterAddDialog(title, onSubmit) {
  const { dialog, close } = makeOverlay("kanban-later-add-dialog");
  const defDate = getDefaultDate().toISOString().split("T")[0];
  dialog.innerHTML = `<h3 style="margin:0 0 10px;font-size:1.1em;">${title}</h3>
    <input id="k-text" type="text" placeholder="Enter new item text..." style="${inputStyle()}" autofocus>
    <input id="k-date" type="date" value="${defDate}" style="${inputStyle()}">
    <div style="display:flex;gap:10px;justify-content:center;">${buttonHtml("Add", true)}${buttonHtml("Cancel", false)}</div>`;
  const [addBtn, cancelBtn] = dialog.querySelectorAll("button");
  const textInput = dialog.querySelector("#k-text");
  const dateInput = dialog.querySelector("#k-date");
  const submit = () => {
    const t = textInput.value.trim(), d = dateInput.value;
    close();
    if (t && d)
      onSubmit(t, "@" + d);
  };
  addBtn.onclick = submit;
  cancelBtn.onclick = close;
  [textInput, dateInput].forEach((el) => {
    el.onkeydown = (e) => {
      if (e.key === "Enter")
        submit();
      if (e.key === "Escape")
        close();
    };
  });
  textInput.focus();
}
function createCardHTML(item, isMulti, currentNorm, config, vaultName) {
  let display = item.item.text;
  const tagToRemove = extractTags(display).find(
    (t) => normalizeTag(t) === currentNorm
  );
  if (tagToRemove)
    display = display.split(/\s+/).filter((w) => w !== tagToRemove).join(" ").trim();
  display = display.replace(/%% @\d+\w %%/g, "").trim();
  const rawText = display.replace(/^- \[[ xX]\] /, "").replace(/^[-*+]\s+/, "").trim();
  const mainContent = linksToHtml(rawText, vaultName);
  const hasSubs = item.item.subs.length > 0;
  const isExpanded = item.state === "expanded";
  function isCheckboxItem(s) {
    return /^[-*+]\s+\[[ xX]\]/.test((s.text ?? "").trim());
  }
  function hasActiveDescendant(subs) {
    for (const s of subs ?? []) {
      if (isCheckboxItem(s)) {
        const tags = s.tags ?? [];
        if (tags.some((t) => {
          const norm = normalizeTag(t);
          return config.normKanban.includes(norm) && norm !== config.normDone;
        }))
          return true;
      }
      if (s.subs?.length && hasActiveDescendant(s.subs))
        return true;
    }
    return false;
  }
  function hasTaskDescendant(subs) {
    for (const s of subs ?? []) {
      if (isCheckboxItem(s))
        return true;
      if (s.subs?.length && hasTaskDescendant(s.subs))
        return true;
    }
    return false;
  }
  const allChildrenDone = hasTaskDescendant(item.item.subs) && !hasActiveDescendant(item.item.subs);
  function renderSub(sub, depth) {
    const parentTag = item.item.tags.find((t) => normalizeTag(t) === currentNorm) || "";
    const hasCheckbox = /^- \[[ xX]\] /.test(sub.text);
    const alreadyTagged = extractTags(sub.text).some(
      (t) => config.normKanban.includes(normalizeTag(t))
    );
    let subText = sub.text.replace(/%% @\d+\w %%/g, "").trim().split(/\s+/).filter((w) => !config.normKanban.includes(normalizeTag(w))).join(" ").trim();
    const indent = "&nbsp;".repeat(depth * 3);
    const rendered = renderCheckbox(subText, {
      isSub: true,
      showCheckbox: hasCheckbox,
      vaultName,
      enablePromotion: hasCheckbox && !alreadyTagged,
      subLine: sub.line,
      parentTag,
      parentOrder: item.order
    });
    return `<div style="margin:4px 0;line-height:1.5;">${indent}${rendered}</div>`;
  }
  function renderSubTree(subs, depth = 0) {
    return (subs || []).map((sub) => renderSub(sub, depth) + renderSubTree(sub.subs, depth + 1)).join("");
  }
  const bodyHTML = hasSubs ? `<div style="position:relative;">
         <div class="card-title" style="padding:6px 32px 6px 0;font-weight:600;cursor:pointer;color:var(--kb-text);"
              onclick="this.closest('.kanban-card').querySelector('details').toggleAttribute('open')">
           ${mainContent}
           <span style="position:absolute;top:6px;right:8px;font-size:1.4em;color:var(--kb-accent);user-select:none;">${isExpanded ? "\u25B2" : "\u25BC"}</span>
         </div>
         <details ${isExpanded ? "open" : ""} style="margin:4px 0 0 0;">
           <summary style="display:none;"></summary>
           <div style="padding-left:8px;">${renderSubTree(item.item.subs)}</div>
         </details>
       </div>` : `<div class="card-title" style="padding:6px 0;font-weight:600;color:var(--kb-text);">${mainContent}</div>`;
  const border = isMulti ? "background:var(--background-modifier-error-hover);border:1px solid var(--background-modifier-error);" : allChildrenDone ? `border:2px solid var(--kb-children-done);background:color-mix(in srgb,var(--kb-children-done) 20%,var(--kb-card-bg));` : "border:1px solid var(--background-modifier-border);";
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
    data-subs='${JSON.stringify(item.item.subs.map((s) => ({ line: s.line, text: s.text, subs: s.subs || [] }))).replace(/'/g, "&#39;")}'
    data-is-promoted="${item.isPromoted || false}"
    style="padding:10px 14px;margin:8px 0;border-radius:10px;background:var(--kb-card-bg);color:var(--kb-text);
           box-shadow:0 2px 8px rgba(0,0,0,.12);${border};cursor:move;position:relative;">
    ${item.indent > 0 ? '<span class="demote-btn" style="position:absolute;top:4px;left:6px;font-size:0.75em;color:var(--kb-accent);line-height:1;cursor:pointer;">&#x25B6;</span>' : ""}
    ${bodyHTML}
    ${badge}
  </div>`;
}
function buildColorCSS(config) {
  const cv = (val, fb) => val && val.trim() ? val.trim() : fb;
  const perColRules = Object.entries(config.columnColors).filter(([, c]) => c).map(([norm, color]) => `
      #kanban-wrapper [data-col-container="${norm}"]{background:${color};}
      #kanban-wrapper [data-col-norm="${norm}"]{background:${color};color:var(--text-normal);}
      #kanban-wrapper [data-col-norm="${norm}"][data-col-active="1"]{background:color-mix(in srgb,${color} 75%,black);color:var(--text-normal);}
    `).join("");
  return `
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
      color:var(--kb-text);
    }
    #kanban-wrapper [data-col-container]{background:var(--kb-col-bg);}
    #kanban-wrapper [data-col-norm]{background:var(--kb-col-bg);color:var(--kb-text);}
    #kanban-wrapper [data-col-norm][data-col-active="1"]{background:var(--kb-accent);color:var(--text-on-accent);font-weight:600;}
    #kanban-wrapper .kanban-card,.card-title{color:var(--kb-text);}
    ${perColRules}`;
}
function refreshColorVars(config) {
  const el = document.getElementById("kanban-color-vars");
  if (el)
    el.textContent = buildColorCSS(config);
}
async function buildBoard(app, containerEl, config, savedActiveCol) {
  const vaultName = app.vault.getName();
  const paths = await getTargetFilePaths(app, config);
  let items = await collectItems(app, paths, config);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const laterToMove = items.filter(
    (i) => i.item.tags.some((t) => normalizeTag(t) === config.normLater) && (() => {
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
  let _colorCss = document.getElementById("kanban-color-vars");
  if (!_colorCss) {
    _colorCss = document.createElement("style");
    _colorCss.id = "kanban-color-vars";
    document.head.appendChild(_colorCss);
  }
  _colorCss.textContent = buildColorCSS(config);
  let _css = document.getElementById("kanban-board-styles");
  if (!_css) {
    _css = document.createElement("style");
    _css.id = "kanban-board-styles";
    document.head.appendChild(_css);
  }
  _css.textContent = `
      #kanban-scroll::-webkit-scrollbar{height:8px}
      .kanban-card{-webkit-user-select:none;user-select:none;touch-action:none;}
      .drop-zone{touch-action:none;}
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
  const isPhone = /iPhone|iPod|(Android.*Mobile)/i.test(navigator.userAgent);
  const isNarrow = isPhone || (wrapper.clientWidth > 0 ? wrapper.clientWidth < 700 : window.innerWidth < 700);
  wrapper.dataset.narrow = isNarrow ? "1" : "0";
  const allNorms = Object.keys(columns);
  let activeNorm = savedActiveCol && allNorms.includes(savedActiveCol) ? savedActiveCol : config.normToday;
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
    }
  }
  const colKeys = isNarrow ? [activeNorm] : allNorms;
  for (const norm of colKeys) {
    const col = columns[norm];
    if (!col)
      continue;
    const colStyle = isNarrow ? `width:calc(100% - 16px);margin:0 8px 20px;padding:10px;` : `flex:1;min-width:200px;max-width:260px;padding:10px 4px 10px 0;margin:0;display:flex;flex-direction:column;`;
    const colDiv = scroll.createEl("div", { attr: { style: colStyle, "data-col-container": norm } });
    const header = colDiv.createEl("div", {
      attr: { style: "display:flex;align-items:center;margin-bottom:10px;" }
    });
    header.createEl("h4", {
      text: col.rawTag.replace(/^#/, "").toUpperCase(),
      attr: { style: "margin:0;flex-grow:1;font-weight:bold;color:var(--kb-text);" }
    });
    if (norm !== config.normDone) {
      const btn = header.createEl("button", {
        text: "+",
        attr: {
          style: "width:24px;height:24px;border-radius:50%;border:1px solid var(--background-modifier-border);background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;"
        }
      });
      btn.dataset.column = norm;
      btn.dataset.tag = col.rawTag;
    } else {
      const btn = header.createEl("button", {
        text: "Archive",
        attr: { style: "background:none;border:none;cursor:pointer;color:var(--kb-text);" }
      });
      btn.dataset.column = norm;
    }
    const zone = colDiv.createEl("div", {
      attr: {
        class: `drop-zone drop-zone-${norm}`,
        style: "min-height:200px;border:2px dashed var(--background-modifier-border);border-radius:4px;padding:5px;flex-grow:1;display:flex;flex-direction:column;"
      }
    });
    const insertSlot = (idx) => {
      const s = document.createElement("div");
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
  const vaultName = app.vault.getName();
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
      order: parseFloat(c.dataset.order) || null,
      state: c.dataset.state,
      isPromoted: c.dataset.isPromoted === "true"
    };
  };
  const siblingDataFrom = (zone) => Array.from(zone.querySelectorAll(".kanban-card")).map((c) => {
    const ord = c.dataset.order;
    if (!ord)
      return { order: 999, digits: "99999", len: 5 };
    const dec = ord.split(".")[1] || "0";
    return { order: parseFloat(ord), digits: dec, len: dec.length };
  }).sort((a, b) => a.order - b.order);
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
  const applyHighlights = (card) => {
    clearHighlights();
    const file = card.dataset.file;
    const allCards = Array.from(boardEl.querySelectorAll(".kanban-card"));
    let topParent = card;
    for (let safety = 0; safety < 20; safety++) {
      const tpLine = parseInt(topParent.dataset.line, 10);
      const parent = allCards.find(
        (o) => o !== topParent && o.dataset.file === file && subsHasLine(JSON.parse(o.dataset.subs || "[]"), tpLine)
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
        if (subsHasLine(subs, parseInt(other.dataset.line, 10))) {
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
    const isDone = targetNorm === config.normDone;
    const newState = [
      config.normDone,
      config.normLater
    ].includes(targetNorm) ? "collapsed" : "expanded";
    const siblings = zone ? siblingDataFrom(zone) : [];
    const insertIdx = zone ? currentInsertIndex : siblings.length;
    const isMulti = card.originalTags.map(normalizeTag).filter((t) => config.normKanban.includes(t)).length > 1;
    const newCalc = calcInsertOrder(siblings, insertIdx, isMulti);
    const colTitle = targetTag.replace(/^#/, "").replace(/\b\w/g, (l) => l.toUpperCase());
    if (targetNorm === config.normLater) {
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
      if (ok)
        requestAnimationFrame(() => setTimeout(refresh, 50));
    }
    currentInsertIndex = -1;
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
      parseFloat(icon.dataset.parentOrder) || 0,
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
    await writeFileLines(app, tFile, lines);
    refresh();
  }
  async function onDblClick(e) {
    if (e.target.closest("a,button,.promote-icon,.demote-btn"))
      return;
    const titleDiv = e.target.closest(".card-title");
    if (!titleDiv)
      return;
    const card = titleDiv.closest(".kanban-card");
    if (!card)
      return;
    if (titleDiv.querySelector(".card-edit-input"))
      return;
    const raw = card.dataset.raw || "";
    const filePath = card.dataset.file;
    const lineNum = parseInt(card.dataset.line, 10);
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
      card.setAttribute("draggable", "true");
      if (card.querySelector("details")) {
        titleDiv.onclick = function() {
          this.closest(".kanban-card")?.querySelector("details")?.toggleAttribute("open");
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
    input.addEventListener("keydown", async (e2) => {
      if (e2.key === "Enter") {
        e2.preventDefault();
        await finishEdit(true);
      }
      if (e2.key === "Escape")
        await finishEdit(false);
    });
    input.addEventListener("blur", () => finishEdit(true));
    input.addEventListener("dblclick", (e2) => e2.stopPropagation());
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
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
  function onDragStart(e) {
    const card = e.target.closest(".kanban-card");
    if (!card)
      return;
    draggedCard = cardDataFrom(card);
    card.style.opacity = ".5";
    e.dataTransfer.effectAllowed = "move";
    applyHighlights(card);
  }
  function onDragEnd(e) {
    draggedCard = null;
    const card = e.target.closest(".kanban-card");
    if (card)
      card.style.opacity = "1";
    document.querySelectorAll(".insert-slot").forEach(
      (s) => s.style.borderTopColor = "transparent"
    );
    clearHighlights();
  }
  function onDragOver(e) {
    e.preventDefault();
    const zone = e.target.closest(".drop-zone");
    if (!zone)
      return;
    e.dataTransfer.dropEffect = "move";
    zone.style.borderColor = "var(--kb-accent)";
    highlightNearestSlot(zone, e.clientY);
  }
  function onDragLeave(e) {
    const zone = e.target.closest(".drop-zone");
    if (zone)
      zone.style.borderColor = "var(--background-modifier-border)";
    document.querySelectorAll(".insert-slot").forEach(
      (s) => s.style.borderTopColor = "transparent"
    );
  }
  async function onDrop(e) {
    e.preventDefault();
    if (!draggedCard)
      return;
    const zone = e.target.closest(".drop-zone");
    if (!zone)
      return;
    const norm = resolveTargetNorm(zone);
    if (norm)
      await doMove(draggedCard, norm, zone);
  }
  let touchCard = null;
  let ghost = null;
  let isTouchDrag = false;
  let touchTimer = null;
  let selectedCard = null;
  const HOLD_DELAY = 450, DRAG_DELAY = 450, MOVE_THRESHOLD = 8;
  let touchStartX = 0, touchStartY = 0;
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
    boardEl.querySelectorAll("[data-col-norm]").forEach((t) => {
      t.style.outline = "";
      t.style.transform = "";
      t.style.background = "";
    });
  };
  const clearTouch = () => {
    if (touchTimer)
      clearTimeout(touchTimer);
    isTouchDrag = false;
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
  const makeGhost = (card) => {
    const rect = card.getBoundingClientRect();
    const g = card.cloneNode(true);
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
    document.body.appendChild(g);
    return g;
  };
  const targetFromPoint = (x, y) => {
    if (ghost)
      ghost.style.display = "none";
    const el = document.elementFromPoint(x, y);
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
    if (e.target.closest("button,a,.promote-icon,.demote-btn"))
      return;
    const card = e.target.closest(".kanban-card");
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    if (isNarrowNow()) {
      const tappedTab = e.target.closest("[data-col-norm]");
      if (tappedTab && selectedCard)
        return;
      if (!card && selectedCard) {
        clearSelection();
        return;
      }
      if (!card)
        return;
      clearSelection();
      touchCard = card;
      draggedCard = cardDataFrom(card);
      touchTimer = setTimeout(() => {
        if (!selectedCard) {
          selectedCard = card;
          card.style.outline = "2px solid var(--kb-accent)";
          card.style.transform = "scale(1.02)";
          boardEl.querySelectorAll("[data-col-norm]").forEach((t) => {
            if (t.dataset.colActive !== "1") {
              const cc = config.columnColors[t.dataset.colNorm || ""] || "";
              t.style.background = cc ? `color-mix(in srgb,${cc} 85%,var(--kb-accent))` : `color-mix(in srgb,var(--kb-accent) 15%,var(--kb-col-bg))`;
            }
            t.style.outline = "1px dashed var(--kb-accent)";
          });
        }
      }, HOLD_DELAY);
    } else {
      if (!card)
        return;
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
  function onTouchMove(e) {
    if (!touchCard || e.touches.length !== 1)
      return;
    const { clientX, clientY } = e.touches[0];
    const dx = Math.abs(clientX - touchStartX);
    const dy = Math.abs(clientY - touchStartY);
    if (isNarrowNow()) {
      if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) {
        if (touchTimer)
          clearTimeout(touchTimer);
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
        const { zone: zone2 } = targetFromPoint(clientX, clientY);
        boardEl.querySelectorAll(".drop-zone").forEach(
          (z) => z.style.borderColor = "var(--background-modifier-border)"
        );
        if (zone2) {
          zone2.style.borderColor = "var(--kb-accent)";
          highlightNearestSlot(zone2, clientY);
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
        if (touchTimer)
          clearTimeout(touchTimer);
        isTouchDrag = true;
        if (!ghost)
          ghost = makeGhost(touchCard);
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
    const { clientX, clientY } = e.changedTouches[0];
    if (isNarrowNow()) {
      const tappedTab = document.elementFromPoint(clientX, clientY)?.closest("[data-col-norm]");
      if (selectedCard && tappedTab) {
        const tabNorm2 = tappedTab.dataset.colNorm;
        const savedCard2 = draggedCard;
        clearSelection();
        touchCard = null;
        currentInsertIndex = -1;
        await doMove(savedCard2, tabNorm2, null);
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
      if (norm)
        await doMove(savedCard, norm, zone);
    } else if (tabNorm) {
      await doMove(savedCard, tabNorm, null);
    }
    e.preventDefault();
  }
  function onTabClick(e) {
    if (selectedCard)
      return;
    const tab = e.target.closest("button[data-col-norm]");
    if (!tab)
      return;
    const wrapper = document.getElementById("kanban-wrapper");
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
    if (norm === config.normLater) {
      showLaterAddDialog(title, async (text, dateStr) => {
        if (await addNewItem(app, config.newTaskInsert, tag, text, dateStr, config))
          requestAnimationFrame(() => setTimeout(refresh, 50));
      });
    } else {
      showInputDialog(title, async (text) => {
        if (await addNewItem(app, config.newTaskInsert, tag, text, null, config))
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
    let count = 0;
    for (const card of Array.from(zone.querySelectorAll(".kanban-card"))) {
      let subs = [];
      try {
        subs = JSON.parse(card.dataset.subs || "[]");
      } catch {
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
    if (count) {
      new import_obsidian.Notice(`Archived ${count} items.`);
      requestAnimationFrame(() => setTimeout(refresh, 50));
    }
  }
  boardEl.addEventListener("mouseover", onMouseOver);
  boardEl.addEventListener("mouseout", onMouseOut);
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
  boardEl.addEventListener("touchstart", onTouchStart, { passive: true });
  boardEl.addEventListener("touchmove", onTouchMove, { passive: false });
  boardEl.addEventListener("touchend", onTouchEnd, { passive: false });
  boardEl.addEventListener("touchcancel", clearTouch, { passive: true });
  return () => {
    boardEl.removeEventListener("mouseover", onMouseOver);
    boardEl.removeEventListener("mouseout", onMouseOut);
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
    await this.renderBoard();
  }
  async onClose() {
    if (this.debounceTimer)
      clearTimeout(this.debounceTimer);
    if (this.midnightTimer)
      clearTimeout(this.midnightTimer);
    this.listenerCleanup?.();
  }
  // Called from action handlers (promote, demote, archive, drop) to force an immediate re-render.
  async refresh() {
    await this.renderBoard();
  }
  // Updates color CSS vars without a full re-render. Called from saveSettings().
  refreshColors() {
    refreshColorVars(buildConfig(this.plugin.settings));
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
  kanban: ["#todo", "#inprogress", "#later", "#done"],
  doneColumn: "#done",
  todayColumn: "#today",
  laterColumn: "#later",
  newTaskInsert: "Tasks",
  parentPages: [],
  allVaultNotes: true,
  allChildrenDoneColor: "#e03e3e",
  columnColors: [],
  colorCardBg: "",
  colorColumnBg: "",
  colorText: "",
  colorAccent: "",
  colorLink: "",
  colorFamilySelf: "#e03e3e",
  colorFamilyParent: "#2db55d",
  colorFamilySibling: "#4a90d9"
};
var KanbanPlugin = class extends import_obsidian3.Plugin {
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
    this.addSettingTab(new KanbanSettingTab(this.app, this));
  }
  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_KANBAN);
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.app.workspace.getLeavesOfType(VIEW_TYPE_KANBAN).forEach((leaf) => {
      leaf.view.refreshColors();
    });
  }
};
var KanbanSettingTab = class extends import_obsidian3.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Kanban Board Settings" });
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
    new import_obsidian3.Setting(containerEl).setName("Today column").setDesc("Tag for the column where past-due and undated #later tasks are moved to (e.g. #today)").addText(
      (text) => text.setPlaceholder("#today").setValue(this.plugin.settings.todayColumn).onChange(async (value) => {
        this.plugin.settings.todayColumn = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Later column").setDesc("Tag for the scheduled / later column \u2014 shows a date picker on drop").addText(
      (text) => text.setPlaceholder("#later").setValue(this.plugin.settings.laterColumn).onChange(async (value) => {
        this.plugin.settings.laterColumn = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("New task insert location").setDesc(
      'Note name (and optional heading) where the + button inserts new tasks, e.g. "Tasks" or "Tasks#Inbox"'
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
      "All children done \u2014 highlight",
      "Border color for cards whose child tasks are all done or have no task children.",
      () => this.plugin.settings.allChildrenDoneColor,
      (v) => {
        this.plugin.settings.allChildrenDoneColor = v;
      }
    );
    containerEl.createEl("h4", { text: "Per-column colors" });
    containerEl.createEl("p", {
      text: "Background color for each column and its narrow-mode tab. \u21BA removes the custom color.",
      attr: { style: "color:var(--text-muted);font-size:.85em;margin-top:-6px;" }
    });
    this.plugin.settings.kanban.forEach((tag, i) => {
      const currentColor = (this.plugin.settings.columnColors || [])[i] || "";
      new import_obsidian3.Setting(containerEl).setName(tag.replace(/^#/, "").toUpperCase()).addColorPicker(
        (cp) => cp.setValue(currentColor || "#1e1e1e").onChange(async (value) => {
          if (!this.plugin.settings.columnColors)
            this.plugin.settings.columnColors = [];
          this.plugin.settings.columnColors[i] = value;
          await this.plugin.saveSettings();
        })
      ).addExtraButton(
        (btn) => btn.setIcon("rotate-ccw").setTooltip("Remove custom color").onClick(async () => {
          if (!this.plugin.settings.columnColors)
            this.plugin.settings.columnColors = [];
          this.plugin.settings.columnColors[i] = "";
          await this.plugin.saveSettings();
          this.display();
        })
      );
    });
    new import_obsidian3.Setting(containerEl).setName("Open board").addButton(
      (btn) => btn.setButtonText("Open Kanban Board").onClick(() => {
        this.plugin.activateView();
      })
    );
  }
};
