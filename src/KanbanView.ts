import { ItemView, Scope, WorkspaceLeaf } from "obsidian";
import KanbanPlugin from "./main";
import {
  buildConfig,
  validateConfig,
  buildBoard,
  attachListeners,
  isNarrowLayout,
  noteBoardLeft,
  expireLastExpandedIfStale,
  collapseAllCards,
} from "./kanban";

export const VIEW_TYPE_KANBAN = "kanban-board-view";

export class KanbanView extends ItemView {
  plugin: KanbanPlugin;
  private isRefreshing = false;
  private refreshPending = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private midnightTimer: ReturnType<typeof setTimeout> | null = null;
  private listenerCleanup: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Tracks whether this leaf was the active one as of the last
  // active-leaf-change, so the transition away from it (not just any
  // unrelated leaf change elsewhere) can be stamped exactly once — see
  // noteBoardLeft/expireLastExpandedIfStale.
  private wasActive = false;
  // Pushed onto Obsidian's global keymap only while this leaf is the active
  // one — see pushBoardScope/popBoardScope — so a bare Escape is intercepted
  // on the board itself (previously it fell through to Obsidian's own
  // handling instead of doing anything useful here) without stealing Escape
  // from other leaves. A dialog opened from the board pushes its own Scope
  // on top of this one (see makeOverlay in kanban.ts), so its Escape
  // naturally takes priority while it's open.
  private boardScope: Scope | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: KanbanPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_KANBAN;
  }

  getDisplayText(): string {
    return "Kanban Board";
  }

  getIcon(): string {
    return "layout-kanban";
  }

  async onOpen() {
    // Refresh when this leaf becomes the active view
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const isActive = leaf === this.leaf;
        if (isActive) {
          expireLastExpandedIfStale(this.plugin.settings.keepLastExpandedMinutes * 60 * 1000);
          this.scheduleRefresh(100);
          this.scrollPastSearchBar();
          this.pushBoardScope();
        } else if (this.wasActive) {
          noteBoardLeft();
          this.popBoardScope();
        }
        this.wasActive = isActive;
      })
    );
    // The leaf is typically already active by the time onOpen runs, before
    // the listener above exists to have caught that transition itself.
    this.wasActive = this.leaf === this.app.workspace.activeLeaf;
    if (this.wasActive) this.pushBoardScope();

    // Refresh just past midnight so past-due #later cards auto-move
    this.scheduleMidnightRefresh();

    // Re-render when the pane/window is resized across the single/multi column breakpoint
    this.resizeObserver = new ResizeObserver(() => this.scheduleResizeCheck());
    this.resizeObserver.observe(this.contentEl);

    await this.renderBoard();
    this.scrollPastSearchBar();
  }

  // Scrolls the filter row out of view on activation so the board columns start
  // at the top; the user scrolls up to reveal the filter box when they need it.
  private scrollPastSearchBar() {
    const scroll = this.contentEl.querySelector<HTMLElement>("#kanban-scroll");
    if (!scroll) return;
    const offset =
      scroll.getBoundingClientRect().top -
      this.contentEl.getBoundingClientRect().top +
      this.contentEl.scrollTop;
    this.contentEl.scrollTop = offset;
  }

  // Inverse of scrollPastSearchBar — reveals and focuses the filter box.
  // Reachable via the board Scope's Mod+F binding below and via the plugin's
  // "Focus search" command (see main.ts, kept mainly for the Command
  // Palette and mobile, where there's no physical Mod+F to press).
  focusSearchBar() {
    this.contentEl.scrollTop = 0;
    this.contentEl.querySelector<HTMLInputElement>("#kb-search-input")?.focus();
  }

  private pushBoardScope() {
    if (this.boardScope) return;
    const scope = new Scope();
    scope.register([], "Escape", () => {
      this.handleBoardEscape();
      return false;
    });
    // Registered directly on the Scope rather than left to a Command's
    // declared default hotkey — Obsidian doesn't reliably auto-bind a
    // default that conflicts with an existing one (Mod+F almost certainly
    // already belongs to Obsidian's own in-editor search), so a plain
    // addCommand({hotkeys: [...]}) silently did nothing here. The Scope
    // takes priority while it's on top of the stack, the same way it
    // already does for Escape above.
    scope.register(["Mod"], "F", () => {
      this.focusSearchBar();
      return false;
    });
    this.boardScope = scope;
    this.app.keymap.pushScope(scope);
  }

  private popBoardScope() {
    if (!this.boardScope) return;
    this.app.keymap.popScope(this.boardScope);
    this.boardScope = null;
  }

  // Bare Escape on the board itself (no dialog open — a dialog's own Scope,
  // pushed on top of this one, would have already handled Escape as a
  // cancel): collapse every expanded card and scroll the filter row back out
  // of view, same as first landing on the board.
  private handleBoardEscape() {
    const boardEl = this.contentEl.querySelector<HTMLElement>("#kanban-wrapper");
    if (boardEl) collapseAllCards(boardEl);
    this.scrollPastSearchBar();
  }

  async onClose() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.midnightTimer) clearTimeout(this.midnightTimer);
    if (this.resizeDebounceTimer) clearTimeout(this.resizeDebounceTimer);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.listenerCleanup?.();
    this.popBoardScope();
  }

  // Called from action handlers (promote, demote, archive, drop) to force an immediate re-render.
  async refresh() {
    await this.renderBoard();
  }


  private scheduleMidnightRefresh() {
    if (this.midnightTimer) clearTimeout(this.midnightTimer);
    const now = new Date();
    // 5 seconds past the next midnight
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    this.midnightTimer = setTimeout(() => {
      this.renderBoard();
      this.scheduleMidnightRefresh();
    }, next.getTime() - now.getTime());
  }

  private scheduleRefresh(delay: number) {
    // A render already in flight will pick this up itself (see renderBoard's
    // own refreshPending queue) — returning here without setting that flag
    // would otherwise drop this request on the floor entirely.
    if (this.isRefreshing) {
      this.refreshPending = true;
      return;
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.renderBoard(), delay);
  }

  // Debounce resize events, then re-render only if single/multi column mode actually needs to change
  private scheduleResizeCheck() {
    if (this.resizeDebounceTimer) clearTimeout(this.resizeDebounceTimer);
    this.resizeDebounceTimer = setTimeout(() => {
      const wrapper = this.contentEl.querySelector<HTMLElement>("#kanban-wrapper");
      if (!wrapper) return;
      const width = wrapper.clientWidth > 0 ? wrapper.clientWidth : this.contentEl.clientWidth;
      const shouldBeNarrow = isNarrowLayout(width);
      const isCurrentlyNarrow = wrapper.dataset.narrow === "1";
      if (shouldBeNarrow !== isCurrentlyNarrow) this.scheduleRefresh(0);
    }, 150);
  }

  async renderBoard() {
    // A render already in flight (buildBoard does several vault-wide passes,
    // so this can take a while) must not silently swallow this request — queue
    // one follow-up render for when it finishes, so an action's own post-write
    // refresh (e.g. after a drag-and-drop move) is never lost.
    if (this.isRefreshing) {
      this.refreshPending = true;
      return;
    }
    this.isRefreshing = true;

    const container = this.contentEl;

    // Preserve active column selection across re-renders
    const savedActiveCol = container.querySelector<HTMLElement>("#kanban-wrapper")?.dataset.activeCol ?? null;

    // Remove previous event listeners before reconciling the DOM
    this.listenerCleanup?.();
    this.listenerCleanup = null;

    try {
      const error = validateConfig(this.plugin.settings);
      if (error) {
        container.empty();
        this.renderError(container, error);
        return;
      }

      // buildBoard reconciles against an existing #kanban-wrapper rather than
      // rebuilding from scratch (that's what avoids the flash on every
      // action) — only clear the container when there's nothing to reconcile
      // against (first render, or recovering from a previous error state).
      if (!container.querySelector("#kanban-wrapper")) container.empty();

      const config = buildConfig(this.plugin.settings);
      await buildBoard(this.app, container, config, savedActiveCol);
      this.ensureStatsLink(container);

      const boardEl = container.querySelector<HTMLElement>("#kanban-wrapper");
      if (boardEl) {
        this.listenerCleanup = attachListeners(
          boardEl,
          config,
          this.app,
          () => this.renderBoard()
        );
      }
    } catch (e: any) {
      console.error("Kanban render error:", e);
      container.empty();
      this.renderError(container, e.message ?? String(e));
    } finally {
      this.isRefreshing = false;
      if (this.refreshPending) {
        this.refreshPending = false;
        this.renderBoard();
      }
    }
  }

  // Small, idempotent link to the companion "Kanban Statistics" view —
  // appended once into the search bar (after the Clear button) so it sits
  // in the same row as the filter box, and left alone on later renders
  // since #kb-search-bar itself is only built once.
  private ensureStatsLink(container: HTMLElement) {
    const searchBar = container.querySelector<HTMLElement>("#kb-search-bar");
    if (!searchBar || searchBar.querySelector("#kb-nav-links")) return;
    const link = searchBar.createEl("a", {
      text: "Statistics",
      attr: { id: "kb-nav-links" },
    });
    link.style.cssText =
      "font-size:.9em;color:var(--kb-text);text-decoration:underline dotted;cursor:pointer;white-space:nowrap;";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      this.plugin.activateStatsView();
    });
  }

  private renderError(container: HTMLElement, message: string) {
    container.createEl("h3", { text: "Kanban Configuration Error" });
    container.createEl("p", { text: message });
    container.createEl("p", {
      text: "Open Settings → Kanban Board to configure the plugin.",
    });
    container.createEl("pre", {
      text: `Example settings:
  Kanban columns: #todo, #inprogress, #later, #done
  Done column:    #done
  Default column: #todo
  Later column:   #later
  New task insert: Tasks`,
    });
  }
}
