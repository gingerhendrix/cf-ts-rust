# cf-ts-rust

> **Status: quick proof of concept.** This is an experiment, not a product. It has no authentication, no input limits and no production hardening. Do not leave it deployed on a public URL.

A Cloudflare Worker that type-checks TypeScript with [ts-rust](https://github.com/pingdotgg/ts-rust) compiled to WASM. Send TypeScript in a POST request. The Worker runs `tsc` against an in-memory file system and returns the diagnostics as JSON.

## How it works

- `src/ts_rust.wasm` is the ts-rust `ts_wasm` crate, built for `wasm32-wasip1` from upstream commit `79d71780` with `patches/ts-rust-wasm-memory-wins.patch` and an 8 MiB shadow stack. See [Memory settings](#memory-settings). Wrangler imports it as a compiled `WebAssembly.Module`, because Workers cannot compile WASM from bytes at runtime.
- `src/core.js` is a copy of upstream `npm/wasm/core.js` (MIT, T3 Tools Inc.). It has two changes. `runTsc` also returns `memoryBytes` (`patches/core-memory-bytes.patch`). Reads from WASM memory use a `Uint8Array` constructor view in place of `subarray` (`patches/core-hosted-subarray.patch`). On hosted Workers, `subarray` throws "Invalid array buffer length" when the start is past 128 MiB.
- `src/index.ts` is the Worker. Each check makes a new WASM instance. This is how ts-rust works: one instance runs one `tsc` invocation.

## Run it

You need Bun, and Node 23.6 or later for the tests (they use Node type stripping).

```bash
bun install
bun run dev        # wrangler dev on http://127.0.0.1:8799
```

Check a single file:

```bash
curl -s -X POST http://127.0.0.1:8799/ -d '{"source":"export const n: number = \"one\";"}'
```

The reply has `exitCode`, `diagnostics`, `stderr`, `timings` and `memory`. A type error gives exit code 2 and a diagnostic with code 2322.

Check a project. Put a `tsconfig.json` and the source files under `/app`:

```bash
curl -s -X POST http://127.0.0.1:8799/ -d '{
  "files": {
    "/app/tsconfig.json": "{\"compilerOptions\":{\"strict\":true,\"lib\":[\"es2022\"],\"types\":[]}}",
    "/app/a.ts": "export const a = 1;",
    "/app/b.ts": "import { a } from \"./a\"; export const b: string = a;"
  }
}'
```

Other options:

| Request | Effect |
|---|---|
| `GET /` | Usage text, and whether the runtime has JSPI (`WebAssembly.promising`) |
| `?mode=async` | Uses `runTscAsync` (JSPI) instead of `runTsc`. It gives no extra stack depth on Workers. |
| `"args": [...]` | Your own `tsc` arguments. Default: `-p /app --noEmit --checkers 1`. |

## Test it

```bash
bun run test        # node --test: starts the Worker in local workerd and sends real requests
bun run typecheck
bun run size        # wrangler deploy --dry-run: bundle size against plan limits
```

The tests use Node's test runner with Wrangler's `unstable_startWorker`. `bun test` does not work here, because it stops the workerd child process after each test.

## Deploy it

```bash
bunx wrangler login
bun run deploy
# when you are done:
bunx wrangler delete --name cf-ts-rust
```

The upload is about 2.0 MB gzip, so it fits the 3 MB free plan limit. Each check uses at least 130 ms of CPU, so you need the paid plan in practice.

## Rebuild the WASM module

The committed module works as it is. To rebuild it, you need Rust with the `wasm32-wasip1` target and binaryen `wasm-opt` 132 or later.

```bash
git clone https://github.com/pingdotgg/ts-rust /path/to/ts-rust
git -C /path/to/ts-rust checkout 79d71780
git -C /path/to/ts-rust am "$PWD/patches/ts-rust-wasm-memory-wins.patch"
TS_RUST_DIR=/path/to/ts-rust bun run build:wasm
```

Set `TOOLS_DIR` to use a rustup and binaryen kept outside the system path. Set `WASM_OPT=none` to skip `wasm-opt`. The build takes about 2 to 3 minutes on a 24-core machine.

The build script sets `TS_WASM_STACK_SIZE=8388608` unless you set it yourself. Without the patch, ts-rust ignores this setting and uses a 32 MiB stack.

## Memory settings

Two settings lower the memory of each check. The Worker uses both.

| Setting | Where | Effect |
|---|---|---|
| `--checkers 1` | Default `tsc` args in `src/index.ts` | tsgo makes 4 checkers. On one WASM thread they only split the files, and each one loads the lib types again. One checker gives the same diagnostics with less memory and time. If you send your own `args`, add `--checkers 1` yourself. |
| 8 MiB shadow stack | Build setting from the patch | Upstream uses 32 MiB. The smaller stack saves 24 MiB for each check. Deep expressions still stop at the same depth, because the V8 stack overflows first. |

`patches/ts-rust-wasm-memory-wins.patch` holds three commits on `79d71780`. The first adds the `TS_WASM_STACK_SIZE` build setting. The second packs the `dom` and `webworker` libs in a separate stream, so a check without `dom` does not unpack them. The third adds notes to the upstream docs.

Linear memory after one check, in MiB:

| Input | Before | Now |
|---|---:|---:|
| One file, lib es2022 | 55.9 | 24.3 |
| One file, lib dom | 67.4 | 43.4 |
| zod v4, 74 files | 134.9 | 88.9 |
| Effect 3.16, 359 files | 572.3 | 460.8 |

## Known limits

Measured in October 2026 with local workerd and one deploy to `workers.dev`.

| Limit | Detail |
|---|---|
| Memory | Each check uses about 24 MiB or more of linear memory. On Cloudflare, checks up to about 150 MiB pass every time (zod v4, 107 files, 152.8 MiB). At about 250 MiB some checks pass and some fail (fp-ts, 3 of 8). At 257 MiB and above every check fails with "exceeded memory limit". |
| CPU | Hosted: about 200 ms for a small file on a warm isolate, and up to about 850 ms on a cold one. Popular libraries take 0.2 to 2.4 s of CPU, about 2 to 6 times native `tsc` 7. |
| Stack | Deep expressions overflow the V8 stack at about 1,600 to 1,800 terms of `1 + 1 + ...`. The Worker returns 500 and the isolate keeps working. |
| State | No state between checks. Each check parses the lib files again. |
| Timing | On Cloudflare, `timings.checkMs` reads 0, because `performance.now()` does not advance during synchronous work. Use Workers observability for CPU time. |
| API | Diagnostics only. No quick info, no language service. |

## Licenses

The code in this repository is under the [WTFPL](https://www.wtfpl.net/), version 2. See [`LICENSE`](LICENSE).

The WTFPL does not apply to the ts-rust code. This includes the ts-rust lines that the files in `patches/` contain. `src/ts_rust.wasm` and `src/core.js` come from [ts-rust](https://github.com/pingdotgg/ts-rust) at commit `79d71780`. The module also has the changes in `patches/ts-rust-wasm-memory-wins.patch`. ts-rust is MIT licensed (T3 Tools Inc.). The WASM module also contains code and lib files from TypeScript (Apache 2.0) and Go (BSD 3-Clause). The upstream license and notice files are in [`third_party/ts-rust/`](third_party/ts-rust/).
