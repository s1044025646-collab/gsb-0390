import * as http from "node:http";
import { Store, JobViewOf } from "./store.js";
import { runRebuild, resolveSample, InputError } from "./service.js";
import { lookupSource, DEFAULT_LIMITS, Limits } from "./delta.js";

export interface ServerOptions {
  dataDir: string;
  port?: number;
  limits?: Partial<Limits>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new InputError("ERR_LIMIT_EXCEEDED", `请求体超过 ${maxBytes} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createServer(opts: ServerOptions): { server: http.Server; store: Store } {
  const store = new Store(opts.dataDir);
  const limits: Limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const maxBody = limits.maxBaseSize + limits.maxDeltaSize + 1024 * 1024;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true, limits });
      }

      if (req.method === "POST" && url.pathname === "/samples") {
        const body = JSON.parse((await readBody(req, maxBody)).toString("utf8") || "{}");
        const s = resolveSample(store, body, limits);
        return sendJson(res, 201, { id: s.sampleId, sha256: s.sha256, size: s.data.length });
      }

      if (req.method === "POST" && url.pathname === "/rebuild") {
        const body = JSON.parse((await readBody(req, maxBody)).toString("utf8") || "{}");
        if (!body.base || !body.delta) {
          throw new InputError("ERR_BAD_INPUT", "请求体必须包含 base 与 delta（各自为 hex/file/id 之一）");
        }
        const { job, result } = runRebuild(store, body.base, body.delta, limits);
        const view = JobViewOf(store.getJob(job.id)!);
        return sendJson(res, result ? 200 : 422, {
          job: view,
          targetHex: result ? result.target.toString("hex") : null,
        });
      }

      if (req.method === "GET" && parts[0] === "jobs" && parts.length === 1) {
        return sendJson(res, 200, { jobs: store.listJobs().map(JobViewOf) });
      }

      if (req.method === "GET" && parts[0] === "jobs" && parts.length >= 2) {
        const id = Number(parts[1]);
        if (!Number.isInteger(id)) throw new InputError("ERR_BAD_INPUT", "任务 id 必须为整数");
        const job = store.getJob(id);
        if (!job) return sendJson(res, 404, { error: { code: "ERR_JOB_NOT_FOUND", message: `任务 ${id} 不存在` } });
        const view = JobViewOf(job);

        if (parts.length === 2) return sendJson(res, 200, { job: view });

        if (parts[2] === "source") {
          const offset = Number(url.searchParams.get("offset"));
          if (!Number.isInteger(offset) || offset < 0) {
            throw new InputError("ERR_BAD_INPUT", "offset 必须为非负整数");
          }
          if (view.status !== "success" || !view.instructions) {
            return sendJson(res, 409, { error: { code: "ERR_JOB_NOT_SUCCESS", message: "任务未成功，无来源信息" } });
          }
          const ins = lookupSource(view.instructions, offset);
          if (!ins) return sendJson(res, 404, { error: { code: "ERR_OFFSET_OUT_OF_RANGE", message: `目标偏移 ${offset} 超出范围` } });
          return sendJson(res, 200, { offset, source: ins });
        }

        if (parts[2] === "object") {
          if (view.status !== "success" || !view.target_sha256) {
            return sendJson(res, 409, { error: { code: "ERR_JOB_NOT_SUCCESS", message: "任务未成功，不发布对象" } });
          }
          const buf = store.readObject(view.target_sha256);
          if (!buf) return sendJson(res, 404, { error: { code: "ERR_OBJECT_MISSING", message: "对象文件缺失" } });
          res.writeHead(200, { "content-type": "application/octet-stream", "x-sha256": view.target_sha256 });
          return res.end(buf);
        }
      }

      sendJson(res, 404, { error: { code: "ERR_NOT_FOUND", message: `未知路由 ${req.method} ${url.pathname}` } });
    } catch (err: any) {
      if (err instanceof InputError) {
        return sendJson(res, 400, { error: { code: err.code, message: err.message } });
      }
      if (err instanceof SyntaxError) {
        return sendJson(res, 400, { error: { code: "ERR_BAD_JSON", message: "请求体不是合法 JSON" } });
      }
      sendJson(res, 500, { error: { code: err.code ?? "ERR_INTERNAL", message: err.message ?? String(err) } });
    }
  });

  return { server, store };
}

export function startServer(opts: ServerOptions): Promise<{ port: number; close: () => void }> {
  const { server, store } = createServer(opts);
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, close: () => { server.close(); store.close(); } });
    });
  });
}
