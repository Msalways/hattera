import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const load = (name: string) => parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));
const npm = load("npm-package.yml"), render = load("render-deploy.yml");
const releaseStep = npm.jobs["pack-and-prove"].steps.find((step: { id?: string }) => step.id === "release");
const renderStep = render.jobs.deploy.steps.find((step: { run?: string }) => step.run);

// Execute the actual workflow scripts with private files and a mocked network.
function run(script: string, environment: Record<string, string>, stub = "", version = "1.2.3") {
  const home = mkdtempSync(join(tmpdir(), "hattera-workflow-"));
  try {
    writeFileSync(join(home, "package.json"), JSON.stringify({ version }));
    const output = join(home, "outputs");
    writeFileSync(output, "");
    const source = script.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/);
    expect(source).not.toBeNull();
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", stub + "\n" + source![1]], {
      cwd: home, encoding: "utf8", timeout: 10_000, windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: output, ...environment },
    });
    expect(result.error).toBeUndefined();
    return { ...result, output: readFileSync(output, "utf8") };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const context = { GITHUB_REPOSITORY: "Msalways/hattera", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch" };

describe("npm publication workflow", () => {
  it.each([
    [{}, false],
    [{ MANUAL_PUBLISH: "true" }, true],
    [{ GITHUB_REF: "refs/tags/v1.2.3", MANUAL_PUBLISH: "false", TAG_PUBLISH_ENABLED: "true" }, false],
    [{ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v1.2.3", TAG_PUBLISH_ENABLED: "true" }, true],
    [{ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v1.2.3", TAG_PUBLISH_ENABLED: "false" }, false],
    [{ GITHUB_EVENT_NAME: "pull_request", MANUAL_PUBLISH: "true" }, false],
  ])("selects publication for %j", (env, expected) => {
    const result = run(releaseStep.run, { ...context, ...env });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain(`publish=${expected}\n`);
    expect(result.output).toContain("dist_tag=latest\n");
  });

  it.each([
    { GITHUB_REPOSITORY: "another/fork", MANUAL_PUBLISH: "true" },
    { GITHUB_REF: "refs/heads/experiment", MANUAL_PUBLISH: "true" },
    { GITHUB_REF: "refs/tags/v9.9.9" },
  ])("refuses a mismatched release request: %j", (env) => {
    const result = run(releaseStep.run, { ...context, ...env });
    expect(result.status).toBe(1);
    expect(result.output).toBe("");
  });

  it("publishes prereleases under next", () => {
    const result = run(releaseStep.run, context, "", "1.2.3-beta.1");
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain("dist_tag=next\n");
  });

  it("keeps every installation job ahead of publishing and scopes the credential to publishing", () => {
    expect(npm.on.workflow_dispatch.inputs.publish.default).toBe(false);
    const publish = npm.jobs["publish-npm"];
    expect(publish.needs).toEqual(["pack-and-prove", "install-and-prove"]);
    expect(publish.if).toBe("needs.pack-and-prove.outputs.publish == 'true'");
    expect(publish.permissions["id-token"]).toBe("write");
    const step = publish.steps.find((step: { name?: string }) => step.name === "Publish to npm");
    expect(step.env.NODE_AUTH_TOKEN).toBe("${{ secrets.NPM_TOKEN }}");
    expect(step.run).toContain('--tag "$NPM_DIST_TAG"');
    expect(JSON.stringify(npm.jobs["pack-and-prove"])).not.toContain("secrets.NPM_TOKEN");
    expect(JSON.stringify(npm.jobs["install-and-prove"])).not.toContain("secrets.NPM_TOKEN");
    const release = load("release.yml");
    const dispatch = release.jobs.assemble.steps.find((step: { name?: string }) => step.name === "Publish (only when asked to)");
    expect(dispatch.run).toContain('--field "publish=$NPM_PUBLISH"');
    expect(dispatch.env.NPM_PUBLISH).toBe("${{ vars.HATTERA_NPM_PUBLISH_ENABLED == 'true' }}");
  });
});

const sha = "a".repeat(40);
const hook = "https://api.render.com/deploy/srv-fixture?key=fixture-only-key";
const renderContext = { GITHUB_SHA: sha, RENDER_DEPLOY_HOOK_URL: hook };
describe("manual Render deployments", () => {
  it("has no push/dependency trigger and disables Blueprint auto-deploys", () => {
    expect(render.on).toEqual({ workflow_dispatch: null });
    const blueprint = parse(readFileSync(new URL("../render.yaml", import.meta.url), "utf8"));
    expect(blueprint.services[0].autoDeployTrigger).toBe("off");
    expect(render.concurrency["cancel-in-progress"]).toBe(false);
  });

  it.each([200, 202])("requests the selected SHA and reports HTTP %i accurately", (status) => {
    const stub = `import assert from 'node:assert/strict';
      globalThis.fetch = async (url, options) => {
        assert.equal(url.origin, 'https://api.render.com');
        assert.equal(url.searchParams.get('ref'), '${sha}');
        assert.equal(url.searchParams.get('key'), 'fixture-only-key');
        assert.equal(options.method, 'POST');
        assert.equal(options.redirect, 'error');
        return new Response(${status === 202 ? "null" : "'fixture-only-key'"}, { status: ${status} });
      };`;
    const result = run(renderStep.run, renderContext, stub);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain(status === 202 ? "queued" : "accepted");
    expect(result.stdout + result.stderr + result.output).not.toContain("fixture-only-key");
  });

  it.each(["", "not-a-url", "http://api.render.com/deploy/srv-fixture?key=fixture-only-key", "https://example.com/deploy/srv-fixture?key=fixture-only-key"])("rejects a missing/invalid hook without printing it", (value) => {
    const result = run(renderStep.run, { ...renderContext, RENDER_DEPLOY_HOOK_URL: value });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("fixture-only-key");
  });

  it("reports failed or interrupted requests without leaking the hook", () => {
    for (const stub of ["globalThis.fetch = async () => new Response('fixture-only-key', { status: 401 });", "globalThis.fetch = async () => { throw new Error('fixture-only-key'); };"]) {
      const result = run(renderStep.run, renderContext, stub);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/Render (rejected|did not accept)/);
      expect(result.stderr).not.toContain("fixture-only-key");
    }
  });
});
