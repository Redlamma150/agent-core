// Creates .env with a fresh access token and VAPID keys. Never overwrites an existing .env and never prints secrets.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import webpush from "web-push";

if (existsSync(".env")) {
  console.log(".env already exists: left untouched.");
  process.exit(0);
}
let tailscaleIp = "";
try {
  tailscaleIp = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0] ?? "";
} catch {
  // Tailscale CLI not available: only localhost is bound, which is what `tailscale serve` needs anyway.
}
const vapid = webpush.generateVAPIDKeys();
const values = {
  API_BIND_HOSTS: ["127.0.0.1", tailscaleIp].filter(Boolean).join(","),
  APP_ACCESS_TOKEN: randomBytes(32).toString("hex"),
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
};
const lines = readFileSync(".env.example", "utf8")
  .split("\n")
  .map((l) => {
    const key = l.split("=")[0];
    return key in values ? `${key}=${values[key]}` : l;
  });
writeFileSync(".env", lines.join("\n"), { mode: 0o600 });
console.log(".env created (permissions 600). The access token is inside it: run  grep APP_ACCESS_TOKEN .env  when you need it on the phone.\nVAPID_SUBJECT keeps the placeholder from .env.example; it is sent to the push services, so set it to a contact you are happy to share.");
