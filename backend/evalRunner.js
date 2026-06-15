require('dotenv').config();

const mongoose = require('mongoose');
const EVAL_SCENARIOS = require('./evalScenarios');
const MasteryRecord = require('./models/MasteryRecord');

const DEFAULT_BASE_URL = 'http://127.0.0.1:5001';
const BASE_URL = (process.env.EVAL_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
const RUN_LIVE_LLM_EVALS = process.env.RUN_LIVE_LLM_EVALS === 'true';
const DEFAULT_TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS || 20000);

function scenario(id) {
    const item = EVAL_SCENARIOS.find(candidate => candidate.id === id);
    if (!item) throw new Error(`Missing eval scenario: ${id}`);
    return item;
}

function assertEval(condition, message) {
    if (!condition) throw new Error(message);
}

function stableEvalUserId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function requestJson(path, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(`${BASE_URL}${path}`, {
            method,
            headers: {
                Accept: 'application/json',
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });

        const text = await response.text();
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            json = null;
        }

        return {
            ok: response.ok,
            status: response.status,
            json,
            text,
        };
    } finally {
        clearTimeout(timeout);
    }
}

async function cleanupMasteryRecords(userId) {
    if (!process.env.MONGODB_URI) return { skipped: true, reason: 'MONGODB_URI is not set' };

    const wasConnected = mongoose.connection.readyState === 1;
    if (!wasConnected) {
        await mongoose.connect(process.env.MONGODB_URI);
    }

    const result = await MasteryRecord.deleteMany({ userId });
    if (!wasConnected) {
        await mongoose.disconnect();
    }

    return { deletedCount: result.deletedCount || 0 };
}

async function runCase(id, fn) {
    const metadata = scenario(id);
    const startedAt = Date.now();

    try {
        const details = await fn(metadata);
        return {
            id,
            mode: metadata.mode || 'default',
            endpoint: metadata.endpoint,
            status: 'passed',
            durationMs: Date.now() - startedAt,
            details,
        };
    } catch (err) {
        return {
            id,
            mode: metadata.mode || 'default',
            endpoint: metadata.endpoint,
            status: 'failed',
            durationMs: Date.now() - startedAt,
            error: err.message,
        };
    }
}

function skippedCase(id, reason) {
    const metadata = scenario(id);
    return {
        id,
        mode: metadata.mode || 'default',
        endpoint: metadata.endpoint,
        status: 'skipped',
        durationMs: 0,
        reason,
    };
}

async function evalScenarioCatalog() {
    const response = await requestJson('/api/eval-scenarios');
    assertEval(response.ok, `Expected 200, got ${response.status}: ${response.text}`);
    assertEval(Array.isArray(response.json?.scenarios), 'Response did not include scenarios array');

    const returnedIds = response.json.scenarios.map(item => item.id);
    const missingIds = EVAL_SCENARIOS
        .map(item => item.id)
        .filter(id => !returnedIds.includes(id));
    assertEval(missingIds.length === 0, `Scenario API is missing ids: ${missingIds.join(', ')}`);

    return {
        scenarioCount: response.json.scenarios.length,
        ids: returnedIds,
    };
}

async function evalBlockedUrl() {
    const response = await requestJson('/api/ingest-url', {
        method: 'POST',
        body: {
            userId: stableEvalUserId('eval-blocked-url'),
            url: 'http://127.0.0.1:9/private-source',
            category: 'source',
        },
    });

    assertEval(
        [400, 403].includes(response.status),
        `Expected private URL to be rejected with 400/403, got ${response.status}: ${response.text}`,
    );
    assertEval(!response.json?.document, 'Blocked URL response should not include an ingested document');

    return {
        rejectedStatus: response.status,
        error: response.json?.error || null,
    };
}

async function evalMasteryRemediation() {
    const userId = stableEvalUserId('eval-mastery');
    let cleanup = null;

    try {
        const response = await requestJson('/api/mastery/attempt', {
            method: 'POST',
            body: {
                userId,
                topic: 'Dinosaur extinction theories',
                nodeLabel: 'Chicxulub impact evidence',
                activityType: 'practice',
                itemId: 'eval-mastery-remediation-1',
                itemType: 'short_answer',
                question: 'What evidence links the Chicxulub crater to the K-Pg extinction?',
                selectedAnswer: 'Volcanoes alone explain it.',
                correctAnswer: 'The crater, shocked quartz, iridium layer, and ejecta timing support impact causality.',
                isCorrect: false,
                concepts: ['Chicxulub crater', 'iridium layer'],
                confidence: 'medium',
                validationStatus: 'source_supported',
            },
        });

        assertEval(response.ok, `Expected 200, got ${response.status}: ${response.text}`);
        assertEval(response.json?.saved === true, 'Mastery attempt was not persisted');
        assertEval(response.json?.remediation?.status === 'active', 'Missed attempt did not create active remediation');
        assertEval(
            response.json.remediation.focus_concepts?.includes('Chicxulub crater'),
            'Remediation did not focus on the missed concept',
        );
        assertEval(
            Array.isArray(response.json?.mastery_summary?.weak_concepts)
            && response.json.mastery_summary.weak_concepts.length > 0,
            'Mastery summary did not report weak concepts',
        );

        cleanup = await cleanupMasteryRecords(userId);

        return {
            recordId: response.json.record_id,
            remediationTitle: response.json.remediation.title,
            weakConcepts: response.json.mastery_summary.weak_concepts,
            cleanup,
        };
    } catch (err) {
        try {
            cleanup = await cleanupMasteryRecords(userId);
        } catch (cleanupErr) {
            err.message = `${err.message}; cleanup failed: ${cleanupErr.message}`;
        }
        throw err;
    }
}

async function evalBroadTopicMap() {
    const response = await requestJson('/api/generate-map', {
        method: 'POST',
        timeoutMs: Number(process.env.EVAL_LIVE_TIMEOUT_MS || 120000),
        body: {
            userId: stableEvalUserId('eval-live-map'),
            topic: 'Machine Learning',
            skill_level: 'beginner',
            background: 'General software learner',
            goals: 'Build a grounded curriculum without overfitting to a narrow source',
            learning_history: [],
        },
    });

    assertEval(response.ok, `Expected 200, got ${response.status}: ${response.text}`);
    const nodes = response.json?.map?.nodes || response.json?.nodes || [];
    assertEval(Array.isArray(nodes) && nodes.length >= 6, 'Generated map did not include at least 6 nodes');

    const labelText = nodes
        .map(node => `${node.label || ''} ${node.title || ''}`)
        .join(' ')
        .toLowerCase();
    const foundationalHits = ['supervised', 'unsupervised', 'model', 'evaluation', 'features']
        .filter(term => labelText.includes(term));
    assertEval(
        foundationalHits.length >= 2,
        `Map did not show enough foundational ML coverage. Matched: ${foundationalHits.join(', ') || 'none'}`,
    );

    return {
        nodeCount: nodes.length,
        foundationalHits,
    };
}

async function evalNicheNodeGrounding() {
    const response = await requestJson('/api/generate-node-data', {
        method: 'POST',
        timeoutMs: Number(process.env.EVAL_LIVE_TIMEOUT_MS || 120000),
        body: {
            userId: stableEvalUserId('eval-live-node'),
            topic: 'Fermi paradox rare solutions',
            node_label: 'Rare Fermi Paradox Hypotheses',
            skill_level: 'beginner',
            key_concepts: ['Great Filter', 'dark forest hypothesis', 'grabby aliens'],
        },
    });

    assertEval(response.ok, `Expected 200, got ${response.status}: ${response.text}`);
    const practicePayload = response.json?.practice || response.json || {};
    const practiceItems = practicePayload.scenarios || practicePayload.items || [];
    assertEval(Array.isArray(practiceItems) && practiceItems.length > 0, 'Node data did not include practice items');

    const validationStatuses = practiceItems
        .map(item => item.validation_status)
        .filter(Boolean);
    const sourceIds = practiceItems.flatMap(item => item.source_fact_ids || []);
    const hasGroundingSummary = Boolean(practicePayload.grounding_summary || response.json?.grounding_summary);

    assertEval(
        hasGroundingSummary || validationStatuses.length > 0,
        'Practice output did not expose grounding status or grounding summary',
    );
    assertEval(
        sourceIds.length > 0 || validationStatuses.some(status => status !== 'source_supported'),
        'Sparse-source practice should either cite source facts or mark items as not source-supported',
    );

    return {
        practiceItemCount: practiceItems.length,
        validationStatuses: [...new Set(validationStatuses)],
        sourceFactReferenceCount: sourceIds.length,
    };
}

async function evalRepoConceptLearningPath() {
    const response = await requestJson('/api/repo/analyze', {
        method: 'POST',
        timeoutMs: Number(process.env.EVAL_LIVE_TIMEOUT_MS || 120000),
        body: {
            userId: stableEvalUserId('eval-live-repo'),
            repoUrl: process.env.EVAL_REPO_URL || 'https://github.com/openai/openai-node',
            skillLevel: 'beginner',
        },
    });

    assertEval(response.ok, `Expected 200, got ${response.status}: ${response.text}`);
    const concepts = response.json?.analysis?.concepts || [];
    const path = response.json?.analysis?.learning_path || [];
    const evidenceIds = new Set((response.json?.evidence || []).map(item => item.id));

    assertEval(concepts.length >= 3, `Expected at least 3 repo concepts, got ${concepts.length}`);
    assertEval(path.length >= 3, `Expected at least 3 learning path steps, got ${path.length}`);
    assertEval(
        concepts.every(concept => Array.isArray(concept.evidence_ids) && concept.evidence_ids.some(id => evidenceIds.has(id))),
        'Every repo concept should cite at least one returned evidence id',
    );
    assertEval(
        path.every((step, index) => Number(step.order) === index + 1),
        'Learning path order should be normalized and sequential',
    );

    return {
        repo: response.json.repo?.fullName,
        conceptCount: concepts.length,
        pathStepCount: path.length,
        transient: response.json.transient,
    };
}

async function runEndpointEval() {
    const results = [];

    results.push(await runCase('eval-scenarios-api', evalScenarioCatalog));
    results.push(await runCase('blocked-url', evalBlockedUrl));
    results.push(await runCase('mastery-remediation', evalMasteryRemediation));

    if (RUN_LIVE_LLM_EVALS) {
        results.push(await runCase('broad-topic-narrow-source', evalBroadTopicMap));
        results.push(await runCase('niche-topic-low-source', evalNicheNodeGrounding));
        results.push(await runCase('repo-concept-learning-path', evalRepoConceptLearningPath));
    } else {
        results.push(skippedCase('broad-topic-narrow-source', 'Set RUN_LIVE_LLM_EVALS=true to run Gemini-backed map generation.'));
        results.push(skippedCase('niche-topic-low-source', 'Set RUN_LIVE_LLM_EVALS=true to run Gemini-backed node generation.'));
        results.push(skippedCase('repo-concept-learning-path', 'Set RUN_LIVE_LLM_EVALS=true to run GitHub + Gemini-backed repo concept analysis.'));
    }

    const failed = results.filter(result => result.status === 'failed');
    const passed = results.filter(result => result.status === 'passed');
    const skipped = results.filter(result => result.status === 'skipped');

    return {
        baseUrl: BASE_URL,
        liveLlmEvals: RUN_LIVE_LLM_EVALS,
        total: results.length,
        passed: passed.length,
        failed: failed.length,
        skipped: skipped.length,
        results,
    };
}

if (require.main === module) {
    runEndpointEval()
        .then(summary => {
            console.log(JSON.stringify(summary, null, 2));
            if (summary.failed > 0) process.exit(1);
        })
        .catch(err => {
            console.error(JSON.stringify({
                baseUrl: BASE_URL,
                liveLlmEvals: RUN_LIVE_LLM_EVALS,
                total: 0,
                passed: 0,
                failed: 1,
                skipped: 0,
                error: err.message,
            }, null, 2));
            process.exit(1);
        });
}

module.exports = {
    runEndpointEval,
    requestJson,
};
