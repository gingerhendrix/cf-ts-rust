// ts-rust (TypeScript 7 checker in Rust) as WASM in a Cloudflare Worker.
// POST { files, args? } or { source } and get { exitCode, diagnostics, stderr, timings }.
// ?mode=async uses runTscAsync (JSPI when workerd has it); the default is runTsc.
import tsRust from "./ts_rust.wasm"; // Wrangler gives a compiled WebAssembly.Module
import { memoryFileSystem, runTsc, runTscAsync } from "./core.js";

type CheckRequest = { files?: Record<string, string>; args?: string[]; source?: string };

const DEFAULT_TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "es2022",
    module: "esnext",
    lib: ["es2022"],
    types: [],
    noEmit: true,
  },
});

// One checker: on one WASM thread, more checkers only split the files, and each one
// resolves the lib types again. Diagnostics are the same; memory and time are lower.
const DEFAULT_ARGS = ["-p", "/app", "--noEmit", "--checkers", "1"];

let checksInIsolate = 0;

function toFiles(body: CheckRequest): Record<string, string> {
  if (typeof body.source === "string") {
    return { "/app/tsconfig.json": DEFAULT_TSCONFIG, "/app/index.ts": body.source };
  }
  if (body.files && typeof body.files === "object") return body.files;
  throw new Error("expected { files } or { source }");
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({
        usage: "POST { files: Record<path,string>, args?: string[] } | { source: string }",
        jspi: typeof (WebAssembly as any).promising === "function",
      });
    }
    const mode = new URL(request.url).searchParams.get("mode") === "async" ? "async" : "sync";
    let files: Record<string, string>;
    let body: CheckRequest;
    try {
      body = await request.json();
      files = toFiles(body);
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 400 });
    }

    const cold = checksInIsolate++ === 0;
    let stderr = "";
    const decoder = new TextDecoder();
    const options = {
      args: body.args ?? DEFAULT_ARGS,
      cwd: "/app",
      fs: memoryFileSystem(files),
      diagnosticsJson: true,
      env: { NO_COLOR: "1" },
      stderr: (chunk: Uint8Array) => (stderr += decoder.decode(chunk)),
    };

    const start = performance.now();
    try {
      const result = mode === "async" ? await runTscAsync(tsRust, options) : runTsc(tsRust, options);
      return Response.json({
        exitCode: result.exitCode,
        diagnostics: result.diagnostics,
        stderr,
        timings: { checkMs: performance.now() - start, cold, mode, checksInIsolate },
        memory: { linearBytes: result.memoryBytes, linearMiB: +(result.memoryBytes / 2 ** 20).toFixed(1) },
      });
    } catch (error: any) {
      return Response.json(
        {
          error: `${error?.name}: ${error?.message}`,
          stderr: error?.stderr ?? stderr,
          timings: { checkMs: performance.now() - start, cold, mode, checksInIsolate },
        },
        { status: 500 },
      );
    }
  },
};
