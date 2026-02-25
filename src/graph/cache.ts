/**
 * @file graph/cache
 * @description Maintains file hash metadata for incremental graph rebuild decisions.
 * @remarks Cache storage is filesystem-backed and scoped to the runtime workspace.
 */

import * as fs from "fs";
import * as path from "path";

export interface CacheEntry {
  path: string;
  hash: string;
  timestamp: number;
  LOC: number;
}

export interface CacheData {
  version: string;
  lastBuild: number;
  files: Record<string, CacheEntry>;
}

/**
 * File hash cache for incremental builds
 * Stores hashes and timestamps to detect changed files
 */
export class CacheManager {
  private cachePath: string;
  private cache: CacheData;

  constructor(cacheDir: string = ".lxrag/cache") {
    this.cachePath = path.join(process.cwd(), cacheDir, "file-hashes.json");
    this.cache = this.loadCache();
  }

  private loadCache(): CacheData {
    try {
      if (fs.existsSync(this.cachePath)) {
        const data = fs.readFileSync(this.cachePath, "utf-8");
        return JSON.parse(data);
      }
    } catch (error) {
      console.warn(`[CacheManager] Failed to load cache: ${error}`);
    }

    return {
      version: "1.0",
      lastBuild: 0,
      files: {},
    };
  }

  /**
   * Save cache to disk
   */
  save(): void {
    try {
      const dir = path.dirname(this.cachePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.cache.lastBuild = Date.now();
      fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
    } catch (error) {
      console.error(`[CacheManager] Failed to save cache: ${error}`);
    }
  }

  /**
   * Add or update cache entry
   */
  set(filePath: string, hash: string, LOC: number): void {
    const relPath = path.relative(process.cwd(), filePath);
    this.cache.files[relPath] = {
      path: relPath,
      hash,
      timestamp: Date.now(),
      LOC,
    };
  }

  /**
   * Get cache entry
   */
  get(filePath: string): CacheEntry | undefined {
    const relPath = path.relative(process.cwd(), filePath);
    return this.cache.files[relPath];
  }

  /**
   * Check if file has changed
   */
  hasChanged(filePath: string, currentHash: string): boolean {
    const entry = this.get(filePath);
    return !entry || entry.hash !== currentHash;
  }

  /**
   * Get all changed files since last build
   */
  getChangedFiles(
    files: Array<{ path: string; hash: string; LOC: number }>,
  ): string[] {
    const changed: string[] = [];
    // @ts-expect-error - now will be used for timestamp comparison
    const now = Date.now();

    for (const file of files) {
      const entry = this.get(file.path);
      if (!entry || entry.hash !== file.hash) {
        changed.push(file.path);
      }
    }

    return changed;
  }

  /**
   * Clear cache (for full rebuild)
   */
  clear(): void {
    this.cache = {
      version: "1.0",
      lastBuild: Date.now(),
      files: {},
    };
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    cachedFiles: number;
    lastBuild: Date;
    version: string;
  } {
    return {
      cachedFiles: Object.keys(this.cache.files).length,
      lastBuild: new Date(this.cache.lastBuild),
      version: this.cache.version,
    };
  }

  /**
   * Export cache as JSON
   */
  export(): string {
    return JSON.stringify(this.cache, null, 2);
  }
}

export default CacheManager;
