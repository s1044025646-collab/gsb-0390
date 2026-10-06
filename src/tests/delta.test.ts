import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { rebuildDelta } from "../delta.js";
import { JobStore } from "../storage.js";

function varint(value: number): Buffer {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

test("演示 delta 重建 abXde", () => {
  const result = rebuildDelta(
    Buffer.from("abcde"),
    Buffer.from("050590020158910302", "hex")
  );
  assert.equal(result.target.toString("ascii"), "abXde");
  assert.deepEqual(result.instructions.map((item) => item.kind), ["COPY", "INSERT", "COPY"]);
  assert.deepEqual(result.instructions[0]?.sourceRange, { start: 0, end: 2 });
  assert.deepEqual(result.instructions[1]?.insertDataRange, { start: 5, end: 6 });
  assert.deepEqual(result.instructions[2]?.sourceRange, { start: 3, end: 5 });
});

test("COPY 零长度字段表示 65536", () => {
  const base = Buffer.alloc(65537);
  for (let index = 0; index < base.length; index += 1) {
    base[index] = index % 251;
  }
  const delta = Buffer.concat([
    varint(base.length),
    varint(65536),
    Buffer.from([0x80])
  ]);
  const result = rebuildDelta(base, delta);
  assert.equal(result.target.length, 65536);
  assert.equal(result.instructions[0]?.sourceRange?.end, 65536);
  assert.deepEqual(result.instructions[0]?.targetRange, { start: 0, end: 65536 });
});

test("非连续偏移字节标志按各自小端位置组装", () => {
  const base = Buffer.alloc(300);
  base[258] = 0x5a;
  const delta = Buffer.concat([
    varint(base.length),
    varint(1),
    Buffer.from([
    0x93, 0x02, 0x01, 0x01
    ])
  ]);
  const result = rebuildDelta(base, delta);
  assert.equal(result.target.length, 1);
  assert.equal(result.target[0], 0x5a);
  assert.deepEqual(result.instructions[0]?.sourceRange, { start: 258, end: 259 });
});

test("允许零长度目标但要求两个完整头部", () => {
  const result = rebuildDelta(Buffer.alloc(0), Buffer.from([0, 0]));
  assert.equal(result.target.length, 0);
  assert.deepEqual(result.instructions, []);
});

const errorCases = [
  ["坏基长度", Buffer.from("abc"), Buffer.from("0503"), "BASE_LENGTH_MISMATCH", 0],
  ["全零 opcode", Buffer.alloc(0), Buffer.concat([varint(0), varint(0), Buffer.from([0])]), "INVALID_OPCODE", 2],
  ["截断头部", Buffer.alloc(0), Buffer.from([0x80]), "TRUNCATED_HEADER", 1],
  ["缺失 COPY 字段", Buffer.from("abc"), Buffer.concat([varint(3), varint(3), Buffer.from([0x91])]), "TRUNCATED_COPY_FIELD", 3],
  ["越界复制", Buffer.from("abc"), Buffer.concat([varint(3), varint(3), Buffer.from([0x90, 0x05])]), "COPY_OUT_OF_RANGE", 2],
  ["声明过短", Buffer.from("abc"), Buffer.concat([varint(3), varint(2), Buffer.from([0x90, 0x03])]), "OUTPUT_TOO_LONG", 2],
  ["尾部不够", Buffer.from("abc"), Buffer.concat([varint(3), varint(4), Buffer.from([0x90, 0x01])]), "TARGET_LENGTH_MISMATCH", 4],
  ["缺失 INSERT 数据", Buffer.alloc(0), Buffer.concat([varint(0), varint(1), Buffer.from([0x01])]), "TRUNCATED_INSERT_DATA", 3]
] as const;

for (const [name, base, delta, code, offset] of errorCases) {
  test(name, () => {
    assert.throws(() => rebuildDelta(base, delta), (err: unknown) => {
      assert.equal((err as { code: string }).code, code);
      assert.equal((err as { offset: number }).offset, offset);
      return true;
    });
  });
}

test("SQLite 保留指令证据且失败不发布对象", () => {
  const dir = mkdtempSync(join(tmpdir(), "delta-store-"));
  const store = new JobStore(dir);
  after(() => store.close());

  const good = store.rebuild({
    base: Buffer.from("abcde"),
    delta: Buffer.from("050590020158910302", "hex")
  });
  assert.equal(good.status, "success");
  assert.equal(store.readTarget(good.id)?.toString(), "abXde");
  assert.equal((store.findSource(good.id, 2) as { kind: string }).kind, "INSERT");
  assert.equal((store.findSource(good.id, 3) as { kind: string }).kind, "COPY");

  const bad = store.rebuild({
    base: Buffer.from("abc"),
    delta: Buffer.from("030300", "hex")
  });
  assert.equal(bad.status, "error");
  assert.equal(bad.error_code, "INVALID_OPCODE");
  assert.equal(store.readTarget(bad.id), undefined);

  const reopened = new JobStore(dir);
  assert.equal(reopened.getInstructions(good.id)?.length, 3);
  reopened.close();
});
