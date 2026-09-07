import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PythonPlugin } from "../../plugins/python/src/index.js";

describe("Python plugin", () => it("uses the Python AST for declarations and syntax diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-python-ast-")); await writeFile(join(root, "pyproject.toml"), "[project]\nname='fixture'\nversion='0.1.0'\n");
  await writeFile(join(root, "app.py"), "'''\ndef fake(): pass\n'''\nclass Service:\n    async def handle(self):\n        return Service()\n");
  await writeFile(join(root, "broken.py"), "def incomplete(\n");
  const plugin = new PythonPlugin(); await plugin.index({ root });
  expect((await plugin.getSymbols("app.py")).map(symbol => symbol.name)).toEqual(["Service", "handle"]);
  expect(await plugin.getReferences("Service")).toEqual([expect.objectContaining({ file: "app.py", line: 6 })]);
  expect(await plugin.getDiagnostics(["broken.py"])).toEqual([expect.objectContaining({ file: "broken.py", severity: "error" })]);
  await writeFile(join(root, "app.py"), "def replacement():\n    return 2\n");
  expect((await plugin.getSymbols("app.py")).map(symbol => symbol.name)).toEqual(["replacement"]);
}));
