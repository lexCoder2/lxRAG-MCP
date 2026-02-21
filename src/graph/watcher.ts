import chokidar from "chokidar";

export interface WatcherOptions {
  workspaceRoot: string;
  sourceDir: string;
  projectId: string;
  debounceMs?: number;
  ignorePatterns?: string[];
}

export type WatcherState = "idle" | "detecting" | "debouncing" | "rebuilding";

export type WatchBatchHandler = (payload: {
  projectId: string;
  workspaceRoot: string;
  sourceDir: string;
  changedFiles: string[];
}) => Promise<void>;

export class FileWatcher {
  private watcher?: ReturnType<typeof chokidar.watch>;
  private pending = new Set<string>();
  private timer?: NodeJS.Timeout;
  private processing = false;
  private stateValue: WatcherState = "idle";

  constructor(
    private opts: WatcherOptions,
    private onBatch: WatchBatchHandler,
  ) {}

  get pendingChanges(): number {
    return this.pending.size;
  }

  get state(): WatcherState {
    return this.stateValue;
  }

  start(): void {
    if (this.watcher) {
      return;
    }

    const ignored = [
      "**/node_modules/**",
      "**/dist/**",
      "**/.git/**",
      "**/.code-graph/**",
      ...(this.opts.ignorePatterns || []),
    ];

    this.watcher = chokidar.watch(this.opts.sourceDir, {
      ignored,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 150,
        pollInterval: 50,
      },
    });

    this.watcher
      .on("add", (filePath: string) => this.queue(filePath))
      .on("change", (filePath: string) => this.queue(filePath))
      .on("unlink", (filePath: string) => this.queue(filePath));
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }

    this.pending.clear();
    this.processing = false;
    this.stateValue = "idle";
  }

  private queue(filePath: string): void {
    this.pending.add(filePath);
    this.stateValue = "detecting";

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.stateValue = "debouncing";
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.opts.debounceMs ?? 500);
  }

  private async flush(): Promise<void> {
    if (this.processing || this.pending.size === 0) {
      if (!this.processing && this.pending.size === 0) {
        this.stateValue = "idle";
      }
      return;
    }

    this.processing = true;
    this.stateValue = "rebuilding";

    const changedFiles = [...this.pending];
    this.pending.clear();

    try {
      await this.onBatch({
        projectId: this.opts.projectId,
        workspaceRoot: this.opts.workspaceRoot,
        sourceDir: this.opts.sourceDir,
        changedFiles,
      });
    } finally {
      this.processing = false;
      if (this.pending.size > 0) {
        this.stateValue = "debouncing";
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.flush();
        }, this.opts.debounceMs ?? 500);
      } else {
        this.stateValue = "idle";
      }
    }
  }
}

export default FileWatcher;
