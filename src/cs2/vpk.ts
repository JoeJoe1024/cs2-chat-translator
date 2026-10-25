import fs from "node:fs/promises";
import path from "node:path";

interface VpkEntry {
  archiveIndex: number;
  offset: number;
  length: number;
  preload: Buffer;
}

const VPK_SIGNATURE = 0x55aa1234;
const DIR_ARCHIVE = 0x7fff;

/**
 * Read-only reader for Source 2 `*_dir.vpk` packs (VPK v1/v2). Only the directory tree is indexed;
 * file contents are read on demand. Used to read CS2's own localization files from the user's install.
 */
export class VpkArchive {
  private constructor(
    private readonly dirFile: string,
    private readonly treeEnd: number,
    private readonly entries: Map<string, VpkEntry>,
  ) {}

  static async open(dirFile: string, filter: (path: string) => boolean = () => true): Promise<VpkArchive> {
    const buf = await fs.readFile(dirFile);
    if (buf.length < 12 || buf.readUInt32LE(0) !== VPK_SIGNATURE) throw new Error("Not a VPK file");
    const version = buf.readUInt32LE(4);
    if (version !== 1 && version !== 2) throw new Error(`Unsupported VPK version ${version}`);
    const treeSize = buf.readUInt32LE(8);
    const headerSize = version === 2 ? 28 : 12;
    const treeEnd = headerSize + treeSize;
    if (treeEnd > buf.length) throw new Error("Truncated VPK directory");

    let p = headerSize;
    const readStr = (): string => {
      const start = p;
      while (p < treeEnd && buf[p] !== 0) p++;
      const s = buf.toString("utf8", start, p);
      p++;
      return s;
    };

    const entries = new Map<string, VpkEntry>();
    while (p < treeEnd) {
      const ext = readStr();
      if (!ext) break;
      while (p < treeEnd) {
        const dir = readStr();
        if (!dir) break;
        while (p < treeEnd) {
          const name = readStr();
          if (!name) break;
          p += 4; // crc32
          const preloadBytes = buf.readUInt16LE(p);
          const archiveIndex = buf.readUInt16LE(p + 2);
          const offset = buf.readUInt32LE(p + 4);
          const length = buf.readUInt32LE(p + 8);
          p += 14; // fields above + 0xFFFF terminator
          const preload = buf.subarray(p, p + preloadBytes);
          p += preloadBytes;
          const full = `${dir === " " ? "" : `${dir}/`}${name}${ext === " " ? "" : `.${ext}`}`;
          if (filter(full)) entries.set(full, { archiveIndex, offset, length, preload: Buffer.from(preload) });
        }
      }
    }
    return new VpkArchive(dirFile, treeEnd, entries);
  }

  has(file: string): boolean {
    return this.entries.has(file);
  }

  list(): string[] {
    return [...this.entries.keys()];
  }

  async read(file: string): Promise<Buffer> {
    const e = this.entries.get(file);
    if (!e) throw new Error(`Not in VPK: ${file}`);
    if (e.length === 0) return e.preload;
    let data: Buffer;
    if (e.archiveIndex === DIR_ARCHIVE) {
      const fh = await fs.open(this.dirFile, "r");
      try {
        data = Buffer.alloc(e.length);
        await fh.read(data, 0, e.length, this.treeEnd + e.offset);
      } finally {
        await fh.close();
      }
    } else {
      const base = path.basename(this.dirFile).replace(/_dir\.vpk$/i, "");
      const part = path.join(path.dirname(this.dirFile), `${base}_${String(e.archiveIndex).padStart(3, "0")}.vpk`);
      const fh = await fs.open(part, "r");
      try {
        data = Buffer.alloc(e.length);
        await fh.read(data, 0, e.length, e.offset);
      } finally {
        await fh.close();
      }
    }
    return Buffer.concat([e.preload, data]);
  }
}
