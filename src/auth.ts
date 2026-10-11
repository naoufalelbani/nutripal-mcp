import { saveSession, MfpClient } from "./mfp.ts";
import { stdin, stdout } from "node:process";

async function readSecret(): Promise<string> {
  if (!stdin.isTTY) return (await Bun.stdin.text()).trim();
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
const token = await readSecret();
try {
  await new MfpClient(token).account();
  await saveSession(token);
  console.log("Session saved and checked.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
