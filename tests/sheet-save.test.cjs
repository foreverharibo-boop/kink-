const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../index.js'), 'utf8');
function runtime() {
    const ctx = vm.createContext({ console, jQuery() {}, window: {}, setTimeout, structuredClone });
    vm.runInContext(source, ctx);
    return ctx;
}
const ctx = runtime();
const plan = (description, kink = 'New preference.', extra = {}) => ctx.planSheetKink({ description, ...extra }, kink);

test('new section, empty sheet, and unchanged original content', () => {
    for (const text of ['', '# Profile\nOriginal personality.']) {
        const result = plan(text);
        assert.ok(result.value.startsWith(text));
        assert.match(result.value, /## Sexuality & Kink\n- Kink: New preference\./);
    }
});

test('Markdown sexual section ends before next peer heading', () => {
    const text = '# Profile\nOriginal\n## Sexual Preferences\nExisting\n\n## History\nKeep me';
    const result = plan(text);
    assert.ok(result.value.indexOf('- Kink:') < result.value.indexOf('## History'));
    assert.ok(result.value.includes('## History\nKeep me'));
    assert.equal(result.value.replace('- Kink: New preference.\n', ''), text);
});

test('Korean bold titles and field labels', () => {
    for (const title of ['**성적 취향**', '[성생활]', '성적 특징:', '- **Sexuality:** existing']) {
        const result = plan(`${title}\nExisting\n**배경**\nKeep`);
        if (title === '[성생활]') assert.equal(result.category, '성생활');
        assert.ok(!result.value.includes('## Sexuality & Kink'));
        assert.ok(result.value.indexOf('- Kink:') < result.value.indexOf('**배경**'));
    }
});

test('existing Kink field is extended without duplicating its label', () => {
    const text = '## Sexuality\n- Kink: Original.\n- Limits: Unchanged\n## History\nKeep';
    const first = plan(text);
    assert.ok(first.value.includes('- Kink: Original.; New preference.'));
    assert.equal((first.value.match(/Kink:/g) || []).length, 1);
    assert.equal(plan(first.value).duplicate, true);
});

test('existing Kink heading and nested XML Kink are reused', () => {
    for (const text of ['## Sexuality\n### Kinks\n- Original\n## History\nKeep', '<sexuality><kinks>Original</kinks></sexuality>']) {
        const result = plan(text);
        assert.ok(!result.value.includes('Kink:'));
        assert.ok(result.value.includes('- New preference.'));
        assert.ok(!result.value.includes('## Sexuality & Kink'));
    }
});

test('XML section and Markdown inside outer XML stay inside their closing tags', () => {
    for (const text of ['<sexuality>Original</sexuality>\n<history>Keep</history>', '<character>\n## Sexuality\nOriginal\n</character>']) {
        const result = plan(text);
        assert.ok(result.value.indexOf('- Kink:') < result.value.indexOf('</'));
    }
});

test('same words inside narrative and code do not select a section', () => {
    const result = plan('## History\nHe discussed sexual preferences.\n```\n## Sexuality\n```');
    assert.ok(result.value.endsWith('## Sexuality & Kink\n- Kink: New preference.\n'));
});

test('personality sexual section is used instead of adding to description', () => {
    const result = plan('Original description', undefined, { personality: '## 성적 성향\nOriginal' });
    assert.equal(result.field, 'personality');
    assert.equal(result.before, '## 성적 성향\nOriginal');
});

test('duplicate checks span fields and normalize whitespace/case', () => {
    assert.equal(plan('Keep', 'New preference.', { personality: 'NEW\n preference.' }).duplicate, true);
});

test('CRLF and trailing content remain intact', () => {
    const text = '## Sexuality\r\nOriginal\r\n\r\n## History\r\nKeep';
    const result = plan(text);
    assert.equal(result.value.replace('- Kink: New preference.\r\n', ''), text);
    assert.ok(!/(?<!\r)\n/.test(result.value));
});

test('empty translation cannot save', () => {
    assert.throws(() => plan('Keep', ''), /비어/);
});

function saveRuntime({ rejectSave = false, duplicate = false, switchCharacter = false } = {}) {
    const ctx = runtime();
    const cards = [{ avatar: 'a.png', name: 'A', description: 'Original', data: { description: 'Original' } }, { avatar: 'b.png', name: 'B', description: 'Other' }];
    const context = { characters: cards, characterId: undefined };
    const calls = [], notices = [];
    const button = { label: 'Add', text(value) { if (value === undefined) return this.label; this.label = value; return this; } };
    ctx.$ = () => ({ length: 0, prop() { return this; }, val() {} });
    ctx.window.toastr = { success: x => notices.push(['success', x]), error: x => notices.push(['error', x]), info: x => notices.push(['info', x]) };
    ctx.fakeContext = context;
    ctx.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push({ url, body, headers: options.headers });
        if (url.endsWith('/get')) {
            if (switchCharacter) vm.runInContext('selectedCharIndex = 1', ctx);
            return { ok: true, json: async () => ({ name: 'A', description: duplicate ? 'New preference.' : 'Original' }) };
        }
        return { ok: !rejectSave, status: rejectSave ? 500 : 200 };
    };
    vm.runInContext(`getContext = () => fakeContext; getRequestHeaders = () => ({'X-CSRF-Token': 'test'});
        selectedCharIndex = 0; extension_settings = {'kink-extractor': {perCharacter: {'a.png': {isAdultConfirmed: true, items: [{kink: 'New preference.'}]}}}};`, ctx);
    return { ctx, cards, calls, notices, button };
}

test('save targets stable avatar after selection changes and uses CSRF headers', async () => {
    const r = saveRuntime({ switchCharacter: true });
    await r.ctx.addItemToCharacterSheet(0, r.button, 'original');
    assert.equal(r.calls.length, 2);
    assert.equal(r.calls[1].body.avatar_url, 'a.png');
    assert.equal(r.calls[1].body.field, 'description');
    assert.equal(r.calls[1].headers['X-CSRF-Token'], 'test');
    assert.ok(r.cards[0].description.includes('New preference.'));
    assert.equal(r.cards[1].description, 'Other');
    assert.equal(r.notices[0][0], 'success');
});

test('failed writes leave local card unchanged and unlock retry', async () => {
    const r = saveRuntime({ rejectSave: true });
    await r.ctx.addItemToCharacterSheet(0, r.button, 'original');
    assert.equal(r.cards[0].description, 'Original');
    assert.equal(r.notices[0][0], 'error');
    assert.equal(vm.runInContext('sheetSaves.size', r.ctx), 0);
});

test('duplicate does not send a write request', async () => {
    const r = saveRuntime({ duplicate: true });
    await r.ctx.addItemToCharacterSheet(0, r.button, 'original');
    assert.equal(r.calls.length, 1);
    assert.equal(r.notices[0][0], 'info');
});
