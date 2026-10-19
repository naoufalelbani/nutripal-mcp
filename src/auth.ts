import { saveSession, MfpClient, validateProfile, type SessionFormat } from "./mfp.ts";
import { stdin, stdout } from "node:process";

async function chooseFormat(): Promise<SessionFormat> {
  if (!stdin.isTTY) return "json";
  stdout.write("\nChoose how NutriPal stores this session:\n" +
    "  1) session  — plain cookie text in sessions/<profile> (simple, compatible)\n" +
    "  2) JSON     — cookie plus saved timestamp in sessions/<profile>.json\n" +
    "Both are local plaintext files protected with owner-only permissions (0600). JSON is structured, not encrypted, and neither option survives a reset of this environment's home directory.\n" +
    "Choose [1/2, default 2]: ");
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    const finish = (format: SessionFormat) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write(format === "session" ? "1\n" : "2\n");
      resolve(format);
    };
    const onData = (chunk: unknown) => {
      const input = String(chunk);
      if (input.includes("\u0003")) { stdout.write("\n"); process.exit(130); }
      if (input.includes("1")) finish("session");
      else if (input.includes("2") || input.includes("\r") || input.includes("\n")) finish("json");
    };
    stdin.on("data", onData);
  });
}

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
let profileArg: string | undefined;
let formatArg: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--profile" && args[i + 1]) profileArg = args[++i];
  else if (args[i] === "--format" && args[i + 1]) formatArg = args[++i];
  else throw new Error("Usage: auth [--profile <name>] [--format session|json]");
}
if (formatArg && formatArg !== "session" && formatArg !== "json")
  throw new Error("Usage: auth [--profile <name>] [--format session|json]");
const profile = validateProfile(profileArg || "default");
const fromEnv = process.env.MFP_COOKIE;
const format = fromEnv ? "json" : (formatArg as SessionFormat | undefined) || await chooseFormat();
const token = fromEnv || await readSecret();
try {
  await new MfpClient(token, profile).account();
  if (!fromEnv) await saveSession(token, profile, format);
  console.log(fromEnv ? `Session checked for profile ${profile}; MFP_COOKIE was not saved.`
    : `Session saved as ${format} and checked for profile ${profile}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
