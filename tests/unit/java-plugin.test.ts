import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JavaPlugin } from "../../plugins/java/src/index.js";

describe("Java plugin", () => it("uses the maintained Java grammar for declarations and parse errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-java-parser-")); await writeFile(join(root, "pom.xml"), "<project />");
  await writeFile(join(root, "Service.java"), "/* class NotASymbol {} */\npublic class Service {\n  public String name() { return \"Service\"; }\n}\nclass Consumer { Service service = new Service(); }\n");
  await writeFile(join(root, "Broken.java"), "class Broken { void run( { }");
  const plugin = new JavaPlugin(); await plugin.index({ root });
  expect((await plugin.getSymbols("Service.java")).map(symbol => `${symbol.kind}:${symbol.name}`)).toEqual(expect.arrayContaining(["class:Service", "method:name", "class:Consumer"]));
  expect(await plugin.getReferences("Service")).toEqual([expect.objectContaining({ file: "Service.java", line: 5 }), expect.objectContaining({ file: "Service.java", line: 5 })]);
  expect(await plugin.getDiagnostics(["Broken.java"])).toEqual([expect.objectContaining({ file: "Broken.java", severity: "error" })]);
}));
