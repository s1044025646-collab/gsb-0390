import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { rebuildDelta } from "./delta.js";
import { DEFAULT_LIMITS, DeltaError, type Limits, type RebuildResult } from "./types.js";

export const RULE_VERSION = "git-delta-one-hop-v1";

export interface RebuildRequest {
  base: Buffer;
  delta: Buffer;
  baseLocation?: string;
  deltaLocation?: string;
}

export interface JobRecord {
  id: string;
  status: "success" | "error";
  base_sha256: string;
  delta_sha256: string;
  target_sha256: string | null;
  base_location: string | null;
  delta_location: string | null;
  base_size: number;
  delta_size: number;
  target_size: number | null;
  rule_version: string;
  error_code: string | null;
  error_message: string | null;
  error_offset: number | null;
  created_at: string;
}

export interface StoredResult extends JobRecord {
  result?: RebuildResult;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export class JobStore {
  readonly dataDir: string;
  readonly sampleDir: string;
  private readonly db: DatabaseSync;
  private readonly limits: Limits;

  constructor(dataDir: string, limits: Partial<Limits> = {}) {
    this.dataDir = resolve(dataDir);
    this.sampleDir = join(this.dataDir, "samples");
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    mkdirSync(join(this.dataDir, "objects"), { recursive: true });
    mkdirSync(join(this.sampleDir, "base"), { recursive: true });
    mkdirSync(join(this.sampleDir, "delta"), { recursive: true });

    this.db = new DatabaseSync(join(this.dataDir, "delta.db"));
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('success','error')),
        base_sha256 TEXT NOT NULL,
        delta_sha256 TEXT NOT NULL,
        target_sha256 TEXT,
        base_location TEXT,
        delta_location TEXT,
        base_size INTEGER NOT NULL,
        delta_size INTEGER NOT NULL,
        target_size INTEGER,
        rule_version TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        error_offset INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS instructions (
        job_id TEXT NOT NULL,
        instruction_index INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('COPY','INSERT')),
        delta_start INTEGER NOT NULL,
        delta_end INTEGER NOT NULL,
        source_start INTEGER,
        source_end INTEGER,
        insert_start INTEGER,
        insert_end INTEGER,
        target_start INTEGER NOT NULL,
        target_end INTEGER NOT NULL,
        cumulative_length INTEGER NOT NULL,
        PRIMARY KEY(job_id, instruction_index),
        FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
    `);
  }

  resolveSample(kind: "base" | "delta", location: string): Buffer {
    if (isAbsolute(location) || location.includes("..")) {
      throw new DeltaError(
        "INVALID_SAMPLE_PATH",
        "样本路径必须是项目数据目录内的相对路径，且不能包含 ..",
        0
      );
    }
    const root = join(this.sampleDir, kind);
    const file = resolve(root, location);
    const rel = relative(root, file);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new DeltaError("INVALID_SAMPLE_PATH", "样本路径逃逸了允许的数据目录", 0);
    }
    if (!existsSync(file)) {
      throw new DeltaError("SAMPLE_NOT_FOUND", `样本不存在: ${location}`, 0);
    }
    return readFileSync(file);
  }

  private saveSample(kind: "base" | "delta", id: string, data: Buffer, providedLocation?: string) {
    const extension = kind === "base" ? "bin" : "delta";
    const safeLocation = join(kind, `${id}.${extension}`).replaceAll("\\", "/");
    const file = join(this.dataDir, "samples", safeLocation);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    return providedLocation ?? safeLocation;
  }

  rebuild(input: RebuildRequest): StoredResult {
    const id = randomUUID();
    const baseDigest = sha256(input.base);
    const deltaDigest = sha256(input.delta);
    let result: RebuildResult | undefined;
    let error: DeltaError | Error | undefined;

    try {
      result = rebuildDelta(input.base, input.delta, this.limits);
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    }

    const baseLocation = this.saveSample("base", id, input.base, input.baseLocation);
    const deltaLocation = this.saveSample("delta", id, input.delta, input.deltaLocation);
    const createdAt = new Date().toISOString();

    if (result) {
      const targetDigest = sha256(result.target);
      const objectPath = join(this.dataDir, "objects", `${id}.bin`);
      const tempPath = join(this.dataDir, "objects", `${id}.tmp-${process.pid}`);
      try {
        writeFileSync(tempPath, result.target);
        renameSync(tempPath, objectPath);
      } catch (err) {
        rmSync(tempPath, { force: true });
        throw err;
      }

      const insertJob = this.db.prepare(`
        INSERT INTO jobs (
          id,status,base_sha256,delta_sha256,target_sha256,base_location,delta_location,
          base_size,delta_size,target_size,rule_version,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      const insertInstruction = this.db.prepare(`
        INSERT INTO instructions (
          job_id,instruction_index,kind,delta_start,delta_end,source_start,source_end,
          insert_start,insert_end,target_start,target_end,cumulative_length
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `);

      this.db.exec("BEGIN IMMEDIATE");
      try {
        insertJob.run(
          id,
          "success",
          baseDigest,
          deltaDigest,
          targetDigest,
          baseLocation,
          deltaLocation,
          input.base.length,
          input.delta.length,
          result!.target.length,
          RULE_VERSION,
          createdAt
        );
        for (const ins of result!.instructions) {
          insertInstruction.run(
            id,
            ins.index,
            ins.kind,
            ins.deltaRange.start,
            ins.deltaRange.end,
            ins.sourceRange?.start ?? null,
            ins.sourceRange?.end ?? null,
            ins.insertDataRange?.start ?? null,
            ins.insertDataRange?.end ?? null,
            ins.targetRange.start,
            ins.targetRange.end,
            ins.cumulativeLength
          );
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
      return { ...this.getJob(id)!, result };
    }

    const deltaError = error instanceof DeltaError ? error : undefined;
    this.db
      .prepare(`
        INSERT INTO jobs (
          id,status,base_sha256,delta_sha256,base_location,delta_location,
          base_size,delta_size,rule_version,error_code,error_message,error_offset,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      .run(
        id,
        "error",
        baseDigest,
        deltaDigest,
        baseLocation,
        deltaLocation,
        input.base.length,
        input.delta.length,
        RULE_VERSION,
        deltaError?.code ?? "INTERNAL_ERROR",
        error?.message ?? "未知错误",
        deltaError?.offset ?? null,
        createdAt
      );

    return this.getJob(id)!;
  }

  getJob(id: string): JobRecord | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as JobRecord | undefined;
  }

  getInstructions(id: string) {
    const job = this.getJob(id);
    if (!job) return undefined;
    return this.db
      .prepare("SELECT * FROM instructions WHERE job_id=? ORDER BY instruction_index")
      .all(id);
  }

  findSource(id: string, targetOffset: number) {
    const job = this.getJob(id);
    if (!job) return undefined;
    if (job.status !== "success") {
      throw new DeltaError("JOB_NOT_SUCCESSFUL", "失败任务没有可查询的目标来源", 0);
    }
    if (!Number.isSafeInteger(targetOffset) || targetOffset < 0 || targetOffset >= (job.target_size ?? 0)) {
      throw new DeltaError(
        "INVALID_TARGET_OFFSET",
        `目标偏移必须位于 [0,${job.target_size ?? 0})`,
        0
      );
    }
    return this.db
      .prepare(
        `SELECT * FROM instructions
         WHERE job_id=? AND target_start<=? AND ?<target_end`
      )
      .get(id, targetOffset, targetOffset);
  }

  readTarget(id: string): Buffer | undefined {
    const file = join(this.dataDir, "objects", `${id}.bin`);
    if (!existsSync(file)) return undefined;
    return readFileSync(file);
  }

  history(limit = 50) {
    return this.db
      .prepare("SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(Math.min(Math.max(1, Math.trunc(limit)), 200));
  }

  close() {
    this.db.close();
  }
}
