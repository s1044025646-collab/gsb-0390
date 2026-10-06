import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../src/server.js";
import { Store } from "../src/store.js";

let port = 0;
let dataDir = "";
let closeServer: () => void = () => {};

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "delta-test-"));
  const started = await startServer({ dataDir, port: 0 });
  port = started.port;
  closeServer = started.close;
  assert.ok(port > 0, "缺省应自动选择空闲端口");
});

after(() => {
  closeServer();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("完整流程：提交样本 -> 重建 -> 指令表 -> 来源查询 -> 导出", async () => {
  const base = await api("POST", "/samples", { hex: "6162636465" });
  assert.equal(base.status, 201);
  const delta = await api("POST", "/samples", { hex: "050590020158910 302".replace(" ", "") });
  assert.equal(delta.status, 201);

  const rb = await api("POST", "/rebuild", { base: { id: base.json.id }, delta: { id: delta.json.id } });
  assert.equal(rb.status, 200);
  assert.equal(rb.json.targetHex, "6162586465");
  const jobId = rb.json.job.id;
  assert.equal(rb.json.job.status, "success");
  assert.equal(rb.json.job.rule_version, "git-delta-v1");
  assert.equal(rb.json.job.instructions.length, 3);

  const src = await api("GET", `/jobs/${jobId}/source?offset=2`);
  assert.equal(src.status, 200);
  assert.equal(src.json.source.type, "insert");
  const src2 = await api("GET", `/jobs/${jobId}/source?offset=4`);
  assert.equal(src2.json.source.type, "copy");
  assert.equal(src2.json.source.copyOffset, 3);
  const srcBad = await api("GET", `/jobs/${jobId}/source?offset=99`);
  assert.equal(srcBad.status, 404);

  const res = await fetch(`http://127.0.0.1:${port}/jobs/${jobId}/object`);
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "abXde");
});

test("失败任务：记录诊断、不发布对象、导出 409", async () => {
  const rb = await api("POST", "/rebuild", { base: { hex: "616263" }, delta: { hex: "030100" } });
  assert.equal(rb.status, 422);
  assert.equal(rb.json.job.status, "failed");
  assert.equal(rb.json.job.error_code, "ERR_ZERO_OPCODE");
  assert.equal(rb.json.job.error_position, 2);
  const obj = await fetch(`http://127.0.0.1:${port}/jobs/${rb.json.job.id}/object`);
  assert.equal(obj.status, 409);
  const jobs = await api("GET", "/jobs");
  assert.ok(jobs.json.jobs.some((j: any) => j.id === rb.json.job.id));
});

test("输入校验：坏 hex / 缺参数 / 未知路由", async () => {
  assert.equal((await api("POST", "/samples", { hex: "zz" })).status, 400);
  assert.equal((await api("POST", "/rebuild", { base: { hex: "00" } })).status, 400);
  assert.equal((await api("GET", "/nope")).status, 404);
  assert.equal((await api("GET", "/jobs/9999")).status, 404);
});

test("重启后可读取原指令证据", async () => {
  const store = new Store(dataDir);
  try {
    const jobs = store.listJobs();
    const ok = jobs.find((j) => j.status === "success")!;
    assert.ok(ok.instructions && JSON.parse(ok.instructions).length === 3);
    assert.ok(store.readObject(ok.target_sha256!)!.equals(Buffer.from("abXde")));
  } finally {
    store.close();
  }
});
