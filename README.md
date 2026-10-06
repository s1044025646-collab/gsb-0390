# Git Delta 对象重建与指令边界解释后端

这是一个只面向本地、单跳、已解压 Git delta 字节流的 TypeScript/Node.js 后端。它不解析 pack 容器、提交树、网络协议或真实仓库，也不生成差分算法；输入基对象和 delta 后，按 Git COPY/INSERT 规则重建目标对象，并逐条保存字节范围证据。

## 支持范围

- 运行环境：Windows 本地 Node.js 22+，当前开发验证使用 Node.js 25。
- SQLite：使用 Node 内置 `node:sqlite`，不需要外部数据库、Docker、WSL、付费服务或在线 API。
- 默认限制：基对象最大 64 MiB，delta 最大 16 MiB，声明目标最大 64 MiB，输出内存预算 80 MiB，变长整数最多 9 字节。
- 只接受已解压 delta；不会把任意文件自动识别为 pack 或执行 zlib 解压。
- COPY 只能从原始基对象读取，不能从已经生成的目标输出读取。
- 成功对象通过临时文件和原子重命名发布；失败任务只写诊断，不生成可下载对象。

## Delta 字节语法

### 头部

头部按顺序包含两个小端变长整数：

1. 基对象长度。
2. 目标对象长度。

每个整数每字节低 7 位提供数据，按 7 位一组小端拼接；最高位为 1 表示后续还有字节，为 0 表示结束。实际基对象长度必须精确等于声明值。两个头部都必须完整；零长度目标也需要 `00 00`。

### 指令

`opcode` 最高位为 1 时是 COPY：

- bit 0 到 bit 3 控制偏移字节 0 到 3，字段按 bit 顺序出现。
- bit 4 到 bit 6 控制长度字节 0 到 2，字段按 bit 顺序出现。
- 出现的字节放到其固定小端位置；未出现的字节按 0 处理，不会压缩或连续拼接。
- 组装长度为 0 时表示 `65536` 字节，不表示空复制。
- `offset + length` 必须在基对象范围内；累计输出不能超过声明目标长度。

`opcode` 最高位为 0 且非 0 时是 INSERT：低 7 位给出随后内联字节数量，这些字节原样写入目标。`opcode=0x00` 非法。所有可选 COPY 字段和 INSERT 数据都必须完整，解析器不会越界读取后补零。

流结束时累计输出必须恰好等于声明目标长度。每条记录保存：

- 指令在 delta 中的半开区间 `[deltaStart, deltaEnd)`。
- COPY 源基对象区间，或 INSERT 内联数据区间。
- 目标写入区间和累计长度。

这些区间完整、非重叠地覆盖每个目标字节；字节值相同不代表来源相同。

## 快速开始

```powershell
npm install
npm run build
npm test
npm run demo
```

演示使用基对象 ASCII `abcde` 和手工 delta：

```text
05 05 90 02 01 58 91 03 02
```

解释结果：

- `05 05`：基长度 5，目标长度 5。
- `90 02`：COPY 基对象 `[0,2)`，产生 `ab`。
- `01 58`：INSERT 一个字节 `X`。
- `91 03 02`：COPY 基对象 `[3,5)`，产生 `de`。

最终目标是 `abXde`。

## CLI

```powershell
# 十六进制输入；@path 可读取本地原始文件
node dist/cli.js rebuild --base 6162636465 --delta 050590020158910302

# 查看任务、指令表、按目标偏移查来源
node dist/cli.js job <job-id>
node dist/cli.js instructions <job-id>
node dist/cli.js source <job-id> --offset 2

# 导出成功对象和查看历史
node dist/cli.js export <job-id> --out target.bin
node dist/cli.js history --limit 20

# HTTP 服务；--port 0 或省略时选择空闲端口
node dist/cli.js serve --host 127.0.0.1 --port 0 --data-dir ./data
```

## HTTP API

### `POST /jobs`

使用十六进制：

```json
{
  "baseHex": "6162636465",
  "deltaHex": "050590020158910302"
}
```

使用项目数据目录中的相对样本：

```json
{
  "baseSample": "demo/base.bin",
  "deltaSample": "demo/delta.bin"
}
```

成功返回 `201`；格式或规则失败返回 `422`，错误包含稳定错误码和 delta 字节偏移。

### 其他接口

- `GET /jobs/{id}`：读取输入摘要、长度、规则版本和结果状态。
- `GET /jobs/{id}/instructions`：读取逐条 COPY/INSERT 证据。
- `GET /jobs/{id}/source?offset=2`：查询某个目标字节由哪条指令产生。
- `GET /jobs/{id}/object`：下载成功重建对象；失败任务不发布对象。
- `GET /diagnostics?limit=50`：读取成功与失败诊断历史。
- `GET /health`：健康检查。

## 错误码

- `TRUNCATED_HEADER`：头部变长整数截断。
- `VARINT_TOO_LONG`：变长整数超过允许字节数。
- `BASE_LENGTH_MISMATCH`：声明基长度与实际输入不一致。
- `INVALID_OPCODE`：遇到全零 opcode。
- `TRUNCATED_COPY_FIELD`：COPY 标志声明的字段缺失。
- `TRUNCATED_INSERT_DATA`：INSERT 内联数据不足。
- `COPY_OUT_OF_RANGE`：COPY 区间越过基对象边界。
- `OUTPUT_TOO_LONG`：累计输出超过声明目标长度。
- `TARGET_LENGTH_MISMATCH`：流结束时实际输出与声明目标长度不一致。
- `INVALID_HEX`、`INVALID_SAMPLE_PATH`、`OBJECT_NOT_FOUND`：API/CLI 输入或资源错误。

## 数据目录

默认目录是项目内 `./data`：

- `delta.db`：SQLite 任务和指令证据。
- `samples/base/`、`samples/delta/`：保存原始输入副本。
- `objects/`：只保存成功对象。

服务重启后可继续从 SQLite 读取任务、状态和原指令表。样本定位不允许绝对路径或 `..` 逃逸。

## 测试

```powershell
npm test
```

测试使用手工指令和独立目标字节断言，覆盖：演示序列、COPY 零长度字段代表 65536、非连续偏移字节标志、空目标、坏基长度、全零 opcode、截断头、缺失字段、越界复制、声明过短、尾部不足以及 SQLite 重启证据。
