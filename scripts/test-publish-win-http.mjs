// Real loopback HTTP + real PowerShell REST transport; no GitHub calls or real EXE.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const publisher = process.argv[2] || fileURLToPath(new URL("./publish-win.ps1", import.meta.url));
const source = await readFile(publisher, "utf8");
assert.ok(source.includes("https://api.github.com") && source.includes("https://uploads.github.com"), "Refuse to run an unrecognized transport against real services");
const sha = "a".repeat(40);
const tag = "v0.3.10-win.2";
const bytes = Buffer.from([0, 255, 13, 10, 200, 1, 2, 3]);
const hash = createHash("sha256").update(bytes).digest("hex");
const assetName = `MD-Reader-${tag}-windows-x64-setup.exe`;
const cases = ["new-stale-list", "existing-draft", "existing-published", "paginated-draft", "lost-create", "lost-upload", "read-retry", "tag-conflict", "draft-conflict", "bad-digest", "missing-id"];
const errorsExpected = {
  "tag-conflict": "Existing tag points to different source",
  "draft-conflict": "Existing draft targets different source",
  "bad-digest": "Uploaded asset SHA256 mismatch",
  "missing-id": "Release identity mismatch",
};
for (const scenario of cases) {
  const root = await mkdtemp(path.join(tmpdir(), "publish-http-"));
  const state = { release: null, tagExists: false, tagSha: sha, creates: 0, uploads: 0, publishes: 0, lists: 0, reads: 0, errors: [] };
  const makeRelease = () => ({ id: 42, tag_name: tag, draft: true, target_commitish: sha, assets: [], html_url: "https://example.invalid/release" });
  if (["existing-draft", "existing-published", "paginated-draft", "tag-conflict", "draft-conflict"].includes(scenario)) state.release = makeRelease();
  if (["existing-published", "tag-conflict"].includes(scenario)) state.tagExists = true;
  if (scenario === "existing-published") state.release.draft = false;
  if (scenario === "tag-conflict") state.tagSha = "b".repeat(40);
  if (scenario === "draft-conflict") state.release.target_commitish = "b".repeat(40);
  const server = createServer(async (req, res) => {
    const send = (code, value) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(value === undefined ? "" : JSON.stringify(value)); };
    try {
      assert.equal(req.headers.authorization, "Bearer offline-test-token");
      const url = new URL(req.url, "http://localhost");
      const route = url.pathname;
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (route.includes("/releases/tags/")) throw new Error("Published-only endpoint must not be used");
      if (route === `/repos/demo/reader/git/ref/tags/${tag}`) {
        return state.tagExists ? send(200, { object: { type: "commit", sha: state.tagSha } }) : send(404, { message: "Not Found" });
      }
      if (route.startsWith("/repos/demo/reader/commits/")) return send(200, { sha: decodeURIComponent(route.split("/").pop()) });
      if (route === "/repos/demo/reader/releases" && req.method === "GET") {
        state.lists++;
        if (scenario === "new-stale-list") return send(200, []); // stale forever even after POST
        if (scenario === "paginated-draft" && url.searchParams.get("page") === "1") return send(200, Array.from({ length: 100 }, (_, i) => ({ id: i + 100, tag_name: `other-${i}` })));
        return send(200, state.release ? [state.release] : []);
      }
      if (route === "/repos/demo/reader/releases" && req.method === "POST") {
        const data = JSON.parse(body.toString());
        assert.equal(data.tag_name, tag); assert.equal(data.target_commitish, sha); assert.equal(data.draft, true);
        state.creates++; state.release = makeRelease();
        if (scenario === "lost-create" && state.creates === 1) return req.socket.destroy();
        if (scenario === "missing-id") return send(201, { tag_name: tag, draft: true });
        return send(201, state.release);
      }
      if (route === "/repos/demo/reader/releases/42" && req.method === "GET") {
        state.reads++;
        if (scenario === "read-retry" && state.reads === 1) return send(503, { message: "Transient" });
        return send(200, state.release);
      }
      if (route === "/repos/demo/reader/releases/42/assets" && req.method === "POST") {
        assert.equal(url.searchParams.get("name"), assetName);
        assert.deepEqual(body, bytes, "Binary upload must not be JSON/text encoded");
        state.uploads++;
        const asset = { id: 77, name: assetName, size: bytes.length, state: "uploaded", digest: `sha256:${scenario === "bad-digest" ? "0".repeat(64) : hash}` };
        state.release.assets = [asset];
        if (scenario === "lost-upload" && state.uploads === 1) return req.socket.destroy();
        return send(201, asset);
      }
      if (route === "/repos/demo/reader/releases/42" && req.method === "PATCH") {
        const data = JSON.parse(body.toString());
        assert.equal(data.draft, false); assert.equal(data.target_commitish, sha);
        state.publishes++; state.release.draft = false; state.tagExists = true;
        return send(200, state.release);
      }
      throw new Error(`Unexpected request: ${req.method} ${route}`);
    } catch (error) { state.errors.push(error.message); send(500, { message: error.message }); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const file = path.join(root, "publisher.ps1");
    await writeFile(file, source.replaceAll("https://api.github.com", url).replaceAll("https://uploads.github.com", url));
    const bundle = path.join(root, "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis");
    await mkdir(bundle, { recursive: true }); await writeFile(path.join(bundle, "fixture.exe"), bytes);
    const executable = process.env.PUBLISHER_TEST_POWERSHELL || (process.platform === "win32" ? "powershell.exe" : "pwsh");
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, "-Repository", "demo/reader", "-Tag", tag, "-SourceSha", sha], {
      cwd: root, env: { ...process.env, GITHUB_ACTIONS: "true", GH_TOKEN: "offline-test-token", GITHUB_STEP_SUMMARY: path.join(root, "summary.txt") }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 90_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.deepEqual(state.errors, [], output);
    if (errorsExpected[scenario]) {
      assert.notEqual(code, 0, output); assert.ok(output.includes(errorsExpected[scenario]), output);
      assert.equal(state.publishes, 0);
      if (scenario !== "bad-digest") assert.equal(state.uploads, 0);
    } else {
      assert.equal(code, 0, output); assert.equal(state.uploads, 1); assert.equal(state.release.draft, false);
      assert.equal(state.publishes, scenario === "existing-published" ? 0 : 1);
      assert.equal(state.creates, ["existing-draft", "existing-published", "paginated-draft"].includes(scenario) ? 0 : 1);
      if (scenario === "new-stale-list") assert.equal(state.lists, 1, "New draft ID must come from POST, not rediscovery");
      if (scenario === "read-retry") assert.ok(state.reads >= 2);
    }
    console.log(`PASS HTTP ${scenario}`);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
console.log(`${cases.length}/${cases.length} real HTTP/PowerShell transport tests passed; no GitHub access.`);
