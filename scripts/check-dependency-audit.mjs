#!/usr/bin/env node
import { auditDependencies } from "./dependency-audit.mjs";
try { auditDependencies(process.cwd(), "yarn"); }
catch (error) { console.error(error.message); process.exit(1); }
