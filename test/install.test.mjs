import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const cli = path.resolve('dist/cli.js');
async function setup() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'revloop-user-install-'));
  const home = path.join(base, 'user'), project = path.join(base, 'project');
  await mkdir(home); await mkdir(project);
  const run = args => spawnSync(process.execPath, [cli, ...args], {
    cwd: project, env: {...process.env, USERPROFILE: home, HOME: home}, encoding: 'utf8', windowsHide: true
  });
  return {home, project, run};
}

test('global install uses user home from another project without changing that project', async () => {
  const {home, project, run} = await setup();
  const result = run(['install', '--global']);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.scope, 'user');
  assert.deepEqual(data.installed, [
    path.join(home, '.agents', 'skills', 'revloop', 'SKILL.md'),
    path.join(home, '.claude', 'skills', 'revloop', 'SKILL.md')
  ]);
  for (const file of data.installed) assert.ok((await readFile(file, 'utf8')).includes(cli));
  assert.deepEqual(await readdir(project), []);
});

test('global install rejects ambiguous targets and preserves an existing personal skill', async () => {
  const {home, project, run} = await setup();
  const bad = run(['install', '--global', '--root', project]);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /cannot be combined/);
  assert.deepEqual(await readdir(home), []);
  const dir = path.join(home, '.claude', 'skills', 'revloop');
  await mkdir(dir, {recursive:true});
  const file = path.join(dir, 'SKILL.md'); await writeFile(file, 'user-owned skill');
  const duplicate = run(['install', '--global']);
  assert.equal(duplicate.status, 1); assert.match(duplicate.stderr, /already exists/);
  assert.equal(await readFile(file, 'utf8'), 'user-owned skill');
  assert.deepEqual(await readdir(home), ['.claude']);
  const invalid = run(['status', '--global']);
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /not valid/);
});
