import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  contentTypeFor, readStaticAsset, readThreadBoardShell, resolveStaticRoot, StaticAssetError,
} from './staticAssets.js';

describe('contentTypeFor', () => {
  it('maps known extensions and falls back to octet-stream', () => {
    expect(contentTypeFor('app.html')).toContain('text/html');
    expect(contentTypeFor('x/y/tokens.css')).toContain('text/css');
    expect(contentTypeFor('main.mjs')).toContain('text/javascript');
    expect(contentTypeFor('logo.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('unknown.bin')).toBe('application/octet-stream');
    expect(contentTypeFor('no-extension')).toBe('application/octet-stream');
  });
});

describe('resolveStaticRoot', () => {
  it('finds the source web/static directory in a dev checkout', () => {
    // This repo has web/static committed, so resolution must succeed.
    expect(resolveStaticRoot()).toBeTruthy();
  });

  it('ships the durable repository thread shell', async () => {
    expect((await readThreadBoardShell())?.toString()).toContain('REPOSITORY THREADS');
  });
});

describe('readStaticAsset', () => {
  it('serves a real asset with its content type', async () => {
    const asset = await readStaticAsset('/static/css/tokens.css');
    expect(asset.contentType).toContain('text/css');
    expect(asset.body.toString()).toContain('--bg');
  });

  it('404s on a missing file', async () => {
    await expect(readStaticAsset('/static/nope.css')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses path traversal out of the static root', async () => {
    await expect(readStaticAsset('/static/../../package.json')).rejects.toBeInstanceOf(StaticAssetError);
    await expect(readStaticAsset('/static/../../package.json')).rejects.toMatchObject({
      statusCode: expect.any(Number),
    });
    // Whatever the exact code, the file content must never be readable.
    await expect(readStaticAsset('/static/..%2f..%2fpackage.json')).rejects.toBeInstanceOf(StaticAssetError);
  });

  it('refuses a symlink that escapes the static root', async () => {
    const root = resolveStaticRoot();
    expect(root).toBeTruthy();
    const escapeDir = mkdtempSync(join(tmpdir(), 'osw-static-escape-'));
    const outside = join(escapeDir, 'secret.txt');
    writeFileSync(outside, 'outside-content');
    const linkPath = join(root!, 'escape-link.txt');
    try {
      symlinkSync(outside, linkPath);
      await expect(readStaticAsset('/static/escape-link.txt')).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      rmSync(linkPath, { force: true });
      rmSync(escapeDir, { recursive: true, force: true });
    }
  });

  it('rejects null bytes', async () => {
    await expect(readStaticAsset('/static/a%00b')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('serves nested paths normally', async () => {
    const dir = mkdirSync; // reference to satisfy import usage in edge builds
    void dir;
    const asset = await readStaticAsset('/static/js/main.mjs');
    expect(asset.contentType).toContain('text/javascript');
  });
});
