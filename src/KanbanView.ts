import { ItemView, WorkspaceLeaf } from "obsidian";
import KanbanPlugin from "./main";
import { buildConfig, validateConfig, buildBoard, attachListeners } from "./kanban";

export const VIEW_TYPE_KANBAN = "kanban-board-view";

export class KanbanView extends ItemView {
  plugin: KanbanPlugin;
  private isRefreshing = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private listenerCleanup: (() => void) | null = null;

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
    // Vault events → debounced re-render
    // Delay is 1500 ms so a sequence of vault.modify calls (from assignInitialOrders)
    // collapses into one refresh instead of causing a blink loop.
    const schedule = () => this.scheduleRefresh(1500);
    this.registerEvent(this.app.vault.on("modify", schedule));
    this.registerEvent(this.app.vault.on("create", schedule));
    this.registerEvent(this.app.vault.on("delete", schedule));

    await this.renderBoard();
  }

  async onClose() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.listenerCleanup?.();
  }

  // Called from outside (e.g. settings tab) to force an immediate re-render.
  async refresh() {
    await this.renderBoard();
  }

  private scheduleRefresh(delay: number) {
    if (this.isRefreshing) return; // already in flight — let it finish
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.renderBoard(), delay);
  }

  async renderBoard() {
    if (this.isRefreshing) return;
    this.isRefreshing = true;

    const container = this.contentEl;

    // Preserve horizontal scroll position across re-renders
    const oldScroll = container.querySelector<HTMLElement>("#kanban-scroll");
    const scrollLeft = oldScroll?.scrollLeft ?? 0;

    // Preserve active column selection across re-renders
    const savedActiveCol = container.querySelector<HTMLElement>("#kanban-wrapper")?.dataset.activeCol ?? null;

    // Remove previous event listeners before rebuilding the DOM
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

      const boardEl = container.querySelector<HTMLElement>("#kanban-wrapper");
      if (boardEl) {
        this.listenerCleanup = attachListeners(
          boardEl,
          config,
          this.app,
          () => this.renderBoard()
        );
      }

      // Restore scroll position
      const newScroll = container.querySelector<HTMLElement>("#kanban-scroll");
      if (newScroll && scrollLeft) newScroll.scrollLeft = scrollLeft;
    } catch (e: any) {
      console.error("Kanban render error:", e);
      this.renderError(container, e.message ?? String(e));
    } finally {
      // Hold the flag for 1500 ms to absorb any vault.modify events that our own
      // order-comment writes fire, preventing an infinite refresh loop.
      setTimeout(() => {
        this.isRefreshing = false;
      }, 1500);
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
