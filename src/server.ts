import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { JobStore } from "./storage.js";
import { DeltaError } from "./types.js";

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("无法取得空闲端口"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function normalizeHex(value: unknown, field: string): Buffer {
  if (typeof value !== "string") {
    throw new DeltaError("INVALID_HEX", `${field} 必须是十六进制字符串`, 0);
  }
  const clean = value.startsWith("0x") ? value.slice(2) : value.replace(/\s+/g, "");
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new DeltaError("INVALID_HEX", `${field} 不是偶数长度的十六进制字符串`, 0);
  }
  return Buffer.from(clean, "hex");
}

async function readJson(req: IncomingMessage, maxBytes = 18 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > maxBytes) {
      throw new DeltaError("REQUEST_TOO_LARGE", `请求体超过 ${maxBytes} 字节`, 0);
    }
    chunks.push(data);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new DeltaError("INVALID_JSON", "请求体不是合法 JSON", 0);
  }
}

function send(res: ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8") {
  const data = contentType.startsWith("application/json")
    ? JSON.stringify(body, null, 2)
    : Buffer.isBuffer(body)
      ? body
      : String(body);
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(data)
  });
  res.end(data);
}

function errorBody(code: string, message: string, offset?: number | null) {
  return { error: { code, message, offset: offset ?? null } };
}

export function createApp(store: JobStore): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const method = req.method ?? "GET";

        if (method === "GET" && url.pathname === "/health") {
          send(res, 200, { ok: true, ruleVersion: "git-delta-one-hop-v1" });
          return;
        }

        if (method === "POST" && url.pathname === "/jobs") {
          const body = await readJson(req);
          let base: Buffer;
          let delta: Buffer;
          if (typeof body.baseSample === "string" && typeof body.deltaSample === "string") {
            base = store.resolveSample("base", body.baseSample);
            delta = store.resolveSample("delta", body.deltaSample);
          } else {
            base = normalizeHex(body.baseHex, "baseHex");
            delta = normalizeHex(body.deltaHex, "deltaHex");
          }
          const stored = store.rebuild({ base, delta });
          const job = { ...stored };
          delete job.result;
          send(res, job.status === "success" ? 201 : 422, job);
          return;
        }

        const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
        if (method === "GET" && jobMatch) {
          const job = store.getJob(decodeURIComponent(jobMatch[1]!));
          if (!job) {
            send(res, 404, errorBody("JOB_NOT_FOUND", "任务不存在"));
            return;
          }
          send(res, 200, job);
          return;
        }

        const instructionsMatch = url.pathname.match(/^\/jobs\/([^/]+)\/instructions$/);
        if (method === "GET" && instructionsMatch) {
          const id = decodeURIComponent(instructionsMatch[1]!);
          const rows = store.getInstructions(id);
          if (!rows) {
            send(res, 404, errorBody("JOB_NOT_FOUND", "任务不存在"));
            return;
          }
          send(res, 200, { jobId: id, instructions: rows });
          return;
        }

        const sourceMatch = url.pathname.match(/^\/jobs\/([^/]+)\/source$/);
        if (method === "GET" && sourceMatch) {
          const id = decodeURIComponent(sourceMatch[1]!);
          const offset = Number(url.searchParams.get("offset") ?? "");
          if (!Number.isSafeInteger(offset)) {
            throw new DeltaError("INVALID_TARGET_OFFSET", "offset 必须是非负安全整数", 0);
          }
          const row = store.findSource(id, offset);
          if (!row) {
            send(res, 404, errorBody("JOB_NOT_FOUND", "任务不存在"));
            return;
          }
          send(res, 200, { jobId: id, targetOffset: offset, instruction: row });
          return;
        }

        const objectMatch = url.pathname.match(/^\/jobs\/([^/]+)\/object$/);
        if (method === "GET" && objectMatch) {
          const id = decodeURIComponent(objectMatch[1]!);
          const target = store.readTarget(id);
          if (target === undefined) {
            send(res, 404, errorBody("OBJECT_NOT_FOUND", "成功对象不存在或任务失败"));
            return;
          }
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": target.length,
            "content-disposition": `attachment; filename="${id}.bin"`
          });
          res.end(target);
          return;
        }

        if (method === "GET" && url.pathname === "/diagnostics") {
          send(res, 200, { jobs: store.history(Number(url.searchParams.get("limit") ?? "50")) });
          return;
        }

        send(res, 404, errorBody("ROUTE_NOT_FOUND", "不支持的 API 路径"));
      } catch (err) {
        if (err instanceof DeltaError) {
          send(res, 400, errorBody(err.code, err.message, err.offset));
        } else {
          send(res, 500, errorBody("INTERNAL_ERROR", (err as Error).message));
        }
      }
    })();
  });
}
