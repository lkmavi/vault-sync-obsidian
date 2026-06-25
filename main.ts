import {
  App,
  FileSystemAdapter,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
} from "obsidian";
import { execFile } from "child_process";

// ─── Settings ────────────────────────────────────────────────────────────────

interface VaultSyncSettings {
  enabled: boolean;
  debounceSeconds: number;
  commitTemplate: string;
  branch: string;
  pullOnStartup: boolean;
}

const DEFAULTS: VaultSyncSettings = {
  enabled: true,
  debounceSeconds: 30,
  commitTemplate: "auto: sync {date}",
  branch: "main",
  pullOnStartup: true,
};

// ─── Git helper ──────────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default class VaultSync extends Plugin {
  settings: VaultSyncSettings;

  private statusBarEl: HTMLElement;
  private ribbonEl: HTMLElement;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private pausedUntil: Date | null = null;
  private syncing = false;
  private lastSyncedAt: Date | null = null;

  async onload() {
    await this.loadSettings();

    this.ribbonEl = this.addRibbonIcon(
      this.settings.enabled ? "cloud-upload" : "cloud-off",
      "Vault Sync",
      () => new VaultSyncActionsModal(this.app, this).open()
    );

    this.statusBarEl = this.addStatusBarItem();
    this.refreshStatusBar();

    this.registerCommands();
    this.registerVaultEvents();
    this.addSettingTab(new VaultSyncSettingTab(this.app, this));

    if (this.settings.enabled && this.settings.pullOnStartup) {
      await this.pull();
    }
  }

  onunload() {
    this.clearDebounce();
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
  }

  // ─── Public controls ───────────────────────────────────────────────────────

  async toggleEnabled() {
    this.settings.enabled = !this.settings.enabled;
    await this.saveSettings();
    this.setRibbonIcon(this.settings.enabled ? "cloud-upload" : "cloud-off");
    this.refreshStatusBar();
    new Notice(`Vault Sync ${this.settings.enabled ? "enabled" : "disabled"}`);
  }

  pause(ms: number) {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pausedUntil = new Date(Date.now() + ms);
    this.pauseTimer = setTimeout(() => this.resume(), ms);
    this.clearDebounce();
    this.refreshStatusBar();
    new Notice(`Vault Sync paused until ${this.formatTime(this.pausedUntil)}`);
  }

  resume() {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pausedUntil = null;
    this.refreshStatusBar();
    new Notice("Vault Sync resumed");
  }

  async syncNow() {
    this.clearDebounce();
    await this.sync();
  }

  async pullNow() {
    new Notice("Vault Sync: pulling…");
    await this.pull();
    new Notice("Vault Sync: pull done");
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private registerCommands() {
    this.addCommand({
      id: "toggle",
      name: "Toggle auto-sync on/off",
      callback: () => this.toggleEnabled(),
    });
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.syncNow(),
    });
    this.addCommand({
      id: "pause-30m",
      name: "Pause for 30 minutes",
      callback: () => this.pause(30 * 60 * 1000),
    });
    this.addCommand({
      id: "pause-1h",
      name: "Pause for 1 hour",
      callback: () => this.pause(60 * 60 * 1000),
    });
    this.addCommand({
      id: "pause-2h",
      name: "Pause for 2 hours",
      callback: () => this.pause(2 * 60 * 60 * 1000),
    });
    this.addCommand({
      id: "resume",
      name: "Resume sync",
      callback: () => this.resume(),
    });
  }

  private registerVaultEvents() {
    const trigger = () => this.onVaultChange();
    this.registerEvent(this.app.vault.on("modify", trigger));
    this.registerEvent(this.app.vault.on("create", trigger));
    this.registerEvent(this.app.vault.on("delete", trigger));
    this.registerEvent(this.app.vault.on("rename", trigger));
  }

  private onVaultChange() {
    if (!this.settings.enabled || this.isPaused()) return;
    this.clearDebounce();
    this.debounceTimer = setTimeout(
      () => this.sync(),
      this.settings.debounceSeconds * 1000
    );
    this.refreshStatusBar("pending");
  }

  private async sync() {
    if (this.syncing) return;
    this.syncing = true;
    this.refreshStatusBar("syncing");

    const cwd = this.vaultPath();
    try {
      await git(cwd, ["add", "."]);

      const staged = await git(cwd, ["diff", "--cached", "--name-only"]);
      if (!staged) {
        this.refreshStatusBar("synced");
        return;
      }

      const msg = this.settings.commitTemplate.replace(
        "{date}",
        this.formatDateTime(new Date())
      );
      await git(cwd, ["commit", "-m", msg]);
      await git(cwd, ["pull", "--rebase", "origin", this.settings.branch]);
      await git(cwd, ["push", "origin", this.settings.branch]);

      this.lastSyncedAt = new Date();
      this.refreshStatusBar("synced");
    } catch (err) {
      console.error("[VaultSync]", err);
      new Notice(`Vault Sync failed:\n${(err as Error).message}`, 8000);
      this.refreshStatusBar("error");
    } finally {
      this.syncing = false;
    }
  }

  private async pull() {
    const cwd = this.vaultPath();
    try {
      await git(cwd, ["pull", "--rebase", "origin", this.settings.branch]);
    } catch (err) {
      new Notice(`Vault Sync pull failed:\n${(err as Error).message}`, 6000);
    }
  }

  isPaused(): boolean {
    return this.pausedUntil !== null && new Date() < this.pausedUntil;
  }

  private clearDebounce() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private vaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    throw new Error("VaultSync requires a local vault");
  }

  private setRibbonIcon(icon: string) {
    this.ribbonEl.empty();
    // Obsidian re-renders the icon via the aria-label + SVG swap trick
    (this.ribbonEl as any).dataset.icon = icon;
    // Simpler: just toggle a CSS class the ribbon uses
    this.ribbonEl.setAttribute("aria-label", `Vault Sync (${this.settings.enabled ? "on" : "off"})`);
  }

  private refreshStatusBar(
    state?: "pending" | "syncing" | "synced" | "error"
  ) {
    if (!this.settings.enabled) {
      this.statusBarEl.setText("sync: off");
      return;
    }
    if (this.isPaused()) {
      this.statusBarEl.setText(`sync: paused until ${this.formatTime(this.pausedUntil!)}`);
      return;
    }
    switch (state) {
      case "pending":
        this.statusBarEl.setText("sync: pending…");
        break;
      case "syncing":
        this.statusBarEl.setText("sync: pushing…");
        break;
      case "synced":
        this.statusBarEl.setText(`sync: ok ${this.formatTime(new Date())}`);
        break;
      case "error":
        this.statusBarEl.setText("sync: failed ✗");
        break;
      default:
        this.statusBarEl.setText("sync: on");
    }
  }

  private formatTime(d: Date): string {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  private formatDateTime(d: Date): string {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ─── Actions modal ───────────────────────────────────────────────────────────

interface SyncAction {
  label: string;
  run: () => void;
}

class VaultSyncActionsModal extends SuggestModal<SyncAction> {
  private plugin: VaultSync;

  constructor(app: App, plugin: VaultSync) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder("Vault Sync — choose an action");
  }

  getSuggestions(): SyncAction[] {
    const p = this.plugin;
    const actions: SyncAction[] = [
      { label: "Sync now — commit & push immediately", run: () => p.syncNow() },
      { label: "Pull — fetch latest from remote", run: () => p.pullNow() },
      {
        label: p.settings.enabled ? "Disable auto-sync" : "Enable auto-sync",
        run: () => p.toggleEnabled(),
      },
    ];

    if (p.isPaused()) {
      actions.push({ label: "Resume sync", run: () => p.resume() });
    } else {
      actions.push(
        { label: "Pause for 30 minutes", run: () => p.pause(30 * 60 * 1000) },
        { label: "Pause for 1 hour", run: () => p.pause(60 * 60 * 1000) },
        { label: "Pause for 2 hours", run: () => p.pause(2 * 60 * 60 * 1000) }
      );
    }

    return actions;
  }

  renderSuggestion(action: SyncAction, el: HTMLElement) {
    el.createEl("div", { text: action.label });
  }

  onChooseSuggestion(action: SyncAction) {
    action.run();
  }
}

// ─── Settings tab ────────────────────────────────────────────────────────────

class VaultSyncSettingTab extends PluginSettingTab {
  plugin: VaultSync;

  constructor(app: App, plugin: VaultSync) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Vault Sync" });

    new Setting(containerEl)
      .setName("Auto-sync")
      .setDesc("Automatically commit and push on every save")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
          this.plugin.settings.enabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Pull on startup")
      .setDesc("Pull latest changes when Obsidian opens")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.pullOnStartup).onChange(async (v) => {
          this.plugin.settings.pullOnStartup = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Debounce (seconds)")
      .setDesc("How long to wait after the last change before syncing")
      .addSlider((s) =>
        s
          .setLimits(5, 300, 5)
          .setValue(this.plugin.settings.debounceSeconds)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.debounceSeconds = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Commit message")
      .setDesc("{date} → current date/time")
      .addText((t) =>
        t
          .setPlaceholder("auto: sync {date}")
          .setValue(this.plugin.settings.commitTemplate)
          .onChange(async (v) => {
            this.plugin.settings.commitTemplate = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Branch")
      .addText((t) =>
        t.setValue(this.plugin.settings.branch).onChange(async (v) => {
          this.plugin.settings.branch = v.trim();
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Pause" });

    new Setting(containerEl)
      .setName("Pause sync temporarily")
      .addButton((b) =>
        b.setButtonText("30 min").onClick(() => this.plugin.pause(30 * 60 * 1000))
      )
      .addButton((b) =>
        b.setButtonText("1 hour").onClick(() => this.plugin.pause(60 * 60 * 1000))
      )
      .addButton((b) =>
        b.setButtonText("2 hours").onClick(() => this.plugin.pause(2 * 60 * 60 * 1000))
      )
      .addButton((b) =>
        b.setButtonText("Resume").setCta().onClick(() => this.plugin.resume())
      );

    containerEl.createEl("h3", { text: "Manual" });

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Commit and push immediately")
      .addButton((b) =>
        b
          .setButtonText("Sync now")
          .setCta()
          .onClick(() => this.plugin.syncNow())
      );
  }
}
