import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyVimrcMappings, parseVimrcMappings } from './vimrc.ts';

test('#492: parseVimrcMappings parses inoremap, nnoremap, vnoremap, and ignores comments', () => {
  const input = `
    " Exit insert mode with jj
    inoremap jj <Esc>
    # Line start/end shortcuts
    nnoremap H ^
    nnoremap L $
    vnoremap J :m '>+1<CR>gv=gv
    map <Space> :
  `;
  const parsed = parseVimrcMappings(input);
  assert.deepEqual(parsed, [
    { recursive: false, lhs: 'jj', rhs: '<Esc>', context: 'insert' },
    { recursive: false, lhs: 'H', rhs: '^', context: 'normal' },
    { recursive: false, lhs: 'L', rhs: '$', context: 'normal' },
    { recursive: false, lhs: 'J', rhs: ":m '>+1<CR>gv=gv", context: 'visual' },
    { recursive: true, lhs: '<Space>', rhs: ':' },
  ]);
});

test('#492: applyVimrcMappings invokes map/noremap and unmaps previous custom entries on update', () => {
  const calls: string[] = [];
  const fakeVim = {
    map(lhs: string, rhs: string, ctx?: string) {
      calls.push(`map:${lhs}->${rhs}@${ctx ?? 'all'}`);
    },
    noremap(lhs: string, rhs: string, ctx?: string) {
      calls.push(`noremap:${lhs}->${rhs}@${ctx ?? 'all'}`);
    },
    unmap(lhs: string, ctx?: string) {
      calls.push(`unmap:${lhs}@${ctx ?? 'all'}`);
    },
  };

  assert.equal(applyVimrcMappings('inoremap jj <Esc>\nnnoremap H ^', fakeVim), 2);
  assert.deepEqual(calls, ['noremap:jj-><Esc>@insert', 'noremap:H->^@normal']);

  calls.length = 0;
  assert.equal(applyVimrcMappings('inoremap jk <Esc>', fakeVim), 1);
  assert.deepEqual(calls, [
    'unmap:H@normal',
    'unmap:jj@insert',
    'noremap:jk-><Esc>@insert',
  ]);
});
