import { App, Platform, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from "obsidian";
import { KanbanView, VIEW_TYPE_KANBAN } from "./KanbanView";
import { buildConfig, addDueColumnExplanationCard, normalizeTag, hslToHex, clamp } from "./kanban";

export interface KanbanSettings {
  kanban: string[];
  doneColumn: string;
  startColumn: string;
  dueColumn: string;
  laterColumn: string;
  recurrentColumn: string;
  newTaskInsert: string;
  parentPages: string[];
  allVaultNotes: boolean;
  projectColumns: string[];
  activeColumns: string[];
  projectsDocument: string;
  // ── Colors ─────────────────────────────────────────────────────────────
  // Every color choice is its own independent Hue (0-360). Saturation and
  // Lightness are shared/central (colorSaturation, colorLightness) for
  // everything except text colors, which use their own Text lightness
  // instead — and except the card-highlight dialog, which has fixed
  // constants of its own. null means "use Obsidian theme default" (nullable
  // fields only).
  colorSaturation: number;
  colorLightness: number;
  hueColumnOverLimit: number;
  hueAllChildrenDone: number;
  // Card background has its own independent Lightness (default 100 = white,
  // regardless of Hue/Saturation), so it stays white by default instead of
  // following the general Lightness like other backgrounds.
  hueCardBg: number | null;
  lightnessCardBg: number;
  hueColumnBg: number | null;
  hueAccent: number | null;
  hueFamilySelf: number;
  hueFamilyParent: number;
  hueFamilySibling: number;
  fontDate: string;
  // Text colors share colorSaturation above, but use this Lightness instead
  // of colorLightness, so text can stay legible regardless of how light/dark
  // the general Lightness is set.
  textLightness: number;
  hueText: number | null;
  // Bold/Italic/Italic can each shift up to ±50% away from Text lightness.
  // Their Hue resets to Font color's current Hue (not a fixed factory value,
  // and not the theme default) via the ↺ button.
  hueBold: number | null;
  boldLightnessDelta: number;
  hueItalicStar: number | null;
  italicStarLightnessDelta: number;
  hueItalicUnderscore: number | null;
  italicUnderscoreLightnessDelta: number;
  hueLink: number | null;
  hueDate: number | null;
  // Column title text: a hue-selectable dark color at standard text
  // Saturation, constrained to 0-25% Lightness (75-100% "dark"). White is
  // substituted per-column when that column's own background is too dark
  // for this dark color to read. null hue → use Font color's current Hue.
  hueColumnTitle: number | null;
  lightnessColumnTitle: number;
  // 0-100: minimum luminance difference (as a %) required between a
  // column's background and the dark title color before white is used
  // instead. 0 = never switch to white, 100 = always switch.
  columnTitleContrastThreshold: number;
  // Length (px) of a directional white shadow behind the column title text,
  // as if lit from the top-left (so it falls toward the bottom-right). 0 =
  // no shadow. Skipped when the title itself resolved to white.
  columnTitleShadowLength: number;
  // Per-column-type colors. Which type a column belongs to is derived from
  // Done/Due/Later/Recurrent/Start column, Project columns, and Active
  // columns below; "Non-active" is the fallback for everything else.
  // Individual columns don't get their own color. Active/Non-active columns
  // don't get their own Hue either — they always use Column background's
  // Hue. Active uses it at the general Lightness unmodified; Non-active
  // shifts by nonActiveLightnessDelta.
  hueDoneColumn: number | null;
  hueDueColumn: number | null;
  hueLaterColumn: number | null;
  hueRecurrentColumn: number | null;
  hueStartColumn: number | null;
  hueProjectColumns: number | null;
  nonActiveLightnessDelta: number;
  // Per-column max card count, index-aligned with `kanban`. 0 / undefined = no limit.
  columnMaxCards: number[];
  // Font sizes — empty string means "use theme/browser default". Mobile fields are
  // independent overrides used only when running on Obsidian mobile.
  fontSizeColumnTitle: string;
  fontSizeColumnTitleMobile: string;
  fontSizeCardTitle: string;
  fontSizeCardTitleMobile: string;
  fontSizeSubtask: string;
  fontSizeSubtaskMobile: string;
}

// Default hues, derived from the color scheme in the reference vault's
// kanban-board plugin (~/.../.obsidian/plugins/kanban-board/data.json):
// central Saturation/Lightness are taken from that plugin's #today column
// color (#ccd1f0 → S 55 / L 87, here split into colorLightness for general
// use); each field's hue is taken from that same field's own color there
// (column types are matched to whichever reference column had that role —
// e.g. hueStartColumn from its #today column, since the default Start
// column is #today). Fields with no reference color default to null (theme
// default / no color). Single source of truth for both DEFAULT_SETTINGS and
// the "Reset colors" button in the settings tab.
export const DEFAULT_COLORS = {
  colorSaturation: 55,
  colorLightness: 80,
  textLightness: 30,
  hueColumnOverLimit: 0,
  hueAllChildrenDone: 6,
  hueCardBg: 0,
  lightnessCardBg: 100,
  hueColumnBg: 345,
  hueAccent: 237,
  hueFamilySelf: 55,
  hueFamilyParent: 154,
  hueFamilySibling: 211,
  hueText: 225,
  // Bold/Italic/Italic default to Font color's own hue (225), not their own
  // factory hue — only Font color has an independent factory default.
  hueBold: 225,
  boldLightnessDelta: 0,
  hueItalicStar: 225,
  italicStarLightnessDelta: 0,
  hueItalicUnderscore: 225,
  italicUnderscoreLightnessDelta: 0,
  hueLink: 237,
  hueDate: 244,
  hueColumnTitle: 225,
  lightnessColumnTitle: 10,
  columnTitleContrastThreshold: 18,
  columnTitleShadowLength: 2,
  hueDoneColumn: 345,
  hueDueColumn: 345,
  hueLaterColumn: 345,
  hueRecurrentColumn: null as number | null,
  hueStartColumn: 232,
  hueProjectColumns: null as number | null,
  nonActiveLightnessDelta: 0,
};

export const DEFAULT_SETTINGS: KanbanSettings = {
  kanban: ["#todo", "#inprogress", "#today", "#later", "#due", "#done", "#recurrent"],
  doneColumn: "#done",
  startColumn: "#today",
  dueColumn: "#due",
  laterColumn: "#later",
  recurrentColumn: "#recurrent",
  newTaskInsert: "Tasks",
  parentPages: [],
  allVaultNotes: true,
  projectColumns: [],
  activeColumns: ["#next", "#important", "#today"],
  projectsDocument: "",
  ...DEFAULT_COLORS,
  columnMaxCards: [],
  fontDate: "",
  fontSizeColumnTitle: "",
  fontSizeColumnTitleMobile: "",
  fontSizeCardTitle: "",
  fontSizeCardTitleMobile: "",
  fontSizeSubtask: "",
  fontSizeSubtaskMobile: "",
};

export default class KanbanPlugin extends Plugin {
  settings!: KanbanSettings;
  usingDesktopFallback = false;

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

    this.addCommand({
      id: "open-kanban-window",
      name: "Open Kanban Board in new window",
      callback: () => this.activateViewInWindow(),
    });

    // Protocol handler: obsidian://open-kanban opens the board from text links
    this.registerObsidianProtocolHandler("open-kanban", () =>
      this.activateView()
    );
    this.registerObsidianProtocolHandler("open-kanban-window", () =>
      this.activateViewInWindow()
    );

    // Inject "Open Kanban Board" button into new-tab empty views
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.injectNewTabButton())
    );
    // Run once in case a tab is already open when the plugin loads
    this.app.workspace.onLayoutReady(() => this.injectNewTabButton());

    this.addSettingTab(new KanbanSettingTab(this.app, this));
  }

  private injectNewTabButton() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.getViewState().type !== "empty") return;
      const container = leaf.view.containerEl.querySelector(".empty-state-container");
      if (!container || container.querySelector(".kanban-new-tab-btn")) return;
      const btn = container.createEl("button", {
        text: "Open Kanban Board",
        cls: "empty-state-action kanban-new-tab-btn",
      });
      btn.addEventListener("click", () => this.activateView());
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_KANBAN);
  }

  async activateViewInWindow() {
    const { workspace } = this.app;

    // Find any existing Kanban leaf that lives in a popout (not in the main window).
    const rootLeaves = new Set<WorkspaceLeaf>();
    workspace.iterateRootLeaves((leaf) => rootLeaves.add(leaf));
    const popoutLeaf = workspace
      .getLeavesOfType(VIEW_TYPE_KANBAN)
      .find((leaf) => !rootLeaves.has(leaf));

    if (popoutLeaf) {
      workspace.revealLeaf(popoutLeaf);
      return;
    }

    const leaf = Platform.isMobile
      ? workspace.getLeaf(true)
      : workspace.openPopoutLeaf();
    await leaf.setViewState({ type: VIEW_TYPE_KANBAN, active: true });
    workspace.revealLeaf(leaf);
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
    let data = await this.loadData();
    this.usingDesktopFallback = false;
    if (!data && Platform.isMobile) {
      try {
        const raw = await this.app.vault.adapter.read(".obsidian/plugins/kanban-board/data.json");
        data = JSON.parse(raw);
        this.usingDesktopFallback = true;
      } catch { /* desktop settings not synced yet */ }
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshOpenBoards();
  }

  refreshOpenBoards() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_KANBAN).forEach((leaf) => {
      (leaf.view as KanbanView).refresh();
    });
  }
}

// Injects a stylesheet (once per document) that gives every "kb-hue-slider"
// range input a rainbow-gradient track, so it reads as a hue picker instead
// of a plain gray slider.
function ensureHueSliderStyles(doc: Document) {
  if (doc.getElementById("kb-hue-slider-style")) return;
  const style = doc.createElement("style");
  style.id = "kb-hue-slider-style";
  style.textContent = `
    .kb-hue-slider { -webkit-appearance: none; appearance: none; background: transparent; height: 16px; }
    .kb-hue-slider::-webkit-slider-runnable-track {
      height: 10px;
      border-radius: 5px;
      background: linear-gradient(to right,
        hsl(0,90%,55%), hsl(60,90%,55%), hsl(120,90%,55%),
        hsl(180,90%,55%), hsl(240,90%,55%), hsl(300,90%,55%), hsl(360,90%,55%));
    }
    .kb-hue-slider::-webkit-slider-thumb,
    .kb-sl-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 16px;
      height: 16px;
      margin-top: -3px;
      border-radius: 50%;
      background: var(--background-primary);
      border: 2px solid var(--text-normal);
      box-shadow: 0 1px 3px rgba(0,0,0,.4);
      cursor: pointer;
    }
    .kb-sl-slider { -webkit-appearance: none; appearance: none; background: transparent; height: 16px; }
    .kb-sl-slider.kb-saturation::-webkit-slider-runnable-track {
      height: 10px;
      border-radius: 5px;
      background: linear-gradient(to right, hsl(0,0%,60%), hsl(0,90%,55%));
    }
    .kb-sl-slider.kb-lightness::-webkit-slider-runnable-track {
      height: 10px;
      border-radius: 5px;
      background: linear-gradient(to right, #000, #fff);
    }
  `;
  doc.head.appendChild(style);
}

class KanbanSettingTab extends PluginSettingTab {
  plugin: KanbanPlugin;
  private ignoreWarning = false;

  constructor(app: App, plugin: KanbanPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // The due column is hidden while empty, so a settings change touching it would
  // otherwise leave it invisible. Drop an explanatory card in it and refresh so the
  // user can immediately see the column (and the note) reflecting the change.
  private async touchDueColumn() {
    await addDueColumnExplanationCard(this.app, buildConfig(this.plugin.settings));
    this.plugin.refreshOpenBoards();
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();
    ensureHueSliderStyles(containerEl.ownerDocument);
    containerEl.createEl("h2", { text: "Kanban Board Settings" });

    try {
    const s = this.plugin.settings;

    // Helper: every color choice picks only a Hue (0-360). Saturation always
    // comes from the shared `s.colorSaturation`; Lightness is passed in by
    // the caller (the shared `s.colorLightness`, `s.textLightness`, or a
    // fixed value for the card-highlight dialog is NOT handled here — that
    // dialog has its own separate UI). Nullable fields show a ↺ button to
    // revert to the Obsidian theme default.
    const hueSetting = (
      container: HTMLElement,
      name: string,
      desc: string,
      get: () => number | null,
      set: (v: number | null) => void,
      lightness: number,
      opts: {
        nullable: boolean;
        onSaved?: () => void | Promise<void>;
        resetTo?: () => number | null;
        resetTooltip?: string;
        nullSuffix?: string;
      }
    ) => {
      const current = get();
      const setting = new Setting(container)
        .setName(name)
        .setDesc((desc + (opts.nullable && current === null ? (opts.nullSuffix ?? " (using theme default)") : "")).trim());
      // Force a firm ~40/60 split between name+description and the control
      // row, so the slider reliably claims real width instead of being
      // squeezed to near-invisible next to longer description text. Text
      // wraps within its column rather than the two overlapping.
      setting.settingEl.style.flexWrap = "wrap";
      setting.infoEl.style.flex = "1 1 38%";
      setting.infoEl.style.minWidth = "0";
      setting.controlEl.style.flex = "0 0 auto";
      setting.controlEl.style.width = "60%";
      setting.controlEl.style.maxWidth = "60%";
      const swatch = setting.controlEl.createDiv();
      swatch.style.cssText =
        "width:24px;height:24px;border-radius:5px;margin-right:8px;flex-shrink:0;" +
        "border:1px solid var(--background-modifier-border);";
      const paint = (hue: number | null) => {
        swatch.style.background = hue === null
          ? "repeating-linear-gradient(45deg, var(--background-modifier-border), var(--background-modifier-border) 3px, transparent 3px, transparent 7px)"
          : hslToHex(hue, s.colorSaturation, lightness);
      };
      paint(current);
      setting.addSlider((slider) => {
        slider.sliderEl.addClass("kb-hue-slider");
        slider.sliderEl.style.cssText += "flex:1 1 auto;min-width:80px;";
        slider
          .setLimits(0, 360, 1)
          .setValue(current ?? 0)
          .setDynamicTooltip()
          .onChange(async (value) => {
            set(value);
            paint(value);
            await this.plugin.saveSettings();
            await opts.onSaved?.();
          });
      });
      if (opts.nullable) {
        setting.addExtraButton((btn) =>
          btn
            .setIcon("rotate-ccw")
            .setTooltip(opts.resetTooltip ?? "Reset to theme default")
            .onClick(async () => {
              set(opts.resetTo ? opts.resetTo() : null);
              await this.plugin.saveSettings();
              await opts.onSaved?.();
              this.display();
            })
        );
      }
    };

    // Helper: a plain 0-100 slider (Saturation/Lightness, not a Hue), with
    // the same width fix as hueSetting so it's never squeezed invisible.
    const plainSlider = (
      container: HTMLElement,
      name: string,
      desc: string,
      get: () => number,
      set: (v: number) => void,
      cssClass: "kb-saturation" | "kb-lightness",
      range: [number, number] = [0, 100]
    ) => {
      const setting = new Setting(container).setName(name).setDesc(desc);
      setting.settingEl.style.flexWrap = "wrap";
      setting.infoEl.style.flex = "1 1 38%";
      setting.infoEl.style.minWidth = "0";
      setting.controlEl.style.flex = "0 0 auto";
      setting.controlEl.style.width = "60%";
      setting.controlEl.style.maxWidth = "60%";
      setting.addSlider((slider) => {
        slider.sliderEl.addClass("kb-sl-slider", cssClass);
        slider.sliderEl.style.cssText += "flex:1 1 auto;min-width:80px;width:100%;";
        slider
          .setLimits(range[0], range[1], 1)
          .setValue(get())
          .setDynamicTooltip()
          .onChange(async (value) => {
            set(value);
            await this.plugin.saveSettings();
            this.display();
          });
      });
    };

    // Helper: wraps a "type"-defining field (e.g. the Done column tag) and
    // its color's Hue slider in one grouped grey box, so the color for a
    // column type lives right next to where that type's tag(s) are defined.
    const typeGroup = (build: (box: HTMLElement) => void) => {
      const settingGroup = containerEl.createDiv({ cls: "setting-group" });
      const settingItems = settingGroup.createDiv({ cls: "setting-items" });
      build(settingItems);
      return settingItems;
    };

    if (Platform.isMobile) {
      const mobilePath = ".obsidian-mobile/plugins/kanban-board/data.json";
      const hasMobileSettings = await this.app.vault.adapter.exists(mobilePath);

      if (!hasMobileSettings && !this.ignoreWarning) {
        if (this.plugin.usingDesktopFallback) {
          // Desktop settings loaded successfully — board works, just warn about editing
          containerEl.createEl("p", { text: "Settings are loaded from the desktop app. Please use the desktop app to change parameters." });
          containerEl.createEl("p", { text: "Pressing Ignore will create a separate mobile settings file seeded from the desktop. These settings may diverge over time." });
        } else {
          // No settings at all — board is broken
          containerEl.createEl("p", { text: "No settings found on this device. The desktop settings have not synced yet. The Kanban board will not work until they arrive." });
          containerEl.createEl("p", { text: "Wait for iCloud to sync, then restart the app. Alternatively, press Ignore to configure settings manually on this device." });
        }
        new Setting(containerEl)
          .addButton((btn) => {
            btn.setButtonText("Ignore");
            btn.buttonEl.addClass("mod-warning");
            btn.onClick(async () => {
              await this.plugin.saveSettings();
              this.ignoreWarning = true;
              this.display();
            });
          });
        return;
      }

      if (hasMobileSettings) {
        new Setting(containerEl)
          .setName("Mobile settings")
          .setDesc(
            "This device has its own settings that may differ from the desktop. " +
            "Deleting them will cause this app to use the desktop settings instead, " +
            "keeping everything in sync. Restart the app after deleting."
          )
          .addButton((btn) => {
            btn.setButtonText("Delete mobile settings");
            btn.buttonEl.addClass("mod-warning");
            btn.onClick(async () => {
              await this.app.vault.adapter.remove(mobilePath);
              this.display();
            });
          });
      }
    }

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

    typeGroup((box) => {
      new Setting(box)
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
      hueSetting(box, "Done column color", "Falls back to Active/Non-active when unset.", () => s.hueDoneColumn, (v) => { s.hueDoneColumn = v; }, s.colorLightness, { nullable: true });
    });

    typeGroup((box) => {
      new Setting(box)
        .setName("Start column in single row view")
        .setDesc("Tag for the column shown by default when the board is displayed as a single column (narrow/mobile view)")
        .addText((text) =>
          text
            .setPlaceholder("#today")
            .setValue(this.plugin.settings.startColumn)
            .onChange(async (value) => {
              this.plugin.settings.startColumn = value.trim();
              await this.plugin.saveSettings();
            })
        );
      hueSetting(box, "Start column color", "Falls back to Active/Non-active when unset.", () => s.hueStartColumn, (v) => { s.hueStartColumn = v; }, s.colorLightness, { nullable: true });
    });

    typeGroup((box) => {
      new Setting(box)
        .setName("Target column for due later and recurrent tasks")
        .setDesc(
          "Tag for the column where past-due/undated #later tasks and triggered #recurrent tasks are moved to (e.g. #due). " +
          "This column is hidden whenever it has no cards, and reappears automatically once the board moves a card into it."
        )
        .addText((text) =>
          text
            .setPlaceholder("#due")
            .setValue(this.plugin.settings.dueColumn)
            .onChange(async (value) => {
              this.plugin.settings.dueColumn = value.trim();
              await this.plugin.saveSettings();
              await this.touchDueColumn();
            })
        );
      hueSetting(box, "Due column color", "Falls back to Active/Non-active when unset.", () => s.hueDueColumn, (v) => { s.hueDueColumn = v; }, s.colorLightness, {
        nullable: true,
        onSaved: async () => { await this.touchDueColumn(); },
      });
    });

    typeGroup((box) => {
      new Setting(box)
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
      hueSetting(box, "Later column color", "Falls back to Active/Non-active when unset.", () => s.hueLaterColumn, (v) => { s.hueLaterColumn = v; }, s.colorLightness, { nullable: true });
    });

    typeGroup((box) => {
      new Setting(box)
        .setName("Recurrent column")
        .setDesc("Tag for the recurrent column. Cards with a matching @annotation and no other kanban tag are automatically placed here. Must be included in 'Kanban columns'.")
        .addText((text) =>
          text
            .setPlaceholder("#recurrent")
            .setValue(this.plugin.settings.recurrentColumn)
            .onChange(async (value) => {
              this.plugin.settings.recurrentColumn = value.trim();
              await this.plugin.saveSettings();
            })
        );
      hueSetting(box, "Recurrent column color", "Falls back to Active/Non-active when unset.", () => s.hueRecurrentColumn, (v) => { s.hueRecurrentColumn = v; }, s.colorLightness, { nullable: true });
    });

    typeGroup((box) => {
      new Setting(box)
        .setName("Project columns")
        .setDesc(
          "Comma-separated tags for columns where adding a new card automatically offers to create a linked Obsidian note. " +
          "When a card is added in one of these columns, the 'Create new document' checkbox in the add dialog is pre-checked. " +
          "The new note is created in the vault root and the card text becomes a wiki link [[Note Title]] pointing to it."
        )
        .addText((text) =>
          text
            .setPlaceholder("#todo, #inprogress")
            .setValue((this.plugin.settings.projectColumns || []).join(", "))
            .onChange(async (value) => {
              this.plugin.settings.projectColumns = value
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean);
              await this.plugin.saveSettings();
            })
        );
      hueSetting(box, "Project columns color", "Falls back to Active/Non-active when unset.", () => s.hueProjectColumns, (v) => { s.hueProjectColumns = v; }, s.colorLightness, { nullable: true });
    });

    typeGroup((box) => {
      new Setting(box)
        .setName("Active columns")
        .setDesc(
          "Comma-separated tags for columns considered 'active' work. A project card is highlighted as unmanaged work only when none of its sub-tasks are in one of these columns, and not all of its sub-tasks are in the Later or Recurrent columns."
        )
        .addText((text) =>
          text
            .setPlaceholder("#next, #important, #today")
            .setValue((this.plugin.settings.activeColumns || []).join(", "))
            .onChange(async (value) => {
              this.plugin.settings.activeColumns = value
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean);
              await this.plugin.saveSettings();
            })
        );
      new Setting(box)
        .setName("Active / Non-active columns")
        .setDesc(
          "Any column not covered by a more specific type above uses Column background's Hue — Active columns " +
          "get it at the general Lightness unmodified; Non-active columns shift by the offset below."
        );
      plainSlider(
        box,
        "Non-active column lightness offset",
        "Added to the general Lightness for Non-active columns. Negative darkens, positive lightens, 0 = same as Active.",
        () => s.nonActiveLightnessDelta,
        (v) => { s.nonActiveLightnessDelta = v; },
        "kb-lightness",
        [-15, 15]
      );
    });

    new Setting(containerEl)
      .setName("Project master document")
      .setDesc(
        "Note where [[Project name]] links are collected when adding a card with 'Create new document' checked. " +
        "Each new project link is prepended here (newest on top). Leave blank to disable."
      )
      .addText((text) =>
        text
          .setPlaceholder("Projects")
          .setValue(this.plugin.settings.projectsDocument)
          .onChange(async (value) => {
            this.plugin.settings.projectsDocument = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("New task insert document")
      .setDesc(
        'Note (and optional heading) where the + button inserts new tasks, e.g. "Tasks" or "Tasks#Inbox"'
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
      text: "Each color picks its own Hue independently — Saturation and Lightness are fixed per field. " +
        "Theme-override fields show a ↺ button to revert to the Obsidian theme default.",
      attr: { style: "color:var(--text-muted);font-size:.85em;margin-top:-6px;" },
    });

    new Setting(containerEl)
      .setName("Reset colors")
      .setDesc("Reset every color's Hue (including per-column-type colors) back to the plugin defaults. Other settings are unaffected.")
      .addButton((btn) => {
        btn.setButtonText("Reset all colors to default");
        btn.buttonEl.addClass("mod-warning");
        btn.onClick(async () => {
          Object.assign(this.plugin.settings, DEFAULT_COLORS);
          await this.plugin.saveSettings();
          this.display();
        });
      });

    containerEl.createEl("h4", { text: "Theme" });
    containerEl.createEl("p", {
      text: "The two central sliders behind every color choice below.",
      attr: { style: "color:var(--text-muted);font-size:.85em;margin-top:-6px;" },
    });

    plainSlider(
      containerEl,
      "Saturation",
      "Shared saturation for every color choice below, including text. Doesn't affect the card-highlight dialog (clicking a card), which has its own fixed saturation.",
      () => s.colorSaturation,
      (v) => { s.colorSaturation = v; },
      "kb-saturation"
    );

    plainSlider(
      containerEl,
      "Lightness",
      "Shared lightness for every color choice below except text colors and Card background, which have their own Lightness instead.",
      () => s.colorLightness,
      (v) => { s.colorLightness = v; },
      "kb-lightness"
    );

    plainSlider(
      containerEl,
      "Card background lightness",
      "Independent of the general Lightness above, so cards default to white (100) instead of following it.",
      () => s.lightnessCardBg,
      (v) => { s.lightnessCardBg = v; },
      "kb-lightness"
    );
    hueSetting(containerEl, "Card background", "Background color of each card. At Lightness 100 (default), always white regardless of Hue.", () => s.hueCardBg, (v) => { s.hueCardBg = v; }, s.lightnessCardBg, { nullable: true });
    hueSetting(containerEl, "Column background", "Base column background, drawn before the per-column color applies. Every column now always resolves a color via Active/Non-active, so this rarely shows through.", () => s.hueColumnBg, (v) => { s.hueColumnBg = v; }, s.colorLightness, { nullable: true });
    hueSetting(containerEl, "Accent / symbol color", "Color for ▶ promote, ▲/▼ expand, active column tab, and drag highlight.", () => s.hueAccent, (v) => { s.hueAccent = v; }, s.colorLightness, { nullable: true });

    containerEl.createEl("h4", { text: "Text colors" });

    plainSlider(
      containerEl,
      "Text lightness",
      "Shared lightness for the text colors below, independent of the general Lightness above — so text can stay legible regardless of how light/dark backgrounds are set. Saturation still comes from the shared Saturation above.",
      () => s.textLightness,
      (v) => { s.textLightness = v; },
      "kb-lightness"
    );

    hueSetting(containerEl, "Font color", "Text color for cards and tabs.", () => s.hueText, (v) => { s.hueText = v; }, s.textLightness, { nullable: true });

    typeGroup((box) => {
      hueSetting(
        box,
        "Column title color",
        "Dark, hue-selectable color for column header titles, at standard text Saturation. White is used instead for any column whose own background is too dark to read this dark color against.",
        () => s.hueColumnTitle,
        (v) => { s.hueColumnTitle = v; },
        s.lightnessColumnTitle,
        {
          nullable: true,
          resetTo: () => s.hueText,
          resetTooltip: "Reset to Font color's hue",
          nullSuffix: " (using Font color's hue)",
        }
      );
      plainSlider(
        box,
        "Column title darkness",
        "How dark the color above is — 75% to 100% dark (Lightness 25% down to 0%).",
        () => s.lightnessColumnTitle,
        (v) => { s.lightnessColumnTitle = v; },
        "kb-lightness",
        [0, 25]
      );
      plainSlider(
        box,
        "Column title contrast threshold",
        "How different a column's background needs to be from the dark color above before switching to white for that column. 0 = never switch, 100 = always switch. A background with a similar hue to the dark color (e.g. blue on blue) switches to white sooner than a same-luminance but different-hue background (e.g. blue on red).",
        () => s.columnTitleContrastThreshold,
        (v) => { s.columnTitleContrastThreshold = v; },
        "kb-saturation"
      );
      plainSlider(
        box,
        "Column title shadow length",
        "Length (px) of a directional white shadow behind the column title text, as if lit from the top-left. 0 = no shadow. Skipped for any column whose title resolved to white.",
        () => s.columnTitleShadowLength,
        (v) => { s.columnTitleShadowLength = v; },
        "kb-lightness",
        [0, 10]
      );
    });

    typeGroup((box) => {
      hueSetting(
        box,
        "Bold color (**text**)",
        "Color for card title text wrapped in **double asterisks**.",
        () => s.hueBold,
        (v) => { s.hueBold = v; },
        clamp(s.textLightness + s.boldLightnessDelta, 0, 100),
        { nullable: true, resetTo: () => s.hueText, resetTooltip: "Reset to Font color's hue" }
      );
      plainSlider(
        box,
        "Bold lightness offset",
        "Added to Text lightness for Bold text. Negative darkens, positive lightens.",
        () => s.boldLightnessDelta,
        (v) => { s.boldLightnessDelta = v; },
        "kb-lightness",
        [-50, 50]
      );
    });

    typeGroup((box) => {
      hueSetting(
        box,
        "Italic color (*text*)",
        "Color for card title text wrapped in single *asterisks*.",
        () => s.hueItalicStar,
        (v) => { s.hueItalicStar = v; },
        clamp(s.textLightness + s.italicStarLightnessDelta, 0, 100),
        { nullable: true, resetTo: () => s.hueText, resetTooltip: "Reset to Font color's hue" }
      );
      plainSlider(
        box,
        "Italic (*) lightness offset",
        "Added to Text lightness for *asterisk* italic text. Negative darkens, positive lightens.",
        () => s.italicStarLightnessDelta,
        (v) => { s.italicStarLightnessDelta = v; },
        "kb-lightness",
        [-50, 50]
      );
    });

    typeGroup((box) => {
      hueSetting(
        box,
        "Italic color (_text_)",
        "Color for card title text wrapped in _underscores_.",
        () => s.hueItalicUnderscore,
        (v) => { s.hueItalicUnderscore = v; },
        clamp(s.textLightness + s.italicUnderscoreLightnessDelta, 0, 100),
        { nullable: true, resetTo: () => s.hueText, resetTooltip: "Reset to Font color's hue" }
      );
      plainSlider(
        box,
        "Italic (_) lightness offset",
        "Added to Text lightness for _underscore_ italic text. Negative darkens, positive lightens.",
        () => s.italicUnderscoreLightnessDelta,
        (v) => { s.italicUnderscoreLightnessDelta = v; },
        "kb-lightness",
        [-50, 50]
      );
    });
    hueSetting(containerEl, "Link color", "Color for wiki links and URL badges on cards.", () => s.hueLink, (v) => { s.hueLink = v; }, s.textLightness, { nullable: true });
    hueSetting(containerEl, "Date color", "Color for date annotations on cards (e.g. 'Jun 24', 'next Mon').", () => s.hueDate, (v) => { s.hueDate = v; }, s.textLightness, { nullable: true });

    new Setting(containerEl)
      .setName("Date font")
      .setDesc("Font family for date annotations. Default: monospace.")
      .addText((t) =>
        t
          .setPlaceholder("monospace")
          .setValue(this.plugin.settings.fontDate || "")
          .onChange(async (v) => {
            this.plugin.settings.fontDate = v;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h4", { text: "Font sizes" });
    containerEl.createEl("p", {
      text: "CSS font-size values (e.g. 14px, 1.1em). Leave blank to use the theme/browser default. " +
        "Mobile fields apply only on Obsidian mobile and are independent of the desktop values.",
      attr: { style: "color:var(--text-muted);font-size:.85em;margin-top:-6px;" },
    });

    const fontSizeSetting = (
      name: string,
      desc: string,
      get: () => string,
      set: (v: string) => void
    ) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) =>
          text
            .setPlaceholder("theme default")
            .setValue(get())
            .onChange(async (value) => {
              set(value.trim());
              await this.plugin.saveSettings();
            })
        );
    };

    fontSizeSetting(
      "Column title size",
      "Font size of the column header text (e.g. TODO, DONE).",
      () => this.plugin.settings.fontSizeColumnTitle,
      (v) => { this.plugin.settings.fontSizeColumnTitle = v; }
    );
    fontSizeSetting(
      "Column title size (mobile)",
      "Same as above, but only applied on Obsidian mobile.",
      () => this.plugin.settings.fontSizeColumnTitleMobile,
      (v) => { this.plugin.settings.fontSizeColumnTitleMobile = v; }
    );
    fontSizeSetting(
      "Card title size",
      "Font size of a card's main title text.",
      () => this.plugin.settings.fontSizeCardTitle,
      (v) => { this.plugin.settings.fontSizeCardTitle = v; }
    );
    fontSizeSetting(
      "Card title size (mobile)",
      "Same as above, but only applied on Obsidian mobile.",
      () => this.plugin.settings.fontSizeCardTitleMobile,
      (v) => { this.plugin.settings.fontSizeCardTitleMobile = v; }
    );
    fontSizeSetting(
      "Subtask size",
      "Font size of sub-task text (and their checkboxes) on a card.",
      () => this.plugin.settings.fontSizeSubtask,
      (v) => { this.plugin.settings.fontSizeSubtask = v; }
    );
    fontSizeSetting(
      "Subtask size (mobile)",
      "Same as above, but only applied on Obsidian mobile.",
      () => this.plugin.settings.fontSizeSubtaskMobile,
      (v) => { this.plugin.settings.fontSizeSubtaskMobile = v; }
    );

    hueSetting(containerEl, "Family highlight — self", "Outline color for the hovered card in family highlight mode.", () => s.hueFamilySelf, (v) => { s.hueFamilySelf = v as number; }, s.colorLightness, { nullable: false });
    hueSetting(containerEl, "Family highlight — parent", "Outline color for the parent card in family highlight mode.", () => s.hueFamilyParent, (v) => { s.hueFamilyParent = v as number; }, s.colorLightness, { nullable: false });
    hueSetting(containerEl, "Family highlight — siblings", "Outline color for sibling cards in family highlight mode.", () => s.hueFamilySibling, (v) => { s.hueFamilySibling = v as number; }, s.colorLightness, { nullable: false });
    hueSetting(containerEl, "Unmanaged work — highlight", "Border color for cards that have unchecked sub-tasks not tracked as kanban cards.", () => s.hueAllChildrenDone, (v) => { s.hueAllChildrenDone = v as number; }, s.colorLightness, { nullable: false });
    hueSetting(containerEl, "Column over-limit warning", "Background color for a column that has more cards than its configured maximum. Shared by all columns.", () => s.hueColumnOverLimit, (v) => { s.hueColumnOverLimit = v as number; }, s.colorLightness, { nullable: false });

    containerEl.createEl("h4", { text: "Max cards per column" });
    containerEl.createEl("p", {
      text: "Optional per-column card limit. When a column exceeds its max, it turns the warning color above. Toggle \"No limit\" to disable the cap.",
      attr: { style: "color:var(--text-muted);font-size:.85em;margin-top:-6px;" },
    });
    this.plugin.settings.kanban.forEach((tag, i) => {
      const currentMax = (this.plugin.settings.columnMaxCards || [])[i] || 0;
      const isDueColumn = normalizeTag(tag) === normalizeTag(this.plugin.settings.dueColumn);
      let numberInputEl: HTMLInputElement;

      new Setting(containerEl)
        .setName("Max cards — " + tag.replace(/^#/, "").toUpperCase())
        .addToggle((toggle) =>
          toggle
            .setTooltip("No limit")
            .setValue(currentMax === 0)
            .onChange(async (noLimit) => {
              numberInputEl.disabled = noLimit;
              numberInputEl.style.opacity = noLimit ? "0.4" : "1";
              if (!this.plugin.settings.columnMaxCards) this.plugin.settings.columnMaxCards = [];
              if (noLimit) {
                this.plugin.settings.columnMaxCards[i] = 0;
              } else {
                const n = parseInt(numberInputEl.value.trim(), 10);
                this.plugin.settings.columnMaxCards[i] = Number.isFinite(n) && n > 0 ? n : 1;
                numberInputEl.value = String(this.plugin.settings.columnMaxCards[i]);
              }
              await this.plugin.saveSettings();
              if (isDueColumn) await this.touchDueColumn();
            })
        )
        .addText((text) => {
          numberInputEl = text.inputEl;
          text.inputEl.type = "number";
          text.inputEl.min = "1";
          text.inputEl.style.width = "5em";
          const noLimit = currentMax === 0;
          text.inputEl.disabled = noLimit;
          text.inputEl.style.opacity = noLimit ? "0.4" : "1";
          text
            .setValue(currentMax > 0 ? String(currentMax) : "")
            .onChange(async (value) => {
              if (!this.plugin.settings.columnMaxCards) this.plugin.settings.columnMaxCards = [];
              const n = parseInt(value.trim(), 10);
              this.plugin.settings.columnMaxCards[i] = Number.isFinite(n) && n > 0 ? n : 1;
              await this.plugin.saveSettings();
              if (isDueColumn) await this.touchDueColumn();
            });
        });
    });

    new Setting(containerEl)
      .setName("Open board")
      .addButton((btn) =>
        btn.setButtonText("Open Kanban Board").onClick(() => {
          this.plugin.activateView();
        })
      );
    } catch (err) {
      // Surface render errors directly in the settings page — a broken field
      // further down used to silently truncate the rest of the page with no
      // visible error at all.
      const e = err as { stack?: string } | undefined;
      const box = containerEl.createEl("pre", {
        text: "Kanban Board settings failed to render:\n" + (e && e.stack ? e.stack : String(err)),
      });
      box.style.cssText =
        "background:#ff0000;color:#ffffff;font-size:1em;font-weight:bold;padding:14px;" +
        "border-radius:8px;margin:8px 0;white-space:pre-wrap;word-break:break-word;";
    }
  }
}
