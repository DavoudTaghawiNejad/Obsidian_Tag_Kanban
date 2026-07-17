import { ItemView, WorkspaceLeaf } from "obsidian";
import KanbanPlugin from "./main";
import { buildConfig, validateConfig, buildBoard, attachListeners, isNarrowLayout } from "./kanban";

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
        if (leaf === this.leaf) this.scheduleRefresh(100);
      })
    );

    // Refresh just past midnight so past-due #later cards auto-move
    this.scheduleMidnightRefresh();

    // Re-render when the pane/window is resized across the single/multi column breakpoint
    this.resizeObserver = new ResizeObserver(() => this.scheduleResizeCheck());
    this.resizeObserver.observe(this.contentEl);

    await this.renderBoard();
  }

  async onClose() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.midnightTimer) clearTimeout(this.midnightTimer);
    if (this.resizeDebounceTimer) clearTimeout(this.resizeDebounceTimer);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.listenerCleanup?.();
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
    if (this.isRefreshing) return;
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
