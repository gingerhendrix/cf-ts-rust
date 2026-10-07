// Starts the Worker in local workerd with Wrangler and sends real requests to it.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { unstable_startWorker } from "wrangler";

type Worker = Awaited<ReturnType<typeof unstable_startWorker>>;

let worker: Worker;

before(async () => {
  worker = await unstable_startWorker({ config: "wrangler.jsonc", dev: { server: { port: 0 } } });
  await worker.ready;
});

after(async () => {
  await worker?.dispose();
});

async function check(body: unknown, mode: "sync" | "async" = "sync") {
  const response = await worker.fetch(`http://example.com/?mode=${mode}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as any };
}

describe("GET /", () => {
  test("returns usage and the JSPI flag", async () => {
    const response = await worker.fetch("http://example.com/");
    const json = (await response.json()) as any;
    assert.equal(response.status, 200);
    assert.match(json.usage, /POST/);
    assert.equal(typeof json.jspi, "boolean");
  });
});

describe("POST { source }", () => {
  test("valid file gives exit 0 and no diagnostics", async () => {
    const { status, json } = await check({ source: "export const n: number = 1;\n" });
    assert.equal(status, 200);
    assert.equal(json.exitCode, 0);
    assert.deepEqual(json.diagnostics, []);
  });

  test("type error gives exit 2 and TS2322 at the right position", async () => {
    const { status, json } = await check({ source: 'export const n: number = "one";\n' });
    assert.equal(status, 200);
    assert.equal(json.exitCode, 2);
    assert.equal(json.diagnostics.length, 1);
    assert.equal(json.diagnostics[0].code, 2322);
    assert.deepEqual(json.diagnostics[0].startPosition, { line: 0, character: 13 });
  });

  test("async mode gives the same result", async () => {
    const { json } = await check({ source: 'export const n: number = "one";\n' }, "async");
    assert.equal(json.timings.mode, "async");
    assert.equal(json.exitCode, 2);
    assert.equal(json.diagnostics[0].code, 2322);
  });
});

describe("POST { files }", () => {
  test("checks a project with several files", async () => {
    const files = {
      "/app/tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler", lib: ["es2022"], types: [] },
      }),
      "/app/a.ts": "export function greet(name: string): string { return `hi ${name}`; }\n",
      "/app/b.ts": 'import { greet } from "./a";\nexport const x: number = greet("bob");\n',
    };
    const { json } = await check({ files });
    assert.equal(json.exitCode, 2);
    assert.deepEqual(
      json.diagnostics.map((d: any) => [d.fileName, d.code]),
      [["/app/b.ts", 2322]],
    );
  });
});

describe("errors", () => {
  test("bad body gives 400", async () => {
    const { status, json } = await check({ nothing: true });
    assert.equal(status, 400);
    assert.match(json.error, /expected \{ files \} or \{ source \}/);
  });

  test("stack overflow gives 500 and the isolate keeps working", async () => {
    const deep = `export const x = ${Array(30_000).fill("1").join(" + ")};\n`;
    const { status, json } = await check({ source: deep });
    assert.equal(status, 500);
    assert.match(json.error, /RangeError/);

    const next = await check({ source: "export const n: number = 1;\n" });
    assert.equal(next.json.exitCode, 0);
  });
});
