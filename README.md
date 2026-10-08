# cf-ts-rust

> **Status: proof of concept.** No authentication, no input limits, no hardening. Do not leave it deployed on a public URL.

A Cloudflare Worker that type-checks TypeScript with [ts-rust](https://github.com/pingdotgg/ts-rust) compiled to WASM. POST TypeScript to it. The Worker runs `tsc` against an in-memory file system and returns the diagnostics as JSON.

## Quick start

You need Bun, and Node 23.6 or later for the tests.

```bash
bun install
bun run dev         # wrangler dev on http://127.0.0.1:8799
bun run test        # node --test: real requests to the Worker in local workerd
bun run typecheck
bun run size        # bundle size against plan limits
```

```bash
curl -s -X POST http://127.0.0.1:8799/ -d '{"source":"export const n: number = \"one\";"}'
```

| Request | Result |
|---|---|
| `{ "source": "..." }` | Checks one file as `/app/index.ts` with a built-in strict tsconfig (`lib es2022`, no types). |
| `{ "files": { "/app/tsconfig.json": "...", "/app/a.ts": "..." } }` | Checks a project rooted at `/app`. |
| `"args": [...]` | Your own `tsc` args. Default: `-p /app --noEmit --checkers 1`. Keep `--checkers 1` if you set your own. |
| `?mode=async` | Uses `runTscAsync` (JSPI). It costs more CPU and gives no extra stack depth. |
| `GET /` | Usage, and whether the runtime has JSPI. |

The reply has `exitCode`, `diagnostics` (UTF-16 positions), `stderr`, `timings` and `memory.linearMiB`. A type error gives exit code 2.

Deploy with `bunx wrangler login && bun run deploy`. Remove it with `bunx wrangler delete --name cf-ts-rust`. The upload is about 2.0 MB gzip, so it fits the 3 MB free plan limit. Each check uses 130 ms of CPU or more, so you need the paid plan.

## How it works

| File | Purpose |
|---|---|
| `src/index.ts` | The Worker. Each check makes a new WASM instance, because ts-rust runs one `tsc` call for each instance. |
| `src/ts_rust.wasm` | The ts-rust `ts_wasm` crate for `wasm32-wasip1`, from upstream `79d71780` plus `patches/ts-rust-wasm-memory-wins.patch`, with an 8 MiB shadow stack. Wrangler imports it as a compiled `WebAssembly.Module`. Workers cannot compile WASM from bytes at runtime. |
| `src/core.js` | Upstream `npm/wasm/core.js` with two patches: it returns `memoryBytes`, and it reads WASM memory with `new Uint8Array(buffer, ptr, len)` in place of `subarray`. |
| `scripts/build-wasm.sh` | Rebuilds the module (see [Rebuild](#rebuild-the-wasm-module)). |
| `patches/` | Every change to upstream code, as patches. |

## What we found

All figures are WASM linear memory after one check, measured in October 2026. Node, local workerd and hosted Workers give the same memory figures.

### Memory

| Input | Upstream build | This build |
|---|---:|---:|
| One file, lib es2022 | 55.9 MiB | 24.3 MiB |
| One file, lib dom | 67.4 MiB | 43.4 MiB |
| zod 4.1.13 (core, classic, locales; 74 files) | 134.9 MiB | 88.9 MiB |
| zod 4.6.5 (all of `src/v4`; 107 files) | 234.3 MiB | 152.8 MiB |
| Effect 3.16 `src` (359 files) | 572.3 MiB | 460.8 MiB |

Three changes give these savings:

1. **`--checkers 1`.** tsgo makes 4 checkers. On one WASM thread they only split the files, and each one loads the lib types again. One checker gives byte-identical diagnostics, uses less memory and runs faster.
2. **8 MiB shadow stack.** Upstream uses 32 MiB. The patch adds a `TS_WASM_STACK_SIZE` build setting. Stack depth does not change, because the V8 native stack overflows first.
3. **Two lib streams.** Upstream packs all `lib.*.d.ts` in one LZMA stream, and `lib.dom.d.ts` sorts first. So every check unpacked `dom`. The patch puts `dom` and `webworker` in a second stream.

Where the rest goes: about 5 MiB of module data, about 6 MiB for lib unpacking, about 19 MiB more for `lib: ["dom"]`, and about 20 times the source size to parse and bind. Checker memory then grows with type work. Type work matters much more than file count: date-fns (1,387 files) needs 97 MiB, and fp-ts (123 files) needs 248 MiB.

### Hosted limits

| Limit | What we saw |
|---|---|
| Memory, plain Worker | Up to about 150 MiB passes every time. At about 250 MiB, some isolates pass and some fail (fp-ts: 3 of 8). At 257 MiB and above, every check fails with "Worker exceeded memory limit" (HTTP 503). Cloudflare documents 128 MB per isolate, but does not say how it enforces it. |
| Memory, Dynamic Worker | A hard 128 MiB cap. `memory.grow` fails with `RangeError: Invalid array buffer length`. The isolate survives. |
| `subarray` bug | On hosted Workers, `Uint8Array.subarray` throws when its start is past 128 MiB. Local workerd and Node do not throw, so local tests cannot catch it. This is the second `core.js` patch. Upstream `npm/wasm/core.js` still has the bug. |
| CPU | Small file: about 200 ms warm, up to about 850 ms cold. Popular libraries: 0.2 to 2.4 s. That is 2 to 6 times native `tsc` 7 and up to 2 times the same WASM in Node. All far below the 30 s paid plan default. |
| Stack | About 1,600 to 1,800 terms of `1 + 1 + ...`. The Worker returns 500 and the isolate keeps working. Model-written code does not come near this. |
| Timing | `performance.now()` does not advance during sync work on Cloudflare, so `timings.checkMs` reads 0. Use Workers observability for CPU time. |
| State | None between checks. Each check parses the libs again. Go `tsgo` with an incremental program re-checks an edit in under 1 ms. This Worker takes 60 to 200 ms. |
| API | Diagnostics only. No quick info and no language service. |

### Popular libraries on the hosted Worker

Each library's `src` as one program, strict, `skipLibCheck`, no dependencies installed.

| Passes every time | Memory |
|---|---|
| immer, vue reactivity, ts-pattern, zustand, TanStack query-core, rxjs, xstate core, vue runtime-core | 28 to 78 MiB |
| type-fest, date-fns, kysely, valibot, hono, zod 4.6.5 | 95 to 153 MiB |
| fp-ts (3 of 8 pass) | 248 MiB |
| Effect 4.0.2 (never passes) | 667 MiB |

Diagnostics match native `tsgo` 7.0.2 for 12 of 16 projects. The other 4 (vue twice, hono, Effect 4) have 1 to 5 extra diagnostics. Native `tsc-rs` gives the same extras, so they come from ts-rust and not from the WASM build.

### Effect language service rules

ts-rust has the Effect diagnostics built in (codes TS377xxx, ported from `@effect/tsgo` 0.46.1), and they work in this module. The `{ source }` shortcut does not turn them on. Send `{ files }` with a tsconfig that has the plugin entry, and the `effect` package under `/app/node_modules/effect`:

```json
{ "compilerOptions": { "plugins": [{ "name": "@effect/language-service" }] } }
```

The rules add less than 1 MiB. The `effect` types are the cost: one file that imports Effect uses 55 to 79 MiB. Import from subpaths such as `effect/Effect` to save 10 to 17 MiB. Results match native `tsc-rs` exactly for Effect 3 and Effect 4 test programs.

## Rebuild the WASM module

The committed module works as it is. To rebuild, you need Rust with the `wasm32-wasip1` target and binaryen `wasm-opt` 132 or later. The build takes 2 to 3 minutes on a 24-core machine.

```bash
git clone https://github.com/pingdotgg/ts-rust /path/to/ts-rust
git -C /path/to/ts-rust checkout 79d71780
git -C /path/to/ts-rust am "$PWD/patches/ts-rust-wasm-memory-wins.patch"
TS_RUST_DIR=/path/to/ts-rust bun run build:wasm
```

The script sets `TS_WASM_STACK_SIZE=8388608` and `CI=1` (upstream's capped cargo wrapper limits jobs and rejects a custom target dir). Set `TOOLS_DIR` to use a private rustup and binaryen. Set `WASM_OPT=none` to skip `wasm-opt`.

## Licenses

The code in this repository is under the [WTFPL](https://www.wtfpl.net/), version 2. See [`LICENSE`](LICENSE).

The WTFPL does not apply to ts-rust code, which includes the ts-rust lines in `patches/`. `src/ts_rust.wasm` and `src/core.js` come from ts-rust at `79d71780` (MIT, T3 Tools Inc.). The module also contains code and lib files from TypeScript (Apache 2.0) and Go (BSD 3-Clause). The upstream license and notice files are in [`third_party/ts-rust/`](third_party/ts-rust/).
