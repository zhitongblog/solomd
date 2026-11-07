import assert from 'node:assert/strict';
import { test } from 'node:test';
import MarkdownIt from 'markdown-it';

import {
  encodeImageDestination,
  extractImageReferenceDefinitions,
  findMarkdownImagesInLine,
  markdownImage,
  parseImageAltSize,
  resizeMarkdownImageLine,
} from './md-image-url.ts';

const md = new MarkdownIt();
const srcOf = (markdown: string): string | null => {
  const m = /<img src="([^"]*)"/.exec(md.render(markdown));
  return m ? m[1] : null;
};
// What image-resolve.ts does with a rendered src: decode exactly once.
const decodeOnce = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

test('the #345 path renders as an image once encoded', () => {
  const path = 'D:/Program Filejs/SoloMD/Image/image-20260924-221953-2pgx69.png';
  assert.equal(srcOf(`![](${path})`), null, 'raw form is literal text — the bug');
  const link = markdownImage(path);
  assert.equal(link, '![](D:/Program%20Filejs/SoloMD/Image/image-20260924-221953-2pgx69.png)');
  const src = srcOf(link);
  assert.ok(src, 'encoded form renders an <img>');
  assert.equal(decodeOnce(src!), path, 'decoding the rendered src gives back the real file');
});

test('paths without problem characters are left readable', () => {
  assert.equal(encodeImageDestination('_assets/image-1.png'), '_assets/image-1.png');
  assert.equal(encodeImageDestination('图片/截图.png'), '图片/截图.png');
  assert.equal(srcOf(markdownImage('图片/截图.png')) !== null, true);
});

test('a note name with spaces (per-file assets folder) round-trips', () => {
  const path = 'My Note.assets/image-2.png';
  const src = srcOf(markdownImage(path));
  assert.ok(src);
  assert.equal(decodeOnce(src!), path);
});

test('parentheses and a literal percent survive the single decode', () => {
  for (const path of ['C:/Users/A B/Pictures (old)/x.png', 'shots/100%.png', 'a/b%20c.png']) {
    const src = srcOf(markdownImage(path));
    assert.ok(src, `renders: ${path}`);
    assert.equal(decodeOnce(src!), path, `round-trips: ${path}`);
  }
});

test('remote URLs keep their encoding; only whitespace is touched', () => {
  assert.equal(encodeImageDestination('https://cdn.example.com/a%2Fb.png'), 'https://cdn.example.com/a%2Fb.png');
  assert.equal(encodeImageDestination('https://cdn.example.com/my shot.png'), 'https://cdn.example.com/my%20shot.png');
  assert.equal(encodeImageDestination('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
});

test('alt text is kept', () => {
  assert.equal(markdownImage('a b.png', 'logo'), '![logo](a%20b.png)');
});

test('#446: parseImageAltSize parses pipe width/height in alt text', () => {
  assert.deepEqual(parseImageAltSize('screenshot|50%'), {
    alt: 'screenshot',
    width: '50%',
    height: null,
  });
  assert.deepEqual(parseImageAltSize('|300'), {
    alt: '',
    width: '300px',
    height: null,
  });
  assert.deepEqual(parseImageAltSize('diagram | 400x250'), {
    alt: 'diagram',
    width: '400px',
    height: '250px',
  });
  assert.deepEqual(parseImageAltSize('plain caption'), {
    alt: 'plain caption',
    width: null,
    height: null,
  });
});

test('#499: height-only pipe size leaves the width automatic', () => {
  assert.deepEqual(parseImageAltSize('screenshot|x250'), {
    alt: 'screenshot',
    width: null,
    height: '250px',
  });
  assert.deepEqual(parseImageAltSize('|x250'), {
    alt: '',
    width: null,
    height: '250px',
  });
  assert.equal(
    resizeMarkdownImageLine('![photo](_assets/a.png)', 'x250'),
    '![photo|x250](_assets/a.png)',
  );
  assert.equal(
    resizeMarkdownImageLine('![photo|300](_assets/a.png)', '450x250'),
    '![photo|450x250](_assets/a.png)',
  );
  assert.equal(
    resizeMarkdownImageLine('<img src="a.png" alt="pic">', 'x250'),
    '<img src="a.png" alt="pic" height="250" style="height: 250px;">',
  );
});

test('#446: resizeMarkdownImageLine updates Markdown and HTML image lines', () => {
  assert.equal(
    resizeMarkdownImageLine('![photo](_assets/a.png)', '50%'),
    '![photo|50%](_assets/a.png)',
  );
  assert.equal(
    resizeMarkdownImageLine('![](_assets/a.png)', '25%'),
    '![|25%](_assets/a.png)',
  );
  assert.equal(
    resizeMarkdownImageLine('![photo|50%](_assets/a.png)', '100%'),
    '![photo](_assets/a.png)',
  );
  assert.equal(
    resizeMarkdownImageLine('<img src="a.png" alt="pic">', '75%'),
    '<img src="a.png" alt="pic" width="75%" style="width: 75%;">',
  );
  assert.equal(
    resizeMarkdownImageLine('<img src="a.png" width="75%" style="width: 75%;">', '100%'),
    '<img src="a.png">',
  );
  // #506 — resize also works on list-item, blockquote, and bracketed-alt images
  assert.equal(
    resizeMarkdownImageLine('- ![[1] photo](https://example.com/a(1).png)', '50%'),
    '- ![[1] photo|50%](https://example.com/a(1).png)',
  );
});

test('#506: findMarkdownImagesInLine parses complex Markdown image forms', () => {
  const refs = extractImageReferenceDefinitions([
    '[fig-1]: https://cdn.example.com/ref.png "Ref Title"',
  ]);
  assert.equal(refs.get('fig-1'), 'https://cdn.example.com/ref.png');

  const cases: Array<[string, string, string]> = [
    ['![alt](https://example.com/a.png)', 'alt', 'https://example.com/a.png'],
    ['- ![list](https://example.com/b.png \'title\')', 'list', 'https://example.com/b.png'],
    ['> ![[图1] 标题](https://example.com/c(1).png)', '[图1] 标题', 'https://example.com/c(1).png'],
    ['[![badge](https://example.com/d.svg)](https://example.com)', 'badge', 'https://example.com/d.svg'],
    ['![angle](<https://example.com/e f.png>)', 'angle', 'https://example.com/e f.png'],
    ['![ref caption][FIG-1]', 'ref caption', 'https://cdn.example.com/ref.png'],
  ];
  for (const [line, expectedAlt, expectedSrc] of cases) {
    const spans = findMarkdownImagesInLine(line, refs);
    assert.equal(spans.length, 1, `should match 1 image in: ${line}`);
    assert.equal(spans[0].alt, expectedAlt);
    assert.equal(spans[0].src, expectedSrc);
  }
  assert.deepEqual(findMarkdownImagesInLine('`![not-an-image](https://example.com/x.png)`'), []);
});

