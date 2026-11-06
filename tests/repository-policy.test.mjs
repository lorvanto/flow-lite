import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isAllowedHttpGitRepository } from '../shared/repository-policy.mjs';
import { validateProject } from '../server/lib/validation.mjs';
import { repositoryCredentialType, matchesRepository } from '../web/src/lib/credentials.js';

const slugs =
  'baking campsite coffee course evse flower manhe milktea studyroom tattoo venue vipcard yanxi yshop yshopbbc'.split(
    ' ',
  );
const project = (repoUrl, extra = {}) => ({
  name: 'HTTP fixture',
  repoUrl,
  buildCredentialId: randomUUID(),
  deploy: { type: 'local', root: '/srv/http-fixture' },
  ...extra,
});

test('only the fifteen exact approved HTTP URLs pass policy, project validation and UI classification', () => {
  for (const slug of slugs) {
    const url = `http://git.yin-duo.com/mini-program/${slug}.git`;
    assert.equal(isAllowedHttpGitRepository(url), true);
    assert.equal(validateProject(project(url), {}).repoUrl, url);
    assert.equal(repositoryCredentialType(url), 'git-https');
    assert.equal(matchesRepository({ type: 'git-https' }, url), true);
    assert.equal(matchesRepository({ type: 'ssh' }, url), false);
  }
});

test('HTTP rejects missing credentials, other hosts/ports/paths, URL secrets, encodings and removed projects', () => {
  const allowed = 'http://git.yin-duo.com/mini-program/baking.git';
  assert.throws(
    () => validateProject(project(allowed, { buildCredentialId: null }), {}),
    /需要选择/,
  );
  for (const url of [
    'http://example.invalid/mini-program/baking.git',
    'http://git.yin-duo.com.evil.invalid/mini-program/baking.git',
    'http://git.yin-duo.com:80/mini-program/baking.git',
    'http://git.yin-duo.com:8080/mini-program/baking.git',
    allowed + '/',
    allowed + '?token=x',
    allowed + '#fragment',
    allowed.replace('http://', 'http://name:password@'),
    allowed.replace('/baking.git', '/%62aking.git'),
    allowed.replace('/mini-program/', '/other/../mini-program/'),
    ...['hanfu', 'huodong', 'travel'].map(
      (slug) => `http://git.yin-duo.com/mini-program/${slug}.git`,
    ),
    ...['yshop', 'yshopbbc'].flatMap((slug) => {
      const url = `http://git.yin-duo.com/mini-program/${slug}.git`;
      return [
        url + '/',
        url + '?token=x',
        url + '#fragment',
        url.replace('git.yin-duo.com', 'git.yin-duo.com:80'),
        url.replace('/mini-program/', '/other/'),
        url.replace(`${slug}.git`, `${slug}-extra.git`),
        url.replace(`${slug}.git`, `%79${slug.slice(1)}.git`),
        url.replace('http://', 'http://name:password@'),
      ];
    }),
  ]) {
    assert.equal(isAllowedHttpGitRepository(url), false);
    assert.throws(() => validateProject(project(url), {}));
    assert.equal(repositoryCredentialType(url), null);
  }
  assert.equal(repositoryCredentialType('https://example.invalid/team/repo.git'), 'git-https');
  assert.equal(repositoryCredentialType('git@example.invalid:team/repo.git'), 'ssh');
  assert.equal(repositoryCredentialType('ssh://git@example.invalid/team/repo.git'), 'ssh');
});
