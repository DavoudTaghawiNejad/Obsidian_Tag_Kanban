import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from "obsidian";
import { KanbanView, VIEW_TYPE_KANBAN } from "./KanbanView";

export interface KanbanSettings {
  kanban: string[];
  doneColumn: string;
  defaultColumn: string;
  laterColumn: string;
  newTaskInsert: string;
  parentPages: string[];
  allVaultNotes: boolean;
}

export const DEFAULT_SETTINGS: KanbanSettings = {
  kanban: ["#todo", "#inprogress", "#later", "#done"],
  doneColumn: "#done",
  defaultColumn: "#todo",
  laterColumn: "#later",
  newTaskInsert: "Tasks",
  parentPages: [],
  allVaultNotes: true,
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
      .setName("Default column")
      .setDesc("Tag for the default column (where scheduled tasks return when past due)")
      .addText((text) =>
        text
          .setPlaceholder("#todo")
          .setValue(this.plugin.settings.defaultColumn)
          .onChange(async (value) => {
            this.plugin.settings.defaultColumn = value.trim();
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

    new Setting(containerEl)
      .setName("Open board")
      .addButton((btn) =>
        btn.setButtonText("Open Kanban Board").onClick(() => {
          this.plugin.activateView();
        })
      );
  }
}
