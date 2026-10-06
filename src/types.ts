export type InstructionKind = "COPY" | "INSERT";

export interface ByteRange {
  start: number;
  end: number;
}

export interface InstructionReport {
  index: number;
  kind: InstructionKind;
  deltaRange: ByteRange;
  sourceRange?: ByteRange;
  insertDataRange?: ByteRange;
  targetRange: ByteRange;
  cumulativeLength: number;
}

export interface RebuildResult {
  target: Buffer;
  baseLength: number;
  declaredTargetLength: number;
  instructions: InstructionReport[];
}

export class DeltaError extends Error {
  code: string;
  offset: number;

  constructor(code: string, message: string, offset: number) {
    super(message);
    this.name = "DeltaError";
    this.code = code;
    this.offset = offset;
  }
}

export interface Limits {
  maxBaseSize: number;
  maxDeltaSize: number;
  maxDeclaredTargetSize: number;
  maxVarintBytes: number;
  maxOutputMemory: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxBaseSize: 64 * 1024 * 1024,
  maxDeltaSize: 16 * 1024 * 1024,
  maxDeclaredTargetSize: 64 * 1024 * 1024,
  maxVarintBytes: 9,
  maxOutputMemory: 80 * 1024 * 1024
};
