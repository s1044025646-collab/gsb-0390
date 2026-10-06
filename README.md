# Git Delta 对象重建与指令边界解释后端

离线、单跳、已解压的 Git delta 字节流重建服务。输入一份基对象字节与一份原始 delta
指令流，按 Git 的 COPY / INSERT 规则重建目标对象，并逐条解释每个输出字节来自
基对象还是 delta 内联字节。仅提供 HTTP API 与 CLI，Windows 本地运行，零运行时
第三方依赖（数据库用 Node.js 内置 `node:sqlite`，HTTP 用内置 `node:http`）。

## 受支持范围

- 只处理**一跳、已解压**的 delta：不解析 pack 容器、不解析 zlib、不遍历提交树、
  不做网络传输、不修改任何真实 Git 仓库、不生成新的差分算法。
- 不会把任意文件自动当作 pack 解压；输入就是裸 delta 指令流。
- 样本大小、声明目标长度、变长整数位数均有上限（见下文），先验证再分配。

## 字节语法

```
delta     := hdrBase hdrTarget instr*
hdrBase   := varint          ; 基对象长度（字节数），必须与实际基对象一致
hdrTarget := varint          ; 目标对象长度，流结束时累计输出必须恰好等于它
varint    := byte+           ; 每字节低 7 位为数据（小端序组），最高位 1 = 还有后续字节

instr     := COPY | INSERT
COPY      := 1 o1 o2 o3 o4 s1 s2 s3  [off0] [off1] [off2] [off3] [size0] [size1] [size2]
             ; opcode 最高位 1；低 4 位 o1..o4 分别控制 4 个偏移字节是否出现，
             ; 接下来 3 位 s1..s3 控制 3 个长度字节是否出现。
             ; 出现的字节按各自小端位置组装（off0 是最低字节），
             ; 缺失的字节视为 0 —— 不是把已出现字节压缩到低位。
             ; 组装长度 == 0 时表示 0x10000（65536），不是空复制。
             ; 源区间 [offset, offset+size) 必须完全落在基对象内；
             ; COPY 源永远是基对象，绝不是已产生的目标输出。
INSERT    := 0 n n n n n n n  <n 个内联字节>
             ; opcode 最高位 0 且非零，低 7 位给出随后内联字节数，原样写入。
             ; 0x00 是非法指令。
```

错误均带准确字节位置：截断的头部/字段/内联段、全零 opcode、基长度不匹配、
越界 COPY、累计输出超出或不足声明目标长度等，都有独立错误码。

## 构建 / 测试 / 启动 / 演示

要求：Windows + Node.js >= 22.5（推荐 24+，使用了内置 `node:sqlite`）。

```powershell
npm install        # 仅开发依赖 typescript / @types/node
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API（默认自动选择空闲端口，控制台打印实际端口）
npm run demo       # 运行演示：基对象 abcde + delta 05 05 90 02 01 58 91 03 02 => abXde
```

可配置项（环境变量）：

- `PORT`：API 端口，缺省 `0`（让系统分配空闲端口）。
- `DELTA_DATA_DIR`：数据目录，缺省 `./data`（SQLite 库与成功对象都在其中）。

## CLI

```
node dist/src/cli.js serve [--port N]
node dist/src/cli.js sample-add --hex <hex>
node dist/src/cli.js sample-add --file <项目内路径>
node dist/src/cli.js rebuild --base <id|hex:..|file:..> --delta <id|hex:..|file:..>
node dist/src/cli.js job <id>
node dist/src/cli.js source <jobId> <目标偏移>
node dist/src/cli.js export <jobId> <输出文件>
node dist/src/cli.js jobs
node dist/src/cli.js demo
```

## HTTP API

所有响应为 JSON；错误结构为 `{ "error": { "code", "message" } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活与当前限额 |
| POST | `/samples` | `{hex}` 或 `{file}` 提交样本，返回 `{id, sha256, size}` |
| POST | `/rebuild` | `{base:{hex|file|id}, delta:{...}}` 执行重建；成功 200，重建失败 422 |
| GET | `/jobs` | 诊断历史（最近 50 条，含失败） |
| GET | `/jobs/:id` | 任务详情与逐条指令表 |
| GET | `/jobs/:id/source?offset=N` | 按目标偏移查询来源指令 |
| GET | `/jobs/:id/object` | 导出成功对象字节（`application/octet-stream`）；失败任务 409 |

示例（PowerShell）：

```powershell
npm start   # 假设打印端口 51234
$body = @{ base = @{ hex = "6162636465" }; delta = @{ hex = "050590020158910302" } } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:51234/rebuild -Body $body -ContentType 'application/json'
```

## 演示逐条核对（基对象 `abcde`，delta `05 05 90 02 01 58 91 03 02`）

| delta 范围 | 字节 | 指令 | 含义 | 目标范围 |
| --- | --- | --- | --- | --- |
| [0,1) | `05` | 头部 | 基对象长度 = 5 | - |
| [1,2) | `05` | 头部 | 目标长度 = 5 | - |
| [2,4) | `90 02` | COPY | 长度字节0=2，偏移=0，复制 base[0,2)=`ab` | [0,2) |
| [4,6) | `01 58` | INSERT | 内联 1 字节 `58`=`X` | [2,3) |
| [6,9) | `91 03 02` | COPY | 偏移字节0=3，长度字节0=2，复制 base[3,5)=`de` | [3,5) |

重建结果：`abXde`（hex `6162586465`）。两段 COPY 与一段 INSERT 的目标范围
无缝衔接、互不重叠，覆盖全部 5 个输出字节；即使两段来源字节内容相同，来源
记录也不同（相同字节内容不代表相同来源）。

## 存储与原子性

- SQLite（`data/delta.db`）保存：样本摘要（hex 样本存原始字节；`file` 样本只存
  项目内相对定位与摘要，读取时校验摘要）、任务状态、规则版本 `git-delta-v1`、
  错误码/位置、成功任务的完整指令表（JSON）。服务重启后原指令证据仍在库中。
- 成功对象写入 `data/objects/<sha256>`，先写临时文件再 `rename` 原子发布；
  失败任务只落诊断记录，绝不产生或覆盖对象文件，导出接口对失败任务返回 409。

## 错误码

- delta 解释层：`ERR_LIMIT_EXCEEDED` `ERR_VARINT_TOO_LONG` `ERR_VARINT_TRUNCATED`
  `ERR_BASE_SIZE_MISMATCH` `ERR_ZERO_OPCODE` `ERR_COPY_FIELD_TRUNCATED`
  `ERR_COPY_OUT_OF_RANGE` `ERR_INSERT_TRUNCATED` `ERR_TARGET_OVERRUN`
  `ERR_TARGET_UNDERRUN` `ERR_UNSAFE_INTEGER`
- 输入层：`ERR_BAD_HEX` `ERR_BAD_INPUT` `ERR_SAMPLE_NOT_FOUND` `ERR_FILE_NOT_FOUND`
  `ERR_PATH_OUTSIDE_PROJECT`
- API 层：`ERR_JOB_NOT_FOUND` `ERR_JOB_NOT_SUCCESS` `ERR_OFFSET_OUT_OF_RANGE` `ERR_NOT_FOUND`

## 默认限额

基对象 64 MiB、delta 64 MiB、声明目标 256 MiB、变长整数最多 9 字节（63 位）。
长度与累计输出均做安全整数检查，先验证声明长度再分配缓冲。

## 限制

- 不支持 pack/idx 容器、zlib 解压、ref-delta / ofs-delta 链式解析。
- 目标长度上限 256 MiB；更大的对象请调整限额（本服务不做流式输出）。
- 零长度目标合法：仍需两个完整头部（基长度 + 目标长度 0），指令区为空。
