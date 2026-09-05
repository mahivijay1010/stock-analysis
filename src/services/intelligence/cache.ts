import { createHash } from "crypto";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import path from "path";

export interface CachedDocument {
  content: Buffer;
  contentHash: string;
  path: string;
  fromCache: boolean;
}

export class DocumentCache {
  constructor(
    private readonly root = process.env.INTELLIGENCE_CACHE_DIR || path.resolve(process.cwd(), "data/intelligence-cache")
  ) {}

  async getOrFetch(
    url: string,
    extension: string,
    fetcher: () => Promise<Buffer>
  ): Promise<CachedDocument> {
    const urlHash = createHash("sha256").update(url).digest("hex");
    const safeExtension = extension.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin";
    const cachePath = path.join(this.root, `${urlHash}.${safeExtension}`);
    await mkdir(this.root, { recursive: true });
    try {
      const fileStat = await stat(cachePath);
      if (fileStat.size > 0) {
        const content = await readFile(cachePath);
        return { content, contentHash: createHash("sha256").update(content).digest("hex"), path: cachePath, fromCache: true };
      }
    } catch {
      // Cache miss.
    }
    const content = await fetcher();
    if (content.length === 0) throw new Error(`Refusing to cache empty document: ${url}`);
    await writeFile(cachePath, content, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    return { content, contentHash: createHash("sha256").update(content).digest("hex"), path: cachePath, fromCache: false };
  }
}
