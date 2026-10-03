const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');

// Exercise the actual native modules resolved by both production workspaces.
// AVIF exercises the bundled HEIF decoder without requiring a HEIC encoder.
for (const workspace of ['api', 'packages/api']) {
  const workspaceRequire = createRequire(path.resolve(__dirname, '..', workspace, 'package.json'));
  const sharp = workspaceRequire('sharp');

  for (const format of ['png', 'jpeg', 'webp', 'avif', 'gif', 'tiff']) {
    test(`${workspace}: ${format} decodes, resizes and converts to PNG`, async () => {
      const encoded = await sharp({
        create: { width: 32, height: 24, channels: 3, background: '#3182ce' },
      })
        .toFormat(format)
        .toBuffer();
      const input = await sharp(encoded).metadata();
      assert.equal(input.width, 32);
      assert.equal(input.height, 24);

      const resized = await sharp(encoded).resize(16, 12).png().toBuffer();
      const output = await sharp(resized).metadata();
      assert.equal(output.format, 'png');
      assert.equal(output.width, 16);
      assert.equal(output.height, 12);
    });
  }

  test(`${workspace}: malformed image rejects without producing output`, async () => {
    await assert.rejects(sharp(Buffer.from('not an image')).resize(16).png().toBuffer());
  });
}
