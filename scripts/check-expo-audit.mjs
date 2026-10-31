import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { verifySecurityPatch } from "./check-security-patches.mjs";

const patched = new Map([
  ["GHSA-vfj7-8cjw-p6xm", ["braces", "3.0.3"]],
  ["GHSA-mrhx-c7xc-m3w5", ["zod", "3.25.76"]],
  ["GHSA-gcqx-w48m-w2h4", ["deepmerge", "4.3.1"]],
  ["GHSA-3g3m-2fjr-6pw4", ["glob", "13.0.6"]],
  ["GHSA-g3hv-75wg-m249", ["minimatch", "10.2.6"]],
]);
const require = createRequire(path.join(process.cwd(), "package.json"));
for (const [name, version] of patched.values()) {
  assert.equal(require(name + "/package.json").version, version);
  await verifySecurityPatch(name);
}
const result = spawnSync("npm", ["audit", "--json"], { encoding: "utf8", timeout: 120000 });
assert.ok(!result.error && [0, 1].includes(result.status), "npm audit must complete");
const report = JSON.parse(result.stdout);
assert.ok(report.metadata?.vulnerabilities && report.vulnerabilities && !report.error, "Complete audit required");
const findings = Object.values(report.vulnerabilities);
assert.equal(findings.length, report.metadata.vulnerabilities.total);
for (const finding of findings) {
  assert.ok(finding.via.length, "Advisory details required");
  for (const via of finding.via) {
    if (typeof via === "string") {
      assert.ok(report.vulnerabilities[via], "Transitive advisory must be present");
    } else {
      const policy = patched.get(via.url?.split("/").at(-1));
      assert.ok(policy && via.name === policy[0], "Unreviewed advisory: " + via.url);
      console.log(via.url + ": local patch verified against installed dependency");
    }
  }
}
console.log("Expo example audit: all reported advisories covered by tested local patches");
