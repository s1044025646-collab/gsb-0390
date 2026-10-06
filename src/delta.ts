/**
 * Git delta 指令流解释器（一跳、已解压的 delta，不解析 pack 容器）。
 *
 * 字节语法：
 *   delta := hdrBase hdrTarget instr*
 *   hdrBase / hdrTarget := 变长整数，每字节低 7 位为数据（小端序组），最高位为继续位
 *   instr := COPY | INSERT
 *   COPY   := 1xxxxxxx [off0] [off1] [off2] [off3] [size0] [size1] [size2]
 *             低 4 位控制 4 个偏移字节是否存在，接下来 3 位控制 3 个长度字节；
 *             缺失字节视为 0（按各自小端位置组装，不压缩）；size==0 表示 0x10000。
 *   INSERT := 0xxxxxxx (x != 0) 后跟 x 个内联字节；0x00 为非法指令。
 */

export const RULE_VERSION = "git-delta-v1";

export interface Limits {
  maxBaseSize: number;
  maxDeltaSize: number;
  maxTargetSize: number;
  maxVarintBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxBaseSize: 64 * 1024 * 1024,
  maxDeltaSize: 64 * 1024 * 1024,
  maxTargetSize: 256 * 1024 * 1024,
  maxVarintBytes: 9, // 最多 63 位，足以覆盖安全整数范围
};

export type DeltaErrorCode =
  | "ERR_LIMIT_EXCEEDED"
  | "ERR_VARINT_TOO_LONG"
  | "ERR_VARINT_TRUNCATED"
  | "ERR_BASE_SIZE_MISMATCH"
  | "ERR_ZERO_OPCODE"
  | "ERR_COPY_FIELD_TRUNCATED"
  | "ERR_COPY_OUT_OF_RANGE"
  | "ERR_INSERT_TRUNCATED"
  | "ERR_TARGET_OVERRUN"
  | "ERR_TARGET_UNDERRUN"
  | "ERR_UNSAFE_INTEGER";

export class DeltaError extends Error {
  constructor(
    public readonly code: DeltaErrorCode,
    message: string,
    public readonly position?: number,
  ) {
    super(message);
    this.name = "DeltaError";
  }
}

export interface CopyInstruction {
  index: number;
  type: "copy";
  deltaOffset: number; // 指令首字节在 delta 内的偏移
  deltaLength: number; // 指令占用字节数（含 opcode 与可选字段）
  opcode: number;
  copyOffset: number; // 基对象源偏移
  copyLength: number;
  targetOffset: number; // 目标写入偏移
  targetLength: number;
}

export interface InsertInstruction {
  index: number;
  type: "insert";
  deltaOffset: number;
  deltaLength: number;
  opcode: number;
  insertOffset: number; // 内联数据在 delta 内的偏移
  insertLength: number;
  targetOffset: number;
  targetLength: number;
}

export type Instruction = CopyInstruction | InsertInstruction;

export interface RebuildResult {
  target: Buffer;
  baseLength: number;
  targetLength: number;
  instructions: Instruction[];
  ruleVersion: string;
}

interface Varint {
  value: number;
  next: number;
}

function readVarint(buf: Buffer, pos: number, limits: Limits): Varint {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < limits.maxVarintBytes; i++) {
    if (pos + i >= buf.length) {
      throw new DeltaError(
        "ERR_VARINT_TRUNCATED",
        `变长整数在偏移 ${pos + i} 处被截断（继续位仍置位或流结束）`,
        pos + i,
      );
    }
    const b = buf[pos + i];
    value += (b & 0x7f) * 2 ** shift;
    if (value > Number.MAX_SAFE_INTEGER) {
      throw new DeltaError("ERR_UNSAFE_INTEGER", `变长整数超出安全整数范围（起始偏移 ${pos}）`, pos);
    }
    if ((b & 0x80) === 0) {
      return { value, next: pos + i + 1 };
    }
    shift += 7;
  }
  throw new DeltaError(
    "ERR_VARINT_TOO_LONG",
    `变长整数超过 ${limits.maxVarintBytes} 字节上限（起始偏移 ${pos}）`,
    pos,
  );
}

export function rebuildDelta(base: Buffer, delta: Buffer, limits: Limits = DEFAULT_LIMITS): RebuildResult {
  if (base.length > limits.maxBaseSize) {
    throw new DeltaError("ERR_LIMIT_EXCEEDED", `基对象大小 ${base.length} 超过上限 ${limits.maxBaseSize}`);
  }
  if (delta.length > limits.maxDeltaSize) {
    throw new DeltaError("ERR_LIMIT_EXCEEDED", `delta 大小 ${delta.length} 超过上限 ${limits.maxDeltaSize}`);
  }

  // 头部：基对象长度、目标长度
  const hdrBase = readVarint(delta, 0, limits);
  const hdrTarget = readVarint(delta, hdrBase.next, limits);
  if (hdrBase.value !== base.length) {
    throw new DeltaError(
      "ERR_BASE_SIZE_MISMATCH",
      `头部声明基对象长度 ${hdrBase.value}，实际为 ${base.length}`,
      0,
    );
  }
  if (hdrTarget.value > limits.maxTargetSize) {
    throw new DeltaError(
      "ERR_LIMIT_EXCEEDED",
      `声明目标长度 ${hdrTarget.value} 超过上限 ${limits.maxTargetSize}`,
      hdrBase.next,
    );
  }

  // 先验证声明长度，再分配输出缓冲
  const target = Buffer.alloc(hdrTarget.value);
  const instructions: Instruction[] = [];
  let pos = hdrTarget.next;
  let out = 0;

  while (pos < delta.length) {
    const deltaOffset = pos;
    const opcode = delta[pos];
    pos += 1;

    if (opcode & 0x80) {
      // COPY：低 4 位 = 偏移字节标志，接下来 3 位 = 长度字节标志
      let copyOffset = 0;
      let copyLength = 0;
      for (let i = 0; i < 4; i++) {
        if (opcode & (1 << i)) {
          if (pos >= delta.length) {
            throw new DeltaError(
              "ERR_COPY_FIELD_TRUNCATED",
              `COPY 偏移字节 ${i} 在偏移 ${pos} 处缺失（指令起始 ${deltaOffset}）`,
              pos,
            );
          }
          copyOffset += delta[pos] * 2 ** (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i++) {
        if (opcode & (0x10 << i)) {
          if (pos >= delta.length) {
            throw new DeltaError(
              "ERR_COPY_FIELD_TRUNCATED",
              `COPY 长度字节 ${i} 在偏移 ${pos} 处缺失（指令起始 ${deltaOffset}）`,
              pos,
            );
          }
          copyLength += delta[pos] * 2 ** (8 * i);
          pos += 1;
        }
      }
      if (copyLength === 0) copyLength = 0x10000;
      if (!Number.isSafeInteger(copyOffset) || !Number.isSafeInteger(copyOffset + copyLength)) {
        throw new DeltaError("ERR_UNSAFE_INTEGER", `COPY 源范围超出安全整数（指令起始 ${deltaOffset}）`, deltaOffset);
      }
      if (copyOffset + copyLength > base.length) {
        throw new DeltaError(
          "ERR_COPY_OUT_OF_RANGE",
          `COPY 源范围 [${copyOffset}, ${copyOffset + copyLength}) 超出基对象长度 ${base.length}（指令起始 ${deltaOffset}）`,
          deltaOffset,
        );
      }
      if (out + copyLength > hdrTarget.value) {
        throw new DeltaError(
          "ERR_TARGET_OVERRUN",
          `COPY 使累计输出 ${out + copyLength} 超过声明目标长度 ${hdrTarget.value}（指令起始 ${deltaOffset}）`,
          deltaOffset,
        );
      }
      base.copy(target, out, copyOffset, copyOffset + copyLength);
      instructions.push({
        index: instructions.length,
        type: "copy",
        deltaOffset,
        deltaLength: pos - deltaOffset,
        opcode,
        copyOffset,
        copyLength,
        targetOffset: out,
        targetLength: copyLength,
      });
      out += copyLength;
    } else if (opcode !== 0) {
      // INSERT：低 7 位为内联字节数
      const insertLength = opcode;
      if (pos + insertLength > delta.length) {
        throw new DeltaError(
          "ERR_INSERT_TRUNCATED",
          `INSERT 需要 ${insertLength} 字节，delta 在偏移 ${pos} 后仅剩 ${delta.length - pos}（指令起始 ${deltaOffset}）`,
          pos,
        );
      }
      if (out + insertLength > hdrTarget.value) {
        throw new DeltaError(
          "ERR_TARGET_OVERRUN",
          `INSERT 使累计输出 ${out + insertLength} 超过声明目标长度 ${hdrTarget.value}（指令起始 ${deltaOffset}）`,
          deltaOffset,
        );
      }
      delta.copy(target, out, pos, pos + insertLength);
      instructions.push({
        index: instructions.length,
        type: "insert",
        deltaOffset,
        deltaLength: 1 + insertLength,
        opcode,
        insertOffset: pos,
        insertLength,
        targetOffset: out,
        targetLength: insertLength,
      });
      pos += insertLength;
      out += insertLength;
    } else {
      throw new DeltaError("ERR_ZERO_OPCODE", `偏移 ${deltaOffset} 处出现全零指令（非法）`, deltaOffset);
    }
  }

  if (out !== hdrTarget.value) {
    throw new DeltaError(
      "ERR_TARGET_UNDERRUN",
      `流结束时累计输出 ${out} 不等于声明目标长度 ${hdrTarget.value}`,
      pos,
    );
  }

  return {
    target,
    baseLength: base.length,
    targetLength: hdrTarget.value,
    instructions,
    ruleVersion: RULE_VERSION,
  };
}

/** 按目标偏移查询来源指令；未命中返回 null（理论上成功结果覆盖每个字节）。 */
export function lookupSource(instructions: Instruction[], targetOffset: number): Instruction | null {
  for (const ins of instructions) {
    if (targetOffset >= ins.targetOffset && targetOffset < ins.targetOffset + ins.targetLength) return ins;
  }
  return null;
}
