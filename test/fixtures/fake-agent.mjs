import { act } from "./act.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const text = await act({
  role: process.env.PROSECUTOR_ROLE,
  round: process.env.PROSECUTOR_ROUND,
  cwd: process.env.PROSECUTOR_CWD || process.cwd(),
  prompt: Buffer.concat(chunks).toString("utf8"),
});
process.stdout.write(text);
