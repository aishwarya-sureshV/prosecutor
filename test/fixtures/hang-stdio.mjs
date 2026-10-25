import { writeFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

// prompt "hang": no reply, writes late.txt after 600ms. "die": stderr then exit 3. Otherwise replies.
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  const turn = JSON.parse(line);
  if (turn.prompt === "hang") setTimeout(() => writeFileSync(join(turn.cwd, "late.txt"), "late\n"), 600);
  else if (turn.prompt === "die") {
    process.stderr.write("boom from harness\n");
    setTimeout(() => process.exit(3), 50);
  } else process.stdout.write(`${JSON.stringify({ type: "result", id: turn.id, text: `pong ${process.pid}` })}\n`);
}
