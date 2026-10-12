import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateEncrypt } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function verifySecurityPatch(name, cwd = process.cwd()) {
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
  } else if (name === "sprintf-js") {
    assert.equal(library.sprintf("%.2f", 1.25), "1.25");
    for (const specifier of ["e", "f", "g"]) {
      assert.ok(library.sprintf("%.999999999" + specifier, 1.25).length < 120);
    }
    assert.equal(library.sprintf("%.0g", 1.25), "1");
  } else if (name === "node-forge") {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = library.pki.publicKeyFromPem(publicKey.export({ type: "pkcs1", format: "pem" }));
    const digest = library.md.sha256.create().update("security regression").digest().getBytes();
    const asn1 = library.asn1;
    const node = (type, value, constructed = false) => asn1.create(asn1.Class.UNIVERSAL, type, constructed, value);
    const oid = node(asn1.Type.OID, asn1.oidToDer(library.pki.oids.sha256).getBytes());
    const nil = node(asn1.Type.NULL, "");
    const sign = algorithm => {
      const info = node(asn1.Type.SEQUENCE, [node(asn1.Type.SEQUENCE, algorithm, true), node(asn1.Type.OCTETSTRING, digest)], true);
      const der = Buffer.from(asn1.toDer(info).getBytes(), "binary");
      const encoded = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(256 - der.length - 3, 255), Buffer.from([0]), der]);
      return privateEncrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, encoded).toString("binary");
    };
    for (const valid of [[oid], [oid, nil]]) assert.equal(key.verify(digest, sign(valid)), true);
    for (const invalid of [[oid, nil, nil], [oid, nil, node(asn1.Type.OCTETSTRING, "garbage")]]) {
      assert.throws(() => key.verify(digest, sign(invalid)), /DigestInfo/);
    }
  } else {
    throw new Error("Unknown security patch: " + name);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const name of process.argv.slice(2)) {
    verifySecurityPatch(name);
    console.log(name + ": security patch regression passed");
  }
}
