import { X509Certificate } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generate } from "selfsigned";

export interface Certificate {
  cert: string;
  key: string;
}

const DAY = 24 * 60 * 60 * 1000;

function defaultCertDir() {
  return path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "svdr",
  );
}

/**
 * Returns a self-signed certificate for localhost. The certificate is kept
 * on disk and reused until it is about to expire, so that trusting it in a
 * browser once is enough.
 */
export async function loadCertificate(
  dir = defaultCertDir(),
): Promise<Certificate> {
  const certFile = path.join(dir, "localhost-cert.pem");
  const keyFile = path.join(dir, "localhost-key.pem");

  try {
    const [cert, key] = await Promise.all([
      readFile(certFile, "utf8"),
      readFile(keyFile, "utf8"),
    ]);
    if (Date.parse(new X509Certificate(cert).validTo) - Date.now() > DAY) {
      return { cert, key };
    }
  } catch {
    // Missing or unreadable, generate a new one below.
  }

  const pems = await generate([{ name: "commonName", value: "localhost" }], {
    keyType: "ec",
    curve: "P-256",
    algorithm: "sha256",
    notBeforeDate: new Date(Date.now() - DAY),
    // Browsers reject certificates that are valid for more than 398 days.
    notAfterDate: new Date(Date.now() + 365 * DAY),
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
          { type: 7, ip: "::1" },
        ],
      },
    ],
  });

  const certificate = { cert: pems.cert, key: pems.private };
  try {
    await mkdir(dir, { recursive: true });
    await Promise.all([
      writeFile(certFile, certificate.cert),
      writeFile(keyFile, certificate.key, { mode: 0o600 }),
    ]);
  } catch {
    // The certificate still works for this run if it cannot be saved.
  }
  return certificate;
}
