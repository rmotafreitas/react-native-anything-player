import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function verifySecurityPatch(name, cwd = process.cwd()) {
  const require = createRequire(path.join(cwd, "package.json"));
  const library = require(name);
  if (name === "braces") {
    assert.deepEqual(library.expand("a{b,{c,d}}"), ["ab", "ac", "ad"]);
    const pattern = "{".repeat(5000) + "a,b" + "}".repeat(5000);
    for (const method of ["parse", "compile", "expand", "stringify"]) {
      assert.throws(() => library[method](pattern), { name: "SyntaxError" });
    }
    let ast = { type: "text", value: "x" };
    for (let i = 0; i < 5000; i++) ast = { type: "root", nodes: [ast] };
    for (const method of ["compile", "expand", "stringify"]) {
      assert.throws(() => library[method](ast), { name: "SyntaxError" });
    }
    const cycle = { type: "root", nodes: [] };
    cycle.nodes.push(cycle);
    assert.throws(() => library.compile(cycle), { name: "SyntaxError" });
    const parentCycle = { type: "paren", nodes: [] };
    parentCycle.parent = parentCycle;
    for (const method of ["compile", "expand", "stringify"]) {
      assert.throws(() => library[method](parentCycle), { name: "SyntaxError" });
    }
  } else if (name === "sprintf-js") {
    assert.equal(library.sprintf("%.2f", 1.25), "1.25");
    for (const specifier of ["e", "f", "g"]) {
      assert.ok(library.sprintf("%.999999999" + specifier, 1.25).length < 120);
    }
    assert.equal(library.sprintf("%.0g", 1.25), "1");
  } else if (name === "glob") {
    // GHSA-3g3m-2fjr-6pw4: an aborted walk rejected but kept reading
    // directories. Fixed upstream in 14.0.2; the Expo CLI's 13.0.6 is patched
    // to stop, and its entry is the unminified build that the patch covers.
    const root = mkdtempSync(path.join(tmpdir(), "rnap-glob-"));
    try {
      for (const dir of ["a/x", "a/y", "b/x", "b/y", "c/x"]) mkdirSync(path.join(root, dir), { recursive: true });
      assert.equal((await library.glob("**", { cwd: root })).length, 9);
      const controller = new AbortController();
      let reads = 0;
      const readdir = (...args) => {
        if (++reads === 2) controller.abort();
        return fs.readdir(...args);
      };
      await assert.rejects(library.glob("**", { cwd: root, signal: controller.signal, fs: { ...fs, readdir } }));
      const atRejection = reads;
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(reads, atRejection);
    } finally {
      rmSync(root, { recursive: true });
    }
  } else if (name === "minimatch") {
    // GHSA-g3hv-75wg-m249: each "**/.." doubled the patterns without bound,
    // then every pair was compared. Fixed upstream in 11.0.1; the Expo CLI's
    // 10.2.6 is patched to stop at braceExpandMax.
    const pattern = "**/../x/y/".repeat(10) + "z";
    assert.ok(new library.Minimatch(pattern, { optimizationLevel: 2, braceExpandMax: 64 }).set.length <= 64);
    assert.equal(library.minimatch("a/x/y/z", "**/x/y/z", { optimizationLevel: 2 }), true);
  } else if (name === "zod") {
    // GHSA-mrhx-c7xc-m3w5: an oversized array/set built one issue per bad
    // element before its size bound was reported. Fixed upstream in 4.6.6;
    // the Expo CLI's 3.x is patched to reject the size first.
    const { z } = library;
    assert.equal(z.array(z.number()).max(2).safeParse([1, 2]).success, true);
    assert.equal(z.array(z.number()).safeParse(["a", "b"]).error.issues.length, 2);
    const flood = Array(100000).fill("x");
    for (const schema of [z.array(z.number()).max(2), z.array(z.number()).length(2)]) {
      const { error } = schema.safeParse(flood);
      assert.equal(error.issues.length, 1);
      assert.equal(error.issues[0].code, "too_big");
    }
    const { error } = z.set(z.number()).max(1).safeParse(new Set(flood.map((x, i) => x + i)));
    assert.equal(error.issues.length, 1);
  } else if (name === "deepmerge") {
    // GHSA-gcqx-w48m-w2h4: mergeObject() assigned a source's "__proto__" key,
    // setting the result's prototype when the target was not a plain object.
    // No fixed release: the Expo CLI's 4.3.1 is patched to write own properties.
    const evil = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
    for (const target of [{}, Object.create(null), 5]) {
      const merged = library(target, evil);
      assert.equal(Object.getPrototypeOf(merged), Object.prototype);
      assert.equal(merged.polluted, undefined);
      assert.equal(merged.a, 1);
    }
    assert.deepEqual(library({ a: { b: 1 } }, { a: { c: 2 } }), { a: { b: 1, c: 2 } });
  } else {
    throw new Error("Unknown security patch: " + name);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const name of process.argv.slice(2)) {
    await verifySecurityPatch(name);
    console.log(name + ": security patch regression passed");
  }
}
