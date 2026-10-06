import * as fs from "node:fs";
import * as path from "node:path";
import { rebuildDelta, Limits, DEFAULT_LIMITS } from "./delta.js";
import { Store, sha256Hex, JobView, JobViewOf } from "./store.js";

export interface SampleInput {
  hex?: string;
  file?: string;
  id?: number;
}

export class InputError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InputError";
  }
}

export function parseHex(hex: string): Buffer {
  const clean = hex.replace(/[\s,]/g, "").toLowerCase();
  if (!/^(?:[0-9a-f]{2})*$/.test(clean) || clean.length === 0) {
    throw new InputError("ERR_BAD_HEX", "十六进制输入非法：必须为偶数长度的 0-9a-f 字符");
  }
  return Buffer.from(clean, "hex");
}

/** 解析样本输入：hex 直接入库；file 只记录项目内相对定位与摘要；id 复用已有样本。 */
export function resolveSample(store: Store, input: SampleInput, limits: Limits = DEFAULT_LIMITS) {
  const kinds = [input.hex !== undefined, input.file !== undefined, input.id !== undefined].filter(Boolean).length;
  if (kinds !== 1) throw new InputError("ERR_BAD_INPUT", "必须且只能提供 hex、file、id 之一");
  if (input.id !== undefined) {
    const row = store.getSample(input.id);
    if (!row) throw new InputError("ERR_SAMPLE_NOT_FOUND", `样本 ${input.id} 不存在`);
    return { sampleId: row.id, sha256: row.sha256, data: store.readSampleData(row.id) };
  }
  if (input.hex !== undefined) {
    const data = parseHex(input.hex);
    if (data.length > limits.maxDeltaSize && data.length > limits.maxBaseSize) {
      throw new InputError("ERR_LIMIT_EXCEEDED", `样本大小 ${data.length} 超过上限`);
    }
    const row = store.addSample(data, "hex", null);
    return { sampleId: row.id, sha256: row.sha256, data };
  }
  // file：必须是项目内（数据目录上一级为项目根）已存在文件，记录相对定位
  const projectRoot = path.resolve(store.dataDir, "..");
  const abs = path.resolve(projectRoot, input.file!);
  if (!abs.startsWith(projectRoot + path.sep)) {
    throw new InputError("ERR_PATH_OUTSIDE_PROJECT", `文件必须位于项目目录内：${input.file}`);
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new InputError("ERR_FILE_NOT_FOUND", `文件不存在：${input.file}`);
  }
  const data = fs.readFileSync(abs);
  const locator = path.relative(projectRoot, abs);
  const row = store.addSample(data, "file", locator);
  return { sampleId: row.id, sha256: row.sha256, data };
}

export function runRebuild(store: Store, base: SampleInput, delta: SampleInput, limits?: Limits) {
  const baseS = resolveSample(store, base, limits);
  const deltaS = resolveSample(store, delta, limits);
  try {
    const result = rebuildDelta(baseS.data, deltaS.data, limits);
    const job = store.createJob({
      baseSampleId: baseS.sampleId,
      deltaSampleId: deltaS.sampleId,
      baseSha256: baseS.sha256,
      deltaSha256: deltaS.sha256,
      target: result.target,
      instructions: result.instructions,
    });
    return { job, result };
  } catch (err: any) {
    const job = store.createJob({
      baseSampleId: baseS.sampleId,
      deltaSampleId: deltaS.sampleId,
      baseSha256: baseS.sha256,
      deltaSha256: deltaS.sha256,
      error: {
        code: err.code ?? "ERR_INTERNAL",
        message: err.message ?? String(err),
        position: err.position,
      },
    });
    return { job, result: null };
  }
}

export function jobView(store: Store, jobId: number): JobView | null {
  const job = store.getJob(jobId);
  if (!job) return null;
  return JobViewOf(job);
}

export { sha256Hex };
