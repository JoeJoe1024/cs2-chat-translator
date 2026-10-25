import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/shared/protocol";
import { reduce, type ServerView } from "../../web/src/lib/useServer";
import { entry, makeState } from "./fakeServer";

const base = (): ServerView => ({ app: makeState(), entries: [], connection: "online", toasts: [], prepared: null });
const msg = (id: string, channel: ChatMessage["channel"] = "all"): ChatMessage => ({ id, at: 1, channel, sender: id, dead: false, text: id, isSelf: false, formatId: "f" });

describe("server event reducer", () => {
  it("appends chat, then attaches the translation to the same message", () => {
    let v = reduce(base(), { type: "event", event: { type: "chat", message: msg("m1", "ct") } });
    expect(v.entries[0]?.translation.status).toBe("pending");
    v = reduce(v, { type: "event", event: { type: "translation", update: { id: "m1", status: "done", text: "y" } } });
    expect(v.entries[0]?.translation).toMatchObject({ status: "done", text: "y" });
  });

  it("keeps message order stable when translations finish out of order", () => {
    let v = base();
    for (const id of ["m1", "m2", "m3"]) v = reduce(v, { type: "event", event: { type: "chat", message: msg(id) } });
    for (const id of ["m3", "m1", "m2"]) v = reduce(v, { type: "event", event: { type: "translation", update: { id, status: "done", text: `t-${id}` } } });
    expect(v.entries.map((e) => e.id)).toEqual(["m1", "m2", "m3"]);
    expect(v.entries.map((e) => e.translation.text)).toEqual(["t-m1", "t-m2", "t-m3"]);
  });

  it("caps the list and clears it", () => {
    let v = base();
    for (let i = 0; i < 520; i++) v = reduce(v, { type: "event", event: { type: "chat", message: msg(`m${i}`) } });
    expect(v.entries).toHaveLength(500);
    expect(reduce(v, { type: "event", event: { type: "cleared" } }).entries).toEqual([]);
  });

  it("de-duplicates notices by code and tracks cfg preparation", () => {
    let v = reduce(base(), { type: "event", event: { type: "notice", level: "warn", code: "gemini-auth" } });
    v = reduce(v, { type: "event", event: { type: "notice", level: "warn", code: "gemini-auth" } });
    expect(v.toasts).toHaveLength(1);
    const cfg = { id: "p1", mode: "direct" as const, channel: "team" as const, lines: ["x"], file: "f", truncated: false, preparedAt: 1, clickedAt: 10, bindCommand: "b" };
    v = reduce(v, { type: "event", event: { type: "cfg", prepared: cfg } });
    expect(v.prepared).toEqual(cfg);
  });

  it("keeps the message from the latest click, whichever answer arrives last", () => {
    const base2 = (id: string, clickedAt: number, mode: "translated" | "direct") => ({ id, mode, channel: "all" as const, lines: [id], file: "f", truncated: false, preparedAt: clickedAt, clickedAt, bindCommand: "b" });
    let v = reduce(base(), { type: "event", event: { type: "cfg", prepared: base2("new", 200, "direct") } });
    v = reduce(v, { type: "event", event: { type: "cfg", prepared: base2("old", 100, "translated") } }); // a late, older answer
    expect(v.prepared?.id).toBe("new");
    v = reduce(v, { type: "prepared", cfg: base2("older-too", 150, "translated") });
    expect(v.prepared?.id).toBe("new");
    v = reduce(v, { type: "event", event: { type: "cfg", prepared: base2("newest", 300, "translated") } });
    expect(v.prepared?.id).toBe("newest");
    v = reduce(v, { type: "event", event: { type: "cfg-cleared" } });
    expect(v.prepared).toBeNull();
  });

  it("takes the prepared message from the server state on load or reconnect", () => {
    const cfg = { id: "p9", mode: "direct" as const, channel: "all" as const, lines: ["hi"], file: "f", truncated: false, preparedAt: 1, clickedAt: 5, bindCommand: "b" };
    expect(reduce(base(), { type: "state", state: makeState({ prepared: cfg }) }).prepared).toEqual(cfg);
    expect(reduce({ ...base(), prepared: cfg }, { type: "state", state: makeState({ prepared: null }) }).prepared).toBeNull();
  });

  it("resyncing replaces history from the server", () => {
    const s = makeState({ history: [entry({ id: "m9" })] });
    expect(reduce(base(), { type: "state", state: s }).entries.map((e) => e.id)).toEqual(["m9"]);
  });
});
