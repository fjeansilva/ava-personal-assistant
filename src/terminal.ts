import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import type { Readable, Writable } from "node:stream";

export interface TerminalMessage {
  message: string;
  write: (text: string) => void;
  signal: AbortSignal;
}

export type MessageHandler = (message: TerminalMessage) => Promise<void>;

interface TerminalOptions {
  input?: Readable;
  output?: Writable;
}

export async function runTerminal(
  handleMessage: MessageHandler,
  { input = stdin, output = stdout }: TerminalOptions = {},
): Promise<void> {
  const readline = createInterface({
    input,
    output,
    terminal: input === stdin && output === stdout && Boolean(stdin.isTTY && stdout.isTTY),
    crlfDelay: Infinity,
    prompt: "You: ",
  });
  const controller = new AbortController();
  let inputClosed = false;

  const stop = () => {
    controller.abort();
    readline.close();
  };

  readline.on("close", () => {
    inputClosed = true;
  });
  readline.on("SIGINT", stop);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  output.write("Type a message, or /exit to quit. Ctrl+C also exits.\n\n");
  readline.prompt();

  try {
    for await (const line of readline) {
      if (controller.signal.aborted) break;

      const message = line.trim();
      if (message === "/exit") break;

      if (message) {
        output.write("Ava: ");

        try {
          await handleMessage({
            message,
            write: (text) => {
              output.write(text);
            },
            signal: controller.signal,
          });
        } catch (error) {
          if (!controller.signal.aborted) {
            const description = error instanceof Error ? error.message : String(error);
            output.write(`\nError: ${description}`);
          }
        } finally {
          output.write("\n\n");
        }
      }

      if (!inputClosed && !controller.signal.aborted) readline.prompt();
    }
  } finally {
    controller.abort();
    readline.close();
    readline.off("SIGINT", stop);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
