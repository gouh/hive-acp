import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NdJsonParser } from "../src/acp/framing.js";

describe("NdJsonParser", () => {
  it("parses a complete line", () => {
    const msgs: any[] = [];
    const p = new NdJsonParser((m) => msgs.push(m));
    p.write('{"id":1}\n');
    assert.deepEqual(msgs, [{ id: 1 }]);
  });

  it("handles partial chunks", () => {
    const msgs: any[] = [];
    const p = new NdJsonParser((m) => msgs.push(m));
    p.write('{"id":');
    assert.equal(msgs.length, 0);
    p.write('1}\n');
    assert.deepEqual(msgs, [{ id: 1 }]);
  });

  it("handles multiple messages in one chunk", () => {
    const msgs: any[] = [];
    const p = new NdJsonParser((m) => msgs.push(m));
    p.write('{"a":1}\n{"b":2}\n');
    assert.equal(msgs.length, 2);
    assert.deepEqual(msgs[0], { a: 1 });
    assert.deepEqual(msgs[1], { b: 2 });
  });

  it("skips empty lines", () => {
    const msgs: any[] = [];
    const p = new NdJsonParser((m) => msgs.push(m));
    p.write('\n\n{"id":1}\n\n');
    assert.equal(msgs.length, 1);
  });

  it("calls onError for invalid JSON", () => {
    const msgs: any[] = [];
    const errs: string[] = [];
    const p = new NdJsonParser((m) => msgs.push(m), (e, raw) => errs.push(raw));
    p.write('not json\n{"id":1}\n');
    assert.equal(msgs.length, 1);
    assert.equal(errs.length, 1);
    assert.equal(errs[0], "not json");
  });

  it("handles Buffer input", () => {
    const msgs: any[] = [];
    const p = new NdJsonParser((m) => msgs.push(m));
    p.write(Buffer.from('{"id":1}\n'));
    assert.deepEqual(msgs, [{ id: 1 }]);
  });

  it("handles split across multiple writes", () => {
    const msgs: any[] = [];
    const p = new NdJsonParser((m) => msgs.push(m));
    p.write('{"jsonrpc":"2.0",');
    p.write('"id":0,');
    p.write('"method":"init"}\n');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].method, "init");
  });

  it("reset clears the buffer", () => {
    const msgs: any[] = [];
    const p = new NdJsonParser((m) => msgs.push(m));
    p.write('{"partial":');
    p.reset();
    p.write('{"id":1}\n');
    assert.deepEqual(msgs, [{ id: 1 }]);
  });

  it("handles trailing data without newline", () => {
    const msgs: any[] = [];
    const p = new NdJsonParser((m) => msgs.push(m));
    p.write('{"a":1}\n{"b":2}');
    assert.equal(msgs.length, 1, "only complete lines are parsed");
    p.write('\n');
    assert.equal(msgs.length, 2, "second message parsed after newline");
  });
});
