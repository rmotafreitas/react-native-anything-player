import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { verifySecurityPatch } from "./check-security-patches.mjs";

// Each reviewed advisory: the package, its installed version, and the folder
// its copy is required from.
const patched = new Map([
  ["GHSA-vfj7-8cjw-p6xm", ["braces", "3.0.3", "."]],
  ["GHSA-g3hv-75wg-m249", ["minimatch", "10.2.6", "."]],
]);
for (const [name, version, dir] of patched.values()) {
  const from = path.resolve(dir);
  assert.equal(createRequire(path.join(from, "package.json"))(name + "/package.json").version, version);
  await verifySecurityPatch(name, from);
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
      console.log(via.url + ": fix verified against the installed dependency");
    }
  }
}
console.log("Expo example audit: all reported advisories covered by tested fixes");
