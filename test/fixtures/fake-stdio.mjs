import readline from "node:readline";
import { act } from "./act.mjs";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const turn = JSON.parse(line);
  try {
    const text = await act(turn);
    process.stdout.write(`${JSON.stringify({ type: "result", id: turn.id, text })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ type: "error", id: turn.id, message: String(error?.message ?? error) })}\n`);
  }
}
