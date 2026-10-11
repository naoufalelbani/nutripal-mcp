import { MfpClient } from "./mfp.ts";

// Prints status and response structure only. Never prints cookies or response bodies.
const result = await new MfpClient().diagnoseSearch();
console.log(JSON.stringify(result, null, 2));
