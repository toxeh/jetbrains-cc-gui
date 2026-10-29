import {
  applyTranslation,
  isLocalCommandDraft,
  isReplyTranslatable,
  maskDraft,
  maskMarkdown,
  restoreMarkdown,
  sha256Hex,
} from './localTranslate.js';

function fileChip(path: string): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = 'file-tag has-tooltip';
  chip.setAttribute('contenteditable', 'false');
  chip.setAttribute('data-file-path', path);
  chip.innerHTML = `<span class="file-tag-icon"></span><span class="file-tag-text">${path.split('/').pop()}</span><span class="file-tag-close">&times;</span>`;
  return chip;
}

function quoteChip(id: string): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = 'quote-tag';
  chip.setAttribute('contenteditable', 'false');
  chip.setAttribute('data-quote-id', id);
  chip.innerHTML = '<span class="quote-tag-preview">quoted text</span><span class="quote-tag-close">&times;</span>';
  return chip;
}

/** Editor with: prose, file chip, inline code, newline, quote chip, fenced block. */
function buildFixture() {
  const editable = document.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  const file = fileChip('src/Foo.java');
  const quote = quoteChip('q1');
  editable.append(
    document.createTextNode('Почини '),
    file,
    document.createTextNode(' и вызови `run()` тут'),
    document.createElement('br'),
    document.createTextNode('см. '),
    quote,
    document.createElement('br'),
    document.createTextNode('```java\nint x = 1;\n```'),
  );
  document.body.appendChild(editable);
  return { editable, file, quote };
}

describe('maskDraft', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('masks chips on the DOM walk and code spans in the text', () => {
    const { editable } = buildFixture();
    const masked = maskDraft(editable);

    expect(masked.text).toBe('Почини ⟦LTc0⟧ и вызови ⟦LTk0⟧ тут\nсм. ⟦LTc1⟧\n⟦LTk1⟧');
    expect(masked.code.get('k0')).toBe('`run()`');
    expect(masked.code.get('k1')).toBe('```java\nint x = 1;\n```');
    expect(masked.chips.size).toBe(2);
    expect(masked.hasProse).toBe(true);
    // Chips are not serialized as @path or quote tokens for the model.
    expect(masked.text).not.toContain('@src/Foo.java');
    expect(masked.text).not.toMatch(/[\uE000\uE001]/);
  });

  it('keeps a typed @path as prose instead of treating it as a chip', () => {
    const editable = document.createElement('div');
    editable.textContent = 'open @src/Foo.java please';
    const masked = maskDraft(editable);
    expect(masked.text).toBe('open @src/Foo.java please');
    expect(masked.chips.size).toBe(0);
  });

  it('reports no prose for a draft of only chips and code', () => {
    const editable = document.createElement('div');
    editable.append(fileChip('a/B.kt'), document.createTextNode(' `x` \n```\ncode\n```'));
    expect(maskDraft(editable).hasProse).toBe(false);
  });
});

describe('applyTranslation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('restores code verbatim and moves the same chip nodes back', () => {
    const { editable, file, quote } = buildFixture();
    const masked = maskDraft(editable);

    const result = applyTranslation(
      editable,
      masked,
      'Fix ⟦LTc0⟧ and call ⟦LTk0⟧ here\nsee ⟦LTc1⟧\n⟦LTk1⟧',
    );

    expect(result.ok).toBe(true);
    const chips = editable.querySelectorAll('.file-tag, .quote-tag');
    expect(chips[0]).toBe(file);
    expect(chips[1]).toBe(quote);
    expect(editable.textContent).toContain('call `run()` here');
    expect(editable.textContent).toContain('```java');
    expect(editable.textContent).toContain('int x = 1;');
    // Newlines are <br>, not text "\n" outside the restored fenced block.
    expect(editable.querySelectorAll('br').length).toBeGreaterThanOrEqual(2);
    expect(Array.from(editable.childNodes).some((n) => n.nodeName === 'BR')).toBe(true);
    // A fresh mask of the result round-trips to the same placeholders.
    expect(maskDraft(editable).text).toBe('Fix ⟦LTc0⟧ and call ⟦LTk0⟧ here\nsee ⟦LTc1⟧\n⟦LTk1⟧');
  });

  it('leaves the DOM untouched when the model drops ⟦LTc0⟧', () => {
    const { editable, file } = buildFixture();
    const before = editable.innerHTML;
    const childrenBefore = Array.from(editable.childNodes);
    const masked = maskDraft(editable);

    const result = applyTranslation(editable, masked, 'Fix and call ⟦LTk0⟧ here\nsee ⟦LTc1⟧\n⟦LTk1⟧');

    expect(result).toEqual({ ok: false, reason: 'placeholder' });
    expect(editable.innerHTML).toBe(before);
    expect(Array.from(editable.childNodes)).toEqual(childrenBefore);
    expect(file.parentNode).toBe(editable);
  });

  it('rejects a duplicated or invented placeholder', () => {
    const { editable } = buildFixture();
    const before = editable.innerHTML;
    const masked = maskDraft(editable);

    expect(applyTranslation(editable, masked, '⟦LTc0⟧ ⟦LTc0⟧ ⟦LTk0⟧ ⟦LTc1⟧ ⟦LTk1⟧').ok).toBe(false);
    expect(applyTranslation(editable, masked, '⟦LTc0⟧ ⟦LTk0⟧ ⟦LTc1⟧ ⟦LTk1⟧ ⟦LTk7⟧').ok).toBe(false);
    expect(applyTranslation(editable, masked, '⟦LTc0⟧ ⟦LTk0⟧ ⟦LTc1⟧').ok).toBe(false);
    expect(editable.innerHTML).toBe(before);
  });

  it('replaces a chip-free draft with text and <br> lines', () => {
    const editable = document.createElement('div');
    editable.textContent = 'привет\nмир';
    const masked = maskDraft(editable);
    const result = applyTranslation(editable, masked, 'hello\nworld');
    expect(result).toEqual({ ok: true, text: 'hello\nworld' });
    expect(editable.innerHTML).toBe('hello<br>world');
  });

  it('normalizes \\r\\n and bare \\r line endings to single line breaks', () => {
    const editable = document.createElement('div');
    editable.textContent = 'один\nдва\nтри';
    const masked = maskDraft(editable);
    const result = applyTranslation(editable, masked, 'one\r\ntwo\rthree');
    expect(result).toEqual({ ok: true, text: 'one\ntwo\nthree' });
    expect(editable.innerHTML).toBe('one<br>two<br>three');
  });

  it('turns div and p line breaks into newlines and restores the same chip', () => {
    const editable = document.createElement('div');
    const chip = fileChip('src/Foo.java');
    const first = document.createElement('div');
    first.textContent = 'Почини';
    const second = document.createElement('p');
    second.append(document.createTextNode('это '), chip);
    editable.append(first, second);
    document.body.appendChild(editable);

    const masked = maskDraft(editable);
    expect(masked.text).toBe('Почини\nэто ⟦LTc0⟧');
    expect(masked.chips.get('c0')).toBe(chip);

    const result = applyTranslation(editable, masked, 'Fix\nthis ⟦LTc0⟧');
    expect(result.ok).toBe(true);
    expect(editable.querySelector('.file-tag')).toBe(chip);
    expect(editable.textContent).toContain('Fix');
    expect(editable.textContent).toContain('this');
  });

  it('accepts a translation whose restored code contains a chip placeholder', () => {
    const editable = document.createElement('div');
    editable.textContent = 'see `⟦LTc0⟧`';
    document.body.appendChild(editable);

    const masked = maskDraft(editable);
    expect(masked.text).toBe('see ⟦LTk0⟧');
    expect(masked.code.get('k0')).toBe('`⟦LTc0⟧`');
    expect(masked.chips.size).toBe(0);

    const result = applyTranslation(editable, masked, 'see ⟦LTk0⟧');
    expect(result).toEqual({ ok: true, text: 'see `⟦LTc0⟧`' });
    expect(editable.textContent).toContain('⟦LTc0⟧');
  });
});

describe('isLocalCommandDraft', () => {
  it.each([
    '/clear',
    '/new',
    '/reset',
    '/resume',
    '/continue',
    '/plan',
    '/plan do it',
    '/context',
    '/plugin',
    '/plugins',
    '/compact',
    '/review',
    '/diff',
    '/approvals',
    '/init',
    '/explain this',
    '  /clear  ',
  ])('treats %s as a slash command draft across providers', (text) => {
    expect(isLocalCommandDraft(text)).toBe(true);
    expect(isLocalCommandDraft(text, 'claude')).toBe(true);
    expect(isLocalCommandDraft(text, 'codex')).toBe(true);
    expect(isLocalCommandDraft(text, 'gemini')).toBe(true);
  });

  it.each(['fix /clear handling', 'привет', '/'])('does not treat %s as a local command', (text) => {
    expect(isLocalCommandDraft(text)).toBe(false);
  });
});

describe('maskMarkdown and restoreMarkdown', () => {
  it('masks code spans with LTk placeholders and preserves order', () => {
    const text = 'Here is `inline code` and a block:\n```python\nprint("hello")\n```\nDone.';
    const masked = maskMarkdown(text);
    expect(masked.text).toBe('Here is ⟦LTk0⟧ and a block:\n⟦LTk1⟧\nDone.');
    expect(masked.code.get('k0')).toBe('`inline code`');
    expect(masked.code.get('k1')).toBe('```python\nprint("hello")\n```');
    expect(masked.hasProse).toBe(true);

    const restored = restoreMarkdown('Вот ⟦LTk0⟧ и блок:\n⟦LTk1⟧\nГотово.', masked.code);
    expect(restored).toEqual({
      ok: true,
      text: 'Вот `inline code` и блок:\n```python\nprint("hello")\n```\nГотово.',
    });
  });

  it('reports hasProse=false when only code or whitespace exists', () => {
    expect(maskMarkdown('```ts\nconsole.log(1);\n```').hasProse).toBe(false);
    expect(maskMarkdown('`code only`').hasProse).toBe(false);
    expect(maskMarkdown('   \n\t  ').hasProse).toBe(false);
  });

  it('rejects restoration when a placeholder is dropped, duplicated, or invented', () => {
    const masked = maskMarkdown('Call `run()` and `stop()`');
    expect(restoreMarkdown('Вызови ⟦LTk0⟧', masked.code)).toEqual({ ok: false, reason: 'placeholder' });
    expect(restoreMarkdown('Вызови ⟦LTk0⟧ и ⟦LTk0⟧', masked.code)).toEqual({ ok: false, reason: 'placeholder' });
    expect(restoreMarkdown('Вызови ⟦LTk0⟧, ⟦LTk1⟧ и ⟦LTk2⟧', masked.code)).toEqual({ ok: false, reason: 'placeholder' });
    expect(restoreMarkdown('Вызови ⟦LTc0⟧', masked.code)).toEqual({ ok: false, reason: 'placeholder' });
  });
});

describe('isReplyTranslatable', () => {
  it('rejects a code-only block', () => {
    expect(isReplyTranslatable('```typescript\nconst x = 1;\n```')).toBe(false);
    expect(isReplyTranslatable('`someCode()`')).toBe(false);
  });

  it('rejects an empty or whitespace-only block', () => {
    expect(isReplyTranslatable('')).toBe(false);
    expect(isReplyTranslatable('   \n\t  ')).toBe(false);
  });

  it('rejects a block with no letters', () => {
    expect(isReplyTranslatable('12345 67890 !?@#$%^&*()_+-=[]{}|;:,.<>')).toBe(false);
  });

  it('rejects a mostly Cyrillic block', () => {
    expect(isReplyTranslatable('Привет, как твои дела? I am good.')).toBe(false);
    expect(isReplyTranslatable('Только русский текст')).toBe(false);
  });

  it('accepts an English block with fenced code', () => {
    expect(isReplyTranslatable('Here is the solution:\n```python\nprint("hi")\n```\nLet me know if you need more.')).toBe(true);
  });

  it('accepts an English block with an inline span', () => {
    expect(isReplyTranslatable('You can call `getUser()` to fetch data.')).toBe(true);
  });

  it('accepts a mixed English block that contains Cyrillic identifiers', () => {
    expect(isReplyTranslatable('You should rename the function `тестоваяФункция` to `runTests` in the module.')).toBe(true);
  });
});

describe('sha256Hex', () => {
  it('computes expected lowercase hex SHA-256 digests', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(sha256Hex('Hello world')).toBe('64ec88ca00b268e5ba1a35678a1b5316d212f4f366b2477232534a8aeca37f3c');
  });
});

