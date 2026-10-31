#!/usr/bin/env node
import { verifySecurityPatch } from "./check-security-patches.mjs";
import { auditDependencies } from "./dependency-audit.mjs";
try {
  await verifySecurityPatch("braces");
  await verifySecurityPatch("sprintf-js");
 auditDependencies(process.cwd(), "yarn"); }
catch (error) { console.error(error.message); process.exit(1); }
