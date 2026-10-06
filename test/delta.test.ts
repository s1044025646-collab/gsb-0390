import { test } from "node:test";
import assert from "node:assert/strict";
import { rebuildDelta, DeltaError, lookupSource, DEFAULT_LIMITS } from "../src/delta.js";

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");

function expectErr(code: string, fn: () => unknown): DeltaError {
  try {
    fn();
  } catch (e: any) {
    assert.equal(e.code, code, `期望错误码 ${code}，实际 ${e.code}: ${e.message}`);
    return e as DeltaError;
  }
  assert.fail(`期望抛出 ${code}，但未抛错`);
}

test("演示：abcde + 05 05 90 02 01 58 91 03 02 => abXde，逐条核对", () => {
  const base = Buffer.from("abcde", "utf8");
  const delta = hex("05 05 90 02 01 58 91 03 02");
  const r = rebuildDelta(base, delta);
  assert.equal(r.target.toString("utf8"), "abXde");
  assert.equal(r.target.toString("hex"), "6162586465");
  assert.equal(r.baseLength, 5);
  assert.equal(r.targetLength, 5);
  assert.equal(r.instructions.length, 3);

  const [c1, ins, c2] = r.instructions;
  // COPY 1: delta[2,4) 90 02 -> base[0,2) -> target[0,2)
  assert.deepEqual(
    [c1.type, c1.deltaOffset, c1.deltaLength, c1.targetOffset, c1.targetLength],
    ["copy", 2, 2, 0, 2],
  );
  assert.equal((c1 as any).copyOffset, 0);
  assert.equal((c1 as any).copyLength, 2);
  // INSERT: delta[4,6) 01 58 -> target[2,3)
  assert.deepEqual(
    [ins.type, ins.deltaOffset, ins.deltaLength, ins.targetOffset, ins.targetLength],
    ["insert", 4, 2, 2, 1],
  );
  assert.equal((ins as any).insertOffset, 5);
  assert.equal((ins as any).insertLength, 1);
  // COPY 2: delta[6,9) 91 03 02 -> base[3,5) -> target[3,5)
  assert.deepEqual(
    [c2.type, c2.deltaOffset, c2.deltaLength, c2.targetOffset, c2.targetLength],
    ["copy", 6, 3, 3, 2],
  );
  assert.equal((c2 as any).copyOffset, 3);
  assert.equal((c2 as any).copyLength, 2);

  // 来源覆盖每个目标字节且不重叠
  let cursor = 0;
  for (const i of r.instructions) {
    assert.equal(i.targetOffset, cursor);
    cursor += i.targetLength;
  }
  assert.equal(cursor, 5);
  for (let off = 0; off < 5; off++) {
    const src = lookupSource(r.instructions, off)!;
    assert.ok(off >= src.targetOffset && off < src.targetOffset + src.targetLength);
  }
  assert.equal(lookupSource(r.instructions, 5), null);
});

test("COPY 长度字段全缺（size==0）代表 65536 字节", () => {
  const base = Buffer.alloc(70000);
  for (let i = 0; i < base.length; i++) base[i] = i % 251;
  // hdrBase: 70000 = 0x11170 -> varint: F0 A2 04；hdrTarget 65536 -> 80 80 04；COPY 0x81（仅偏移字节0=0，无长度字节）
  const delta = Buffer.concat([hex("F0 A2 04 80 80 04"), Buffer.from([0x81, 0x00])]);
  const r = rebuildDelta(base, delta);
  assert.equal(r.target.length, 65536);
  assert.ok(r.target.equals(base.subarray(0, 65536)));
  const c = r.instructions[0] as any;
  assert.equal(c.copyOffset, 0);
  assert.equal(c.copyLength, 65536);
});

test("非连续偏移/长度字节标志：缺失字节为零且保持各自小端位置", () => {
  const base = Buffer.alloc(70000);
  for (let i = 0; i < base.length; i++) base[i] = (i * 7) % 253;
  // opcode 0x82：仅偏移字节1（bit1），值 0x01 -> 偏移 256；无长度字节 -> 65536
  // 目标头 65536 = 0x10000 -> varint 80 80 04
  const delta = Buffer.concat([hex("F0 A2 04 80 80 04"), Buffer.from([0x82, 0x01])]);
  const r = rebuildDelta(base, delta);
  assert.equal(r.target.length, 65536);
  assert.ok(r.target.equals(base.subarray(256, 256 + 65536)));
  // opcode 0xA4：偏移字节2（bit2）值 0x01 -> 偏移 65536；长度字节1（bit5）值 0x01 -> 长度 256
  const d2 = Buffer.concat([hex("F0 A2 04"), hex("80 02"), Buffer.from([0xa4, 0x01, 0x01])]);
  const r2 = rebuildDelta(base, d2);
  assert.equal(r2.target.length, 256);
  assert.ok(r2.target.equals(base.subarray(65536, 65536 + 256)));
  const c = r2.instructions[0] as any;
  assert.equal(c.copyOffset, 65536);
  assert.equal(c.copyLength, 256);
});

test("COPY 源只能是基对象，不能引用已产生的目标输出", () => {
  // 基对象只有 3 字节，INSERT 3 字节后 COPY 偏移 3 越界（若误用目标当源则不会报错）
  const base = Buffer.from("abc");
  const delta = hex("03 06 03 585858 91 03 03");
  expectErr("ERR_COPY_OUT_OF_RANGE", () => rebuildDelta(base, delta));
});

test("空目标合法：两个完整头部 + 空指令区", () => {
  const r = rebuildDelta(Buffer.from("abc"), hex("03 00"));
  assert.equal(r.target.length, 0);
  assert.equal(r.instructions.length, 0);
});

test("空基对象 + 纯 INSERT", () => {
  const r = rebuildDelta(Buffer.alloc(0), hex("00 03 03 414243"));
  assert.equal(r.target.toString(), "ABC");
});

test("基长度声明不匹配", () => {
  expectErr("ERR_BASE_SIZE_MISMATCH", () => rebuildDelta(Buffer.from("abc"), hex("04 00")));
});

test("全零 opcode 非法，报错位置准确", () => {
  const e = expectErr("ERR_ZERO_OPCODE", () => rebuildDelta(Buffer.from("abc"), hex("03 01 00")));
  assert.equal(e.position, 2);
});

test("截断头部：只有一个字节", () => {
  expectErr("ERR_VARINT_TRUNCATED", () => rebuildDelta(Buffer.from("abc"), hex("03")));
});

test("截断头部：继续位置位但流结束", () => {
  expectErr("ERR_VARINT_TRUNCATED", () => rebuildDelta(Buffer.from("abc"), hex("83")));
});

test("变长整数超过位数上限", () => {
  const long = Buffer.alloc(12, 0x80); // 数据位全零但继续位一直置位
  expectErr("ERR_VARINT_TOO_LONG", () => rebuildDelta(Buffer.from("abc"), long));
});

test("COPY 可选字段缺失（截断）", () => {
  // 0x93 需要偏移字节0、长度字节0和1，但流提前结束
  expectErr("ERR_COPY_FIELD_TRUNCATED", () => rebuildDelta(Buffer.from("abcde"), hex("05 05 93 01")));
});

test("COPY 越界：offset+size 超出基对象", () => {
  expectErr("ERR_COPY_OUT_OF_RANGE", () => rebuildDelta(Buffer.from("abcde"), hex("05 05 90 06")));
});

test("INSERT 内联字节不足", () => {
  const e = expectErr("ERR_INSERT_TRUNCATED", () => rebuildDelta(Buffer.from("abcde"), hex("05 05 05 4142")));
  assert.equal(e.position, 3);
});

test("声明目标过短：累计输出超出", () => {
  expectErr("ERR_TARGET_OVERRUN", () => rebuildDelta(Buffer.from("abcde"), hex("05 01 90 02")));
});

test("声明目标过长：流结束输出不足", () => {
  expectErr("ERR_TARGET_UNDERRUN", () => rebuildDelta(Buffer.from("abcde"), hex("05 09 90 02")));
});

test("声明目标长度超过限额", () => {
  const limits = { ...DEFAULT_LIMITS, maxTargetSize: 4 };
  expectErr("ERR_LIMIT_EXCEEDED", () => rebuildDelta(Buffer.from("abcde"), hex("05 05 90 02 01 58 91 03 02"), limits));
});

test("多字节变长整数头（非单字节长度）", () => {
  const base = Buffer.alloc(300, 0x61);
  // 300 = 0xAC 0x02；目标 3：INSERT "XYZ"
  const delta = Buffer.concat([hex("AC 02 03"), Buffer.from([0x03]), Buffer.from("XYZ")]);
  const r = rebuildDelta(base, delta);
  assert.equal(r.target.toString(), "XYZ");
});
