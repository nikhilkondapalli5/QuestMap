const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildGroundingContext,
    scoreSourceTrust,
    validatePracticeJson,
    validateQuizJson,
} = require('../groundingService');

test('buildGroundingContext extracts source-backed facts from uploaded source material', () => {
    const grounding = buildGroundingContext({
        topic: 'photosynthesis',
        nodeLabel: 'light reactions',
        sourceMaterials: [{
            filename: 'biology-notes.txt',
            content: 'Photosynthesis converts light energy into chemical energy. The light reactions produce ATP and NADPH in the thylakoid membrane.',
        }],
    });

    assert.equal(grounding.sources[0].access_mode, 'full_text_allowed');
    assert.ok(grounding.facts.length >= 1);
    assert.equal(grounding.coverage.fact_count, grounding.facts.length);
});

test('validatePracticeJson strips unsupported fact ids and downgrades ungrounded scenarios', () => {
    const grounding = buildGroundingContext({
        topic: 'gravity',
        nodeLabel: 'orbits',
        sourceMaterials: [{
            filename: 'physics.txt',
            content: 'Objects in orbit are continuously falling around the body they orbit because gravity provides centripetal acceleration.',
        }],
    });

    const validated = validatePracticeJson({
        scenarios: [{
            id: 1,
            type: 'multiple_choice',
            question: 'What keeps an orbiting object moving around a planet?',
            source_fact_ids: ['fake_fact'],
        }],
    }, grounding);

    assert.deepEqual(validated.scenarios[0].source_fact_ids, []);
    assert.equal(validated.scenarios[0].validation_status, 'needs_source_review');
    assert.equal(validated.scenarios[0].confidence, 'low');
});

test('validateQuizJson annotates quiz levels with grounding metadata', () => {
    const grounding = buildGroundingContext({
        topic: 'evolution',
        nodeLabel: 'natural selection',
        sourceMaterials: [{
            filename: 'evolution.txt',
            content: 'Natural selection changes trait frequencies when heritable variation affects survival or reproduction.',
        }],
    });

    const factId = grounding.facts[0]?.fact_id;
    const validated = validateQuizJson({
        levels: [{
            level_number: 1,
            question: 'What must affect survival or reproduction?',
            source_fact_ids: [factId],
        }],
    }, grounding);

    assert.equal(validated.levels[0].validation_status, 'source_supported');
    assert.deepEqual(validated.levels[0].source_fact_ids, [factId]);
});

test('scoreSourceTrust ranks official/academic domains above blogs', () => {
    const official = scoreSourceTrust({ domain: 'docs.python.org', title: 'Python docs', url: 'https://docs.python.org/3/' });
    const blog = scoreSourceTrust({ domain: 'medium.com', title: 'Some blog', url: 'https://medium.com/post' });

    assert.ok(official.trust_score > blog.trust_score);
    assert.equal(official.trust_tier, 'authoritative_metadata');
});
