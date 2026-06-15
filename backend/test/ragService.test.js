const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkText } = require('../ragService');

test('chunkText creates overlapping chunks for long source text', () => {
    const text = Array.from({ length: 260 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkText(text, 100, 20);

    assert.ok(chunks.length >= 3);
    assert.ok(chunks[0].includes('word0'));
    assert.ok(chunks[1].includes('word80'));
});

test('chunkText filters citation-heavy bibliography fragments', () => {
    const text = '[1] https://example.com [2] doi:10.1234/test [3] Vol. 4 pp. 12-18 [4] https://example.org';
    const chunks = chunkText(text, 50, 10);

    assert.deepEqual(chunks, []);
});
