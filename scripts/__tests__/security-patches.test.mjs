import { test } from "node:test";
import { verifySecurityPatch } from "../check-security-patches.mjs";
test("braces blocks the advisory reproduction", () => verifySecurityPatch("braces"));
test("sprintf-js blocks the advisory reproduction", () => verifySecurityPatch("sprintf-js"));
test("zod rejects an oversized collection before its elements", () => verifySecurityPatch("zod"));
test("deepmerge never takes a prototype from the data", () => verifySecurityPatch("deepmerge"));
