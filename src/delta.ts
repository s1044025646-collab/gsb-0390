import {
  DEFAULT_LIMITS,
  DeltaError,
  type InstructionReport,
  type Limits,
  type RebuildResult
} from "./types.js";

interface VarintResult {
  value: number;
  next: number;
  range: { start: number; end: number };
}

function readVarint(delta: Buffer, start: number, limits: Limits, name: string): VarintResult {
  let value = 0;
  let shift = 0;
  let offset = start;

  while (true) {
    if (offset - start >= limits.maxVarintBytes) {
      throw new DeltaError(
        "VARINT_TOO_LONG",
        `${name} 变长整数超过 ${limits.maxVarintBytes} 字节`,
        start
      );
    }
    if (offset >= delta.length) {
      throw new DeltaError("TRUNCATED_HEADER", `${name} 变长整数被截断`, offset);
    }

    const byte = delta[offset]!;
    const digit = byte & 0x7f;
    if (shift >= 32 || digit * 2 ** shift > Number.MAX_SAFE_INTEGER - value) {
      throw new DeltaError("LENGTH_UNSAFE", `${name} 超出 JavaScript 安全整数范围`, offset);
    }
    value += digit * 2 ** shift;
    offset += 1;

    if ((byte & 0x80) === 0) {
      return { value, next: offset, range: { start, end: offset } };
    }
    shift += 7;
  }
}

function checkedAdd(left: number, right: number, offset: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || right < 0) {
    throw new DeltaError("LENGTH_UNSAFE", "长度计算不是安全非负整数", offset);
  }
  if (left > Number.MAX_SAFE_INTEGER - right) {
    throw new DeltaError("LENGTH_UNSAFE", "长度相加超出安全整数范围", offset);
  }
  return left + right;
}

export function rebuildDelta(
  base: Buffer,
  delta: Buffer,
  partialLimits: Partial<Limits> = {}
): RebuildResult {
  const limits = { ...DEFAULT_LIMITS, ...partialLimits };

  if (base.length > limits.maxBaseSize) {
    throw new DeltaError("BASE_TOO_LARGE", `基对象超过 ${limits.maxBaseSize} 字节限制`, 0);
  }
  if (delta.length > limits.maxDeltaSize) {
    throw new DeltaError("DELTA_TOO_LARGE", `delta 超过 ${limits.maxDeltaSize} 字节限制`, 0);
  }

  const baseLength = readVarint(delta, 0, limits, "基对象长度");
  const targetLength = readVarint(delta, baseLength.next, limits, "目标对象长度");
  let cursor = targetLength.next;

  if (baseLength.value !== base.length) {
    throw new DeltaError(
      "BASE_LENGTH_MISMATCH",
      `声明基对象长度 ${baseLength.value} 与实际 ${base.length} 不一致`,
      baseLength.range.start
    );
  }
  if (targetLength.value > limits.maxDeclaredTargetSize) {
    throw new DeltaError(
      "DECLARED_TARGET_TOO_LARGE",
      `声明目标长度超过 ${limits.maxDeclaredTargetSize} 字节`,
      targetLength.range.start
    );
  }
  if (targetLength.value > limits.maxOutputMemory) {
    throw new DeltaError(
      "OUTPUT_MEMORY_LIMIT",
      `目标对象超过 ${limits.maxOutputMemory} 字节内存预算`,
      targetLength.range.start
    );
  }

  const output = Buffer.allocUnsafe(targetLength.value);
  const instructions: InstructionReport[] = [];
  let outputOffset = 0;

  while (cursor < delta.length) {
    const opcodeOffset = cursor;
    const opcode = delta[cursor]!;
    cursor += 1;

    if (opcode === 0) {
      throw new DeltaError("INVALID_OPCODE", "全零 opcode 非法", opcodeOffset);
    }

    if ((opcode & 0x80) !== 0) {
      let sourceOffset = 0;
      let copyLength = 0;
      const fieldStart = cursor;

      for (let bit = 0; bit < 7; bit += 1) {
        if ((opcode & (1 << bit)) === 0) {
          continue;
        }
        if (cursor >= delta.length) {
          throw new DeltaError(
            "TRUNCATED_COPY_FIELD",
            `COPY 第 ${bit} 位对应的字节缺失`,
            cursor
          );
        }
        const value = delta[cursor]!;
        cursor += 1;
        if (bit < 4) {
          sourceOffset += value << (bit * 8);
        } else {
          copyLength += value << ((bit - 4) * 8);
        }
      }

      if (copyLength === 0) {
        copyLength = 0x10000;
      }

      const sourceEnd = checkedAdd(sourceOffset, copyLength, fieldStart);
      const newOutputOffset = checkedAdd(outputOffset, copyLength, opcodeOffset);
      if (sourceEnd > base.length) {
        throw new DeltaError(
          "COPY_OUT_OF_RANGE",
          `COPY 源范围 [${sourceOffset},${sourceEnd}) 超出基对象长度 ${base.length}`,
          opcodeOffset
        );
      }
      if (newOutputOffset > targetLength.value) {
        throw new DeltaError(
          "OUTPUT_TOO_LONG",
          `COPY 使输出长度 ${newOutputOffset} 超过声明目标长度 ${targetLength.value}`,
          opcodeOffset
        );
      }

      base.copy(output, outputOffset, sourceOffset, sourceEnd);
      instructions.push({
        index: instructions.length,
        kind: "COPY",
        deltaRange: { start: opcodeOffset, end: cursor },
        sourceRange: { start: sourceOffset, end: sourceEnd },
        targetRange: { start: outputOffset, end: newOutputOffset },
        cumulativeLength: newOutputOffset
      });
      outputOffset = newOutputOffset;
    } else {
      const insertLength = opcode & 0x7f;
      const dataStart = cursor;
      const dataEnd = checkedAdd(dataStart, insertLength, opcodeOffset);
      if (dataEnd > delta.length) {
        throw new DeltaError(
          "TRUNCATED_INSERT_DATA",
          `INSERT 内联数据需要 ${insertLength} 字节，但流在 ${delta.length} 结束`,
          dataStart
        );
      }
      const newOutputOffset = checkedAdd(outputOffset, insertLength, opcodeOffset);
      if (newOutputOffset > targetLength.value) {
        throw new DeltaError(
          "OUTPUT_TOO_LONG",
          `INSERT 使输出长度 ${newOutputOffset} 超过声明目标长度 ${targetLength.value}`,
          opcodeOffset
        );
      }

      delta.copy(output, outputOffset, dataStart, dataEnd);
      instructions.push({
        index: instructions.length,
        kind: "INSERT",
        deltaRange: { start: opcodeOffset, end: dataEnd },
        insertDataRange: { start: dataStart, end: dataEnd },
        targetRange: { start: outputOffset, end: newOutputOffset },
        cumulativeLength: newOutputOffset
      });
      outputOffset = newOutputOffset;
      cursor = dataEnd;
    }
  }

  if (outputOffset !== targetLength.value) {
    throw new DeltaError(
      "TARGET_LENGTH_MISMATCH",
      `实际重建长度 ${outputOffset} 与声明目标长度 ${targetLength.value} 不一致`,
      cursor
    );
  }

  return {
    target: output,
    baseLength: baseLength.value,
    declaredTargetLength: targetLength.value,
    instructions
  };
}
