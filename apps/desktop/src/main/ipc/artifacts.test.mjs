import { registerHooks } from "node:module";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  symlink,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Only native IPC/dialog and the database are mocked. Path resolution, disk
// reads, copy operations and the production handler run unchanged.
const state = (globalThis.__artifactTest = {
  handlers: new Map(),
  sessions: new Map(),
  messages: [],
  live: undefined,
  save: { canceled: true },
  revealed: [],
});
const mock = (source) => ({
  url: `data:text/javascript,${encodeURIComponent(source)}`,
  shortCircuit: true,
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron")
      return mock(
        `const s=globalThis.__artifactTest;export const ipcMain={handle:(id,fn)=>s.handlers.set(id,fn)};export const dialog={showSaveDialog:async()=>s.save};export const shell={showItemInFolder:p=>s.revealed.push(p)};`,
      );
    if (specifier === "../store/db")
      return mock(
        `const s=globalThis.__artifactTest;export const getSession=id=>s.sessions.get(id);export const loadMessages=()=>s.messages;export const listSessions=()=>[...s.sessions.values()];export const listRecentDirectories=()=>[];`,
      );
    if (specifier === "../agent/tools/binaries")
      return mock(
        `export const resolveBinary=()=>{throw new Error('Not used in artifact tests')};`,
      );
    if (specifier === "@shared/ipc")
      return next(
        new URL("../../shared/ipc.ts", import.meta.url).href,
        context,
      );
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && error.code === "ERR_MODULE_NOT_FOUND")
        return next(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const { registerFsHandlers } = await import("./fs-handlers.ts");
registerFsHandlers({
  get: () => (state.live ? { getLiveMessages: () => state.live } : undefined),
});
const root = await mkdtemp(path.join(tmpdir(), "flairy-artifact-test-"));
const outside = await mkdtemp(path.join(tmpdir(), "flairy-artifact-outside-"));
after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});
state.sessions.set("session", { id: "session", cwd: root });
const file = path.join(root, "report.txt");
await writeFile(file, "Actual generated report");
const record = {
  role: "toolResult",
  toolName: "write",
  toolCallId: "write-1",
  isError: false,
  details: { artifact: { id: "write-1", path: file } },
};
const access = (args = {}) =>
  state.handlers.get("artifact:access")(null, {
    sessionId: "session",
    artifactId: "write-1",
    action: "preview",
    ...args,
  });

test("artifact preview resolves successful persisted tool records", async () => {
  state.messages = [record];
  const result = await access();
  assert.equal(result.kind, "file");
  assert.equal(result.name, "report.txt");
  assert.equal(result.content, "Actual generated report");
});
test("live tool records are usable before message persistence", async () => {
  state.messages = [];
  state.live = [record];
  assert.equal((await access()).kind, "file");
  state.live = undefined;
});
test("invented IDs, invalid actions, unknown sessions and failed writes are rejected", async () => {
  state.messages = [record];
  assert.equal((await access({ artifactId: "fake" })).kind, "error");
  assert.equal((await access({ sessionId: "other" })).kind, "error");
  assert.equal((await access({ action: "execute" })).kind, "error");
  for (const patch of [
    { role: "assistant" },
    { isError: true },
    { toolName: "read" },
  ]) {
    state.messages = [{ ...record, ...patch }];
    assert.equal((await access()).kind, "error");
  }
});
test("paths supplied by the renderer cannot redirect file access", async () => {
  state.messages = [record];
  const result = await access({ path: "/etc/passwd" });
  assert.equal(result.content, "Actual generated report");
});
test("outside paths and symlinks escaping the session are rejected", async () => {
  const target = path.join(outside, "outside.txt");
  await writeFile(target, "outside");
  const link = path.join(root, "link");
  await symlink(target, link);
  for (const filePath of [target, link, root, path.join(root, "missing")]) {
    state.messages = [
      { ...record, details: { artifact: { id: "write-1", path: filePath } } },
    ];
    assert.equal((await access()).kind, "error");
  }
});
test("binary files expose metadata without unsafe inline HTML or binary content", async () => {
  const binary = path.join(root, "binary.dat");
  await writeFile(binary, Buffer.from([0, 1, 2]));
  state.messages = [
    { ...record, details: { artifact: { id: "write-1", path: binary } } },
  ];
  const result = await access();
  assert.equal(result.kind, "file");
  assert.equal(result.content, undefined);
});
test("reveal uses resolved file; save only uses the native dialog destination", async () => {
  state.messages = [record];
  assert.equal((await access({ action: "reveal" })).kind, "done");
  assert.equal(state.revealed.at(-1), await realpath(file));
  assert.equal((await access({ action: "save" })).kind, "cancelled");
  const destination = path.join(root, "copy.txt");
  state.save = { canceled: false, filePath: destination };
  assert.equal((await access({ action: "save" })).kind, "done");
  assert.equal(await readFile(destination, "utf8"), "Actual generated report");
});

test("present_file registers binary outputs and rejects missing/outside files", async () => {
  const { createPresentFileTool } = await import(
    "../agent/tools/present-file.ts"
  );
  const tool = createPresentFileTool(root);
  const output = path.join(root, "output.pdf");
  await writeFile(output, "%PDF-test-output");
  const result = await tool.execute("export-1", { path: "output.pdf" });
  assert.equal(result.details.artifact.id, "export-1");
  state.messages = [
    {
      role: "toolResult",
      toolName: "present_file",
      toolCallId: "export-1",
      isError: false,
      ...result,
    },
  ];
  assert.equal((await access({ artifactId: "export-1" })).kind, "file");
  await assert.rejects(tool.execute("bad", { path: "../outside.txt" }));
  await assert.rejects(tool.execute("bad", { path: "missing" }));
  await assert.rejects(tool.execute("bad", { path: "link" }));
});

test("write returns a usable file record only after creating the file", async () => {
  const { createWriteTool } = await import("../agent/tools/write.ts");
  const result = await createWriteTool(root).execute("write-2", {
    path: "generated.txt",
    content: "Generated content",
  });
  state.messages = [
    {
      role: "toolResult",
      toolName: "write",
      toolCallId: "write-2",
      isError: false,
      ...result,
    },
  ];
  assert.match(result.content[0].text, /Artifact ID: write-2/);
  assert.equal(
    (await access({ artifactId: "write-2" })).content,
    "Generated content",
  );
});
