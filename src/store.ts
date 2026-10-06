import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Instruction, RULE_VERSION } from "./delta.js";

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface JobView extends Omit<JobRow, "instructions"> {
  instructions: Instruction[] | null;
}

export function JobViewOf(job: JobRow): JobView {
  return { ...job, instructions: job.instructions ? (JSON.parse(job.instructions) as Instruction[]) : null };
}

export interface SampleRow {
  id: number;
  sha256: string;
  size: number;
  source: string;
  locator: string | null;
  created_at: string;
}

export interface JobRow {
  id: number;
  base_sample_id: number;
  delta_sample_id: number;
  base_sha256: string;
  delta_sha256: string;
  target_sha256: string | null;
  rule_version: string;
  status: "success" | "failed";
  error_code: string | null;
  error_message: string | null;
  error_position: number | null;
  instructions: string | null;
  created_at: string;
}

export class Store {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  private readonly objectsDir: string;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    this.objectsDir = path.join(this.dataDir, "objects");
    fs.mkdirSync(this.objectsDir, { recursive: true });
    this.db = new DatabaseSync(path.join(this.dataDir, "delta.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        source TEXT NOT NULL,
        locator TEXT,
        data BLOB,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        base_sample_id INTEGER NOT NULL REFERENCES samples(id),
        delta_sample_id INTEGER NOT NULL REFERENCES samples(id),
        base_sha256 TEXT NOT NULL,
        delta_sha256 TEXT NOT NULL,
        target_sha256 TEXT,
        rule_version TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        error_position INTEGER,
        instructions TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  addSample(data: Buffer, source: "hex" | "file", locator: string | null): SampleRow {
    const digest = sha256Hex(data);
    const stmt = this.db.prepare(
      "INSERT INTO samples (sha256, size, source, locator, data) VALUES (?, ?, ?, ?, ?)",
    );
    const info = stmt.run(digest, data.length, source, locator, source === "hex" ? data : null);
    return this.getSample(Number(info.lastInsertRowid))!;
  }

  getSample(id: number): SampleRow | null {
    const row = this.db
      .prepare("SELECT id, sha256, size, source, locator, created_at FROM samples WHERE id = ?")
      .get(id) as unknown as SampleRow | undefined;
    return row ?? null;
  }

  readSampleData(id: number): Buffer {
    const row = this.db.prepare("SELECT * FROM samples WHERE id = ?").get(id) as any;
    if (!row) throw new Error(`样本 ${id} 不存在`);
    if (row.source === "hex") return Buffer.from(row.data as Uint8Array);
    const abs = path.resolve(this.dataDir, "..", row.locator as string);
    const buf = fs.readFileSync(abs);
    if (sha256Hex(buf) !== row.sha256) {
      throw new Error(`样本 ${id} 的文件内容已变化，摘要不匹配：${row.locator}`);
    }
    return buf;
  }

  createJob(input: {
    baseSampleId: number;
    deltaSampleId: number;
    baseSha256: string;
    deltaSha256: string;
    target?: Buffer;
    instructions?: Instruction[];
    error?: { code: string; message: string; position?: number };
  }): JobRow {
    const success = input.target !== undefined;
    const targetSha = success ? sha256Hex(input.target!) : null;
    const stmt = this.db.prepare(`
      INSERT INTO jobs (base_sample_id, delta_sample_id, base_sha256, delta_sha256,
        target_sha256, rule_version, status, error_code, error_message, error_position, instructions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      input.baseSampleId,
      input.deltaSampleId,
      input.baseSha256,
      input.deltaSha256,
      targetSha,
      RULE_VERSION,
      success ? "success" : "failed",
      input.error?.code ?? null,
      input.error?.message ?? null,
      input.error?.position ?? null,
      success ? JSON.stringify(input.instructions ?? []) : null,
    );
    if (success) {
      const finalPath = path.join(this.objectsDir, targetSha!);
      const tmpPath = finalPath + `.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmpPath, input.target!);
      fs.renameSync(tmpPath, finalPath);
    }
    return this.getJob(Number(info.lastInsertRowid))!;
  }

  getJob(id: number): JobRow | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as unknown as JobRow | undefined;
    return row ?? null;
  }

  listJobs(limit = 50): JobRow[] {
    return this.db
      .prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as JobRow[];
  }

  readObject(sha256: string): Buffer | null {
    const p = path.join(this.objectsDir, sha256);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
}
