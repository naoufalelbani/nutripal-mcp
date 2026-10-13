import { saveSession, MfpClient, validateProfile } from "./mfp.ts";
import { stdin, stdout } from "node:process";

async function readSecret(): Promise<string> {
  if (!stdin.isTTY) {
    let value = "";
    for await (const chunk of stdin) value += String(chunk);
    return value.trim();
  }
  stdout.write("MyFitnessPal session token (input hidden): ");
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  try {
    for await (const chunk of stdin) {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n") { stdout.write("\n"); return value; }
        if (char === "\u0003") { stdout.write("\n"); process.exit(130); }
        if (char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    }
  } finally { stdin.setRawMode(false); stdin.pause(); }
  return value;
}
const args = process.argv.slice(2);
const flag = args.indexOf("--profile");
if (flag >= 0 && (!args[flag + 1] || args.length !== 2)) throw new Error("Usage: auth [--profile <name>]");
if (flag < 0 && args.length) throw new Error("Usage: auth [--profile <name>]");
const profile = validateProfile(flag >= 0 ? args[flag + 1]! : "default");
const fromEnv = process.env.MFP_COOKIE;
const token = fromEnv || await readSecret();
try {
  await new MfpClient(token, profile).account();
  if (!fromEnv) await saveSession(token, profile);
  console.log(fromEnv ? `Session checked for profile ${profile}; MFP_COOKIE was not saved.`
    : `Session saved and checked for profile ${profile}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
