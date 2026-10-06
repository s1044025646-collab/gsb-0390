#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { Store, JobViewOf } from "./store.js";
import { runRebuild, resolveSample, SampleInput } from "./service.js";
import { lookupSource } from "./delta.js";
import { startServer } from "./server.js";

const DATA_DIR = process.env.DELTA_DATA_DIR ?? path.join(process.cwd(), "data");

function usage(): never {
  console.log(`用法：node dist/src/cli.js <命令> [参数]

命令：
  serve [--port N]                     启动 HTTP API（缺省端口 0 = 自动选择空闲端口）
  sample-add --hex <hex>               提交十六进制样本
  sample-add --file <项目内路径>        登记项目内二进制样本（只存定位与摘要）
  rebuild --base <样本> --delta <样本>  执行重建；样本为 id 数字、hex:... 或 file:...
  job <id>                             查看任务与指令表
  source <jobId> <offset>              按目标偏移查询来源
  export <jobId> <输出文件>             导出成功对象
  jobs                                 诊断历史
  demo                                 运行内置演示（abcde -> abXde）

环境变量：
  DELTA_DATA_DIR   数据目录（默认 ./data）
  PORT             serve 默认端口（默认 0 = 空闲端口）
`);
  process.exit(1);
}

function parseSampleArg(arg: string): SampleInput {
  if (/^\d+$/.test(arg)) return { id: Number(arg) };
  if (arg.startsWith("hex:")) return { hex: arg.slice(4) };
  if (arg.startsWith("file:")) return { file: arg.slice(5) };
  if (/^(?:[0-9a-fA-F]{2})+$/.test(arg)) return { hex: arg };
  return { file: arg };
}

function printJob(store: Store, id: number): void {
  const job = store.getJob(id);
  if (!job) {
    console.error(`任务 ${id} 不存在`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(JobViewOf(job), null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  if (!cmd) usage();

  if (cmd === "serve") {
    const portIdx = args.indexOf("--port");
    const port = portIdx >= 0 ? Number(args[portIdx + 1]) : Number(process.env.PORT ?? 0);
    const { port: actual } = await startServer({ dataDir: DATA_DIR, port });
    console.log(`API 已启动: http://127.0.0.1:${actual}  (数据目录: ${DATA_DIR})`);
    return;
  }

  const store = new Store(DATA_DIR);
  try {
    if (cmd === "sample-add") {
      const hexIdx = args.indexOf("--hex");
      const fileIdx = args.indexOf("--file");
      const input: SampleInput = hexIdx >= 0 ? { hex: args[hexIdx + 1] } : fileIdx >= 0 ? { file: args[fileIdx + 1] } : {};
      const s = resolveSample(store, input);
      console.log(JSON.stringify({ id: s.sampleId, sha256: s.sha256, size: s.data.length }, null, 2));
    } else if (cmd === "rebuild") {
      const bIdx = args.indexOf("--base");
      const dIdx = args.indexOf("--delta");
      if (bIdx < 0 || dIdx < 0) usage();
      const { job, result } = runRebuild(store, parseSampleArg(args[bIdx + 1]), parseSampleArg(args[dIdx + 1]));
      printJob(store, job.id);
      if (result) console.log(`目标对象(hex): ${result.target.toString("hex")}`);
      else process.exitCode = 2;
    } else if (cmd === "job") {
      printJob(store, Number(args[0]));
    } else if (cmd === "source") {
      const job = store.getJob(Number(args[0]));
      if (!job || job.status !== "success" || !job.instructions) {
        console.error("任务不存在或未成功");
        process.exitCode = 1;
        return;
      }
      const ins = lookupSource(JSON.parse(job.instructions), Number(args[1]));
      console.log(ins ? JSON.stringify(ins, null, 2) : "该偏移无来源（超出目标范围）");
    } else if (cmd === "export") {
      const job = store.getJob(Number(args[0]));
      if (!job || job.status !== "success" || !job.target_sha256) {
        console.error("任务不存在或未成功，拒绝导出");
        process.exitCode = 1;
        return;
      }
      const buf = store.readObject(job.target_sha256);
      if (!buf) {
        console.error("对象文件缺失");
        process.exitCode = 1;
        return;
      }
      fs.writeFileSync(args[1], buf);
      console.log(`已导出 ${buf.length} 字节到 ${args[1]} (sha256=${job.target_sha256})`);
    } else if (cmd === "jobs") {
      console.log(JSON.stringify(store.listJobs().map(JobViewOf), null, 2));
    } else if (cmd === "demo") {
      const { job, result } = runRebuild(
        store,
        { hex: Buffer.from("abcde", "utf8").toString("hex") },
        { hex: "05 05 90 02 01 58 91 03 02" },
      );
      printJob(store, job.id);
      console.log(`重建结果: ${result!.target.toString("utf8")} (hex: ${result!.target.toString("hex")})`);
    } else {
      usage();
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(`错误 [${err.code ?? "ERR_INTERNAL"}] ${err.message}`);
  process.exit(1);
});
