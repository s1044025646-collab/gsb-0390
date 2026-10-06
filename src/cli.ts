#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { JobStore } from "./storage.js";
import { createApp, findFreePort } from "./server.js";
import { DeltaError } from "./types.js";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        options.set(key, "true");
      } else {
        options.set(key, value);
        index += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function loadHexOrFile(value: string): Buffer {
  const maybeFile = value.startsWith("@");
  if (maybeFile) {
    return readFileSync(resolve(value.slice(1)));
  }
  const clean = value.startsWith("0x") ? value.slice(2) : value.replace(/\s+/g, "");
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) {
    throw new DeltaError("INVALID_HEX", "参数必须是偶数长度十六进制或 @文件路径", 0);
  }
  return Buffer.from(clean, "hex");
}

function usage() {
  console.log(`用法:
  git-delta-rebuild rebuild --base <hex|@file> --delta <hex|@file> [--data-dir ./data]
  git-delta-rebuild job <id> [--data-dir ./data]
  git-delta-rebuild instructions <id> [--data-dir ./data]
  git-delta-rebuild source <id> --offset <n> [--data-dir ./data]
  git-delta-rebuild export <id> --out <file> [--data-dir ./data]
  git-delta-rebuild history [--limit 50] [--data-dir ./data]
  git-delta-rebuild serve [--port 0] [--host 127.0.0.1] [--data-dir ./data]
  git-delta-rebuild demo`);
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const dataDir = options.get("data-dir") ?? "./data";

  if (!command || command === "help" || options.has("help")) {
    usage();
    return;
  }

  if (command === "demo") {
    const base = Buffer.from("abcde", "ascii");
    const delta = Buffer.from("050590020158910302", "hex");
    const store = new JobStore(dataDir);
    const job = store.rebuild({ base, delta });
    console.log("demo job:", job.id);
    console.log("target:", store.readTarget(job.id)?.toString("ascii"));
    console.table(store.getInstructions(job.id));
    store.close();
    return;
  }

  const store = new JobStore(dataDir);
  try {
    if (command === "rebuild") {
      const baseValue = options.get("base");
      const deltaValue = options.get("delta");
      if (!baseValue || !deltaValue) throw new DeltaError("MISSING_ARGUMENT", "需要 --base 和 --delta", 0);
      const job = store.rebuild({ base: loadHexOrFile(baseValue), delta: loadHexOrFile(deltaValue) });
      console.log(JSON.stringify(job, null, 2));
      if (job.status === "error") process.exitCode = 2;
    } else if (command === "job") {
      console.log(JSON.stringify(store.getJob(positional[1] ?? ""), null, 2));
    } else if (command === "instructions") {
      console.log(JSON.stringify(store.getInstructions(positional[1] ?? ""), null, 2));
    } else if (command === "source") {
      const offset = Number(options.get("offset") ?? "");
      console.log(JSON.stringify(store.findSource(positional[1] ?? "", offset), null, 2));
    } else if (command === "export") {
      const out = options.get("out");
      if (!out) throw new DeltaError("MISSING_ARGUMENT", "需要 --out", 0);
      const target = store.readTarget(positional[1] ?? "");
      if (!target) throw new DeltaError("OBJECT_NOT_FOUND", "成功对象不存在", 0);
      writeFileSync(resolve(out), target);
      console.log(`已导出 ${target.length} 字节到 ${out}`);
    } else if (command === "history") {
      console.log(JSON.stringify(store.history(Number(options.get("limit") ?? "50")), null, 2));
    } else if (command === "serve") {
      const requestedPort = Number(options.get("port") ?? "0");
      if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
        throw new DeltaError("INVALID_PORT", "端口必须是 0 到 65535 的整数", 0);
      }
      const host = options.get("host") ?? "127.0.0.1";
      const port = requestedPort === 0 ? await findFreePort() : requestedPort;
      const server = createApp(store);
      server.listen(port, host, () => {
        console.log(`服务已启动: http://${host}:${port}`);
        console.log(`数据目录: ${resolve(dataDir)}`);
      });
    } else {
      usage();
      process.exitCode = 64;
    }
  } finally {
    if (command !== "serve") store.close();
  }
}

main().catch((err: Error) => {
  const deltaError = err instanceof DeltaError ? err : undefined;
  console.error(JSON.stringify({
    error: {
      code: deltaError?.code ?? "INTERNAL_ERROR",
      message: err.message,
      offset: deltaError?.offset ?? null
    }
  }, null, 2));
  process.exitCode = 1;
});
