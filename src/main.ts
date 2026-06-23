import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from "obsidian";
import { KanbanView, VIEW_TYPE_KANBAN } from "./KanbanView";

export interface KanbanSettings {
  kanban: string[];
  doneColumn: string;
  todayColumn: string;
  laterColumn: string;
  newTaskInsert: string;
  parentPages: string[];
  allVaultNotes: boolean;
  allChildrenDoneColor: string;
  // Colors — empty string means "use Obsidian theme default"
  columnColors: string[];
  colorCardBg: string;
  colorColumnBg: string;
  colorText: string;
  colorAccent: string;
  colorLink: string;
  colorFamilySelf: string;
  colorFamilyParent: string;
  colorFamilySibling: string;
}

export const DEFAULT_SETTINGS: KanbanSettings = {
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
  colorFamilySibling: "#4a90d9",
};

export default class KanbanPlugin extends Plugin {
  settings!: KanbanSettings;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_KANBAN, (leaf) => new KanbanView(leaf, this));

    this.addRibbonIcon("layout-kanban", "Open Kanban Board", () =>
      this.activateView()
    );

    this.addCommand({
      id: "open-kanban-board",
      name: "Open Kanban Board",
      callback: () => this.activateView(),
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
      (leaf.view as KanbanView).refreshColors();
    });
  }
}

class KanbanSettingTab extends PluginSettingTab {
  plugin: KanbanPlugin;

  constructor(app: App, plugin: KanbanPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Kanban Board Settings" });

    new Setting(containerEl)
      .setName("Kanban columns")
      .setDesc("Comma-separated column tags, in display order (e.g. #todo, #inprogress, #later, #done)")
      .addText((text) =>
        text
          .setPlaceholder("#todo, #inprogress, #later, #done")
          .setValue(this.plugin.settings.kanban.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.kanban = value
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Done column")
      .setDesc("Tag for the done column — tasks moved here get their checkbox checked")
      .addText((text) =>
        text
          .setPlaceholder("#done")
          .setValue(this.plugin.settings.doneColumn)
          .onChange(async (value) => {
            this.plugin.settings.doneColumn = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Today column")
      .setDesc("Tag for the column where past-due and undated #later tasks are moved to (e.g. #today)")
      .addText((text) =>
        text
          .setPlaceholder("#today")
          .setValue(this.plugin.settings.todayColumn)
          .onChange(async (value) => {
            this.plugin.settings.todayColumn = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Later column")
      .setDesc("Tag for the scheduled / later column — shows a date picker on drop")
      .addText((text) =>
        text
          .setPlaceholder("#later")
          .setValue(this.plugin.settings.laterColumn)
          .onChange(async (value) => {
            this.plugin.settings.laterColumn = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("New task insert location")
      .setDesc(
        'Note name (and optional heading) where the + button inserts new tasks, e.g. "Tasks" or "Tasks#Inbox"'
      )
      .addText((text) =>
        text
          .setPlaceholder("Tasks")
          .setValue(this.plugin.settings.newTaskInsert)
          .onChange(async (value) => {
            this.plugin.settings.newTaskInsert = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Scan all vault notes")
      .setDesc(
        "When enabled, every note in the vault is scanned for kanban-tagged tasks. When disabled, only notes linked from Parent pages are scanned."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.allVaultNotes)
          .onChange(async (value) => {
            this.plugin.settings.allVaultNotes = value;
            await this.plugin.saveSettings();
            this.display(); // refresh to show/hide parent pages field
          })
      );

    if (!this.plugin.settings.allVaultNotes) {
      new Setting(containerEl)
        .setName("Parent pages")
        .setDesc(
          "Comma-separated note names. Tasks are collected from these notes and all notes they link to."
        )
        .addText((text) =>
          text
            .setPlaceholder("Dashboard, Projects")
            .setValue(this.plugin.settings.parentPages.join(", "))
            .onChange(async (value) => {
              this.plugin.settings.parentPages = value
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean);
              await this.plugin.saveSettings();
            })
        );
    }

    // ── Colors ────────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Colors" });
    containerEl.createEl("p", {
      text: "Theme-override fields show a ↺ button to revert to the Obsidian theme default.",
      attr: { style: "color:var(--text-muted);font-size:.85em;margin-top:-6px;" },
    });

    // Helper: color picker that falls back to theme default when value is empty.
    // Shows a ↺ reset button to clear the override.
    const themeColor = (
      name: string,
      desc: string,
      get: () => string,
      set: (v: string) => void,
      fallback: string
    ) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc + (get() ? "" : " (using theme default)"))
        .addColorPicker((cp) =>
          cp
            .setValue(get() || fallback)
            .onChange(async (value) => {
              set(value);
              await this.plugin.saveSettings();
            })
        )
        .addExtraButton((btn) =>
          btn
            .setIcon("rotate-ccw")
            .setTooltip("Reset to theme default")
            .onClick(async () => {
              set("");
              await this.plugin.saveSettings();
              this.display();
            })
        );
    };

    // Helper: required color (no theme-default option).
    const fixedColor = (
      name: string,
      desc: string,
      get: () => string,
      set: (v: string) => void
    ) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addColorPicker((cp) =>
          cp
            .setValue(get())
            .onChange(async (value) => {
              set(value);
              await this.plugin.saveSettings();
            })
        );
    };

    themeColor(
      "Card background",
      "Background color of each card.",
      () => this.plugin.settings.colorCardBg,
      (v) => { this.plugin.settings.colorCardBg = v; },
      "#1e1e1e"
    );

    themeColor(
      "Column background",
      "Default background for columns without a per-column color.",
      () => this.plugin.settings.colorColumnBg,
      (v) => { this.plugin.settings.colorColumnBg = v; },
      "#1e1e1e"
    );

    themeColor(
      "Font color",
      "Text color for cards, column headers, and tabs.",
      () => this.plugin.settings.colorText,
      (v) => { this.plugin.settings.colorText = v; },
      "#ffffff"
    );

    themeColor(
      "Accent / symbol color",
      "Color for ▶ promote, ▲/▼ expand, active column tab, and drag highlight.",
      () => this.plugin.settings.colorAccent,
      (v) => { this.plugin.settings.colorAccent = v; },
      "#7f6df2"
    );

    themeColor(
      "Link color",
      "Color for wiki links and URL badges on cards.",
      () => this.plugin.settings.colorLink,
      (v) => { this.plugin.settings.colorLink = v; },
      "#7f6df2"
    );

    fixedColor(
      "Family highlight — self",
      "Outline color for the hovered card in family highlight mode.",
      () => this.plugin.settings.colorFamilySelf,
      (v) => { this.plugin.settings.colorFamilySelf = v; }
    );

    fixedColor(
      "Family highlight — parent",
      "Outline color for the parent card in family highlight mode.",
      () => this.plugin.settings.colorFamilyParent,
      (v) => { this.plugin.settings.colorFamilyParent = v; }
    );

    fixedColor(
      "Family highlight — siblings",
      "Outline color for sibling cards in family highlight mode.",
      () => this.plugin.settings.colorFamilySibling,
      (v) => { this.plugin.settings.colorFamilySibling = v; }
    );

    fixedColor(
      "All children done — highlight",
      "Border color for cards whose child tasks are all done or have no task children.",
      () => this.plugin.settings.allChildrenDoneColor,
      (v) => { this.plugin.settings.allChildrenDoneColor = v; }
    );

    containerEl.createEl("h4", { text: "Per-column colors" });
    containerEl.createEl("p", {
      text: "Background color for each column and its narrow-mode tab. ↺ removes the custom color.",
      attr: { style: "color:var(--text-muted);font-size:.85em;margin-top:-6px;" },
    });

    this.plugin.settings.kanban.forEach((tag, i) => {
      const currentColor = (this.plugin.settings.columnColors || [])[i] || "";
      new Setting(containerEl)
        .setName(tag.replace(/^#/, "").toUpperCase())
        .addColorPicker((cp) =>
          cp
            .setValue(currentColor || "#1e1e1e")
            .onChange(async (value) => {
              if (!this.plugin.settings.columnColors) this.plugin.settings.columnColors = [];
              this.plugin.settings.columnColors[i] = value;
              await this.plugin.saveSettings();
            })
        )
        .addExtraButton((btn) =>
          btn
            .setIcon("rotate-ccw")
            .setTooltip("Remove custom color")
            .onClick(async () => {
              if (!this.plugin.settings.columnColors) this.plugin.settings.columnColors = [];
              this.plugin.settings.columnColors[i] = "";
              await this.plugin.saveSettings();
              this.display();
            })
        );
    });

    new Setting(containerEl)
      .setName("Open board")
      .addButton((btn) =>
        btn.setButtonText("Open Kanban Board").onClick(() => {
          this.plugin.activateView();
        })
      );
  }
}
