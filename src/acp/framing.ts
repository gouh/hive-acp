/**
 * NdJsonParser — newline-delimited JSON framing for ACP stdio transport.
 *
 * Accumulates raw chunks and emits parsed JSON objects as complete
 * lines arrive. Handles partial lines, empty lines, and invalid JSON.
 */

export type OnMessage = (msg: Record<string, any>) => void;
export type OnError = (err: Error, raw: string) => void;

export class NdJsonParser {
  private buffer = "";

  constructor(
    private onMessage: OnMessage,
    private onError?: OnError,
  ) {}

  /** Feed raw data (string or Buffer) into the parser. */
  write(chunk: string | Buffer): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        this.onMessage(JSON.parse(line));
      } catch (err: any) {
        this.onError?.(err, line);
      }
    }
  }

  /** Reset internal buffer. */
  reset(): void {
    this.buffer = "";
  }
}
