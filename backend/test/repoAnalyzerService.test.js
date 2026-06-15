const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseGitHubRepoUrl,
    sanitizeAnalysis,
    buildRepoConceptPrompt,
    buildRepoCodeGraph,
    isLikelyGeneratedOrVendored
} = require('../repoAnalyzerService');

test('parseGitHubRepoUrl accepts normal GitHub repository URLs', () => {
    assert.deepEqual(parseGitHubRepoUrl('https://github.com/openai/openai-node'), {
        owner: 'openai',
        repo: 'openai-node',
    });
});

test('sanitizeAnalysis keeps only evidence-backed concepts and normalizes confidence', () => {
    const evidence = [
        { id: 'ev_1', type: 'dependency', value: 'react' },
        { id: 'ev_2', type: 'path', value: 'src/components/App.jsx' },
    ];

    const analysis = sanitizeAnalysis({
        repo_summary: { project_type: 'Frontend app', plain_english: 'A UI project', confidence: 'high' },
        concepts: [
            {
                id: 'react-ui',
                title: 'React UI Development',
                confidence: 'high',
                learning_goals: ['Understand components'],
                evidence_ids: ['ev_1', 'ev_2'],
            },
            {
                id: 'fake-payments',
                title: 'Payments',
                confidence: 'high',
                evidence_ids: ['ev_missing'],
            },
            {
                id: 'single-evidence',
                title: 'Single Evidence Concept',
                confidence: 'high',
                evidence_ids: ['ev_1'],
            },
        ],
        learning_path: [
            { order: 2, concept_id: 'single-evidence', title: 'Second' },
            { order: 1, concept_id: 'react-ui', title: 'First' },
            { order: 3, concept_id: 'fake-payments', title: 'Invalid' },
        ],
    }, evidence);

    assert.equal(analysis.concepts.length, 2);
    assert.equal(analysis.concepts.some(concept => concept.id === 'fake-payments'), false);
    assert.equal(analysis.concepts.find(concept => concept.id === 'single-evidence').confidence, 'medium');
    assert.deepEqual(analysis.learning_path.map(step => step.order), [1, 2]);
    assert.deepEqual(analysis.learning_path.map(step => step.concept_id), ['react-ui', 'single-evidence']);
});

test('sanitizeAnalysis preserves valid code cluster ids only', () => {
    const evidence = [
        { id: 'ev_1', type: 'dependency', value: 'express' },
        { id: 'ev_2', type: 'code_cluster', value: 'api in server.js' },
    ];

    const analysis = sanitizeAnalysis({
        concepts: [
            {
                id: 'api-routes',
                title: 'API Route Handling',
                confidence: 'high',
                evidence_ids: ['ev_1', 'ev_2'],
                code_cluster_ids: ['ev_2', 'ev_missing'],
            },
        ],
        learning_path: [{ order: 1, concept_id: 'api-routes' }],
    }, evidence);

    assert.deepEqual(analysis.concepts[0].code_cluster_ids, ['ev_2']);
});

test('buildRepoCodeGraph creates implementation clusters from parsed source files', async () => {
    const graph = await buildRepoCodeGraph([
        {
            path: 'src/server.js',
            text: [
                'import express from "express";',
                'import upload from "./upload.js";',
                'const app = express();',
                'app.post("/photos/new", upload.single("photo"), async (req, res) => {',
                '  res.json({ file: req.file.filename });',
                '});',
            ].join('\n'),
        },
        {
            path: 'src/upload.js',
            text: [
                'import multer from "multer";',
                'export const upload = multer({ storage: multer.memoryStorage() });',
            ].join('\n'),
        },
    ]);

    assert.equal(graph.parser, 'tree-sitter-with-fallback');
    assert.ok(graph.clusters.length >= 2);
    assert.ok(graph.clusters.some(cluster => cluster.summary.includes('POST /photos/new')));
    assert.ok(graph.clusters.some(cluster => cluster.filePaths.includes('src/upload.js')));
});

test('buildRepoConceptPrompt includes late README content directly', () => {
    const evidence = [
        {
            id: 'ev_1',
            type: 'readme',
            value: 'README',
            detail: `${'Intro text. '.repeat(80)}
## Later section
This section contains late-evidence-token-alpha and late-evidence-token-beta.`,
        },
    ];

    const prompt = buildRepoConceptPrompt({
        evidence,
        repoInfo: { full_name: 'owner/repository', description: '' },
        skillLevel: 'beginner',
    });

    assert.match(prompt, /late-evidence-token-alpha/);
    assert.match(prompt, /late-evidence-token-beta/);
    assert.doesNotMatch(prompt, /readme_highlight/);
});

test('buildRepoConceptPrompt asks the model to preserve inferred key terms as keywords', () => {
    const prompt = buildRepoConceptPrompt({
        evidence: [
            {
                id: 'ev_1',
                type: 'readme',
                value: 'README',
                detail: 'The project describes a named integration for a domain-specific performance feature.',
            },
        ],
        repoInfo: { full_name: 'example/repo', description: '' },
        skillLevel: 'beginner',
    });

    assert.match(prompt, /Preserve important evidence terms in titles or keywords/);
    assert.match(prompt, /Keywords must come from evidence and be ordered for resource search/);
    assert.match(prompt, /first two should add specific detail beyond the title/);
    assert.match(prompt, /Concept titles must be reusable domain or method topics/);
    assert.match(prompt, /project labels, setup\/run tasks, file walkthroughs/);
    assert.match(prompt, /concrete tools, named assets, models, formats, commands, and components/);
    assert.match(prompt, /Reusable domain learning topic, not a repo\/project task/);
    assert.match(prompt, /"keywords"/);
    assert.doesNotMatch(prompt, /"tools"/);
});

test('buildRepoConceptPrompt includes implementation clusters and code_cluster_ids schema', () => {
    const prompt = buildRepoConceptPrompt({
        evidence: [
            {
                id: 'ev_1',
                type: 'code_cluster',
                value: 'api in server.js',
                detail: 'Role: api\nFile: src/server.js\nKey blocks: POST /photos/new',
            },
        ],
        repoInfo: { full_name: 'example/repo', description: '' },
        skillLevel: 'beginner',
        codeGraph: {
            clusters: [
                {
                    id: 'cg_1',
                    evidence_id: 'ev_1',
                    title: 'api in server.js',
                    summary: 'Role: api\nFile: src/server.js\nKey blocks: POST /photos/new',
                },
            ],
        },
    });

    assert.match(prompt, /Implementation clusters from Tree-sitter\/dependency analysis/);
    assert.match(prompt, /POST \/photos\/new/);
    assert.match(prompt, /code_cluster_ids/);
});

test('buildRepoConceptPrompt asks for domain-scoped concepts instead of over-generic topics', () => {
    const prompt = buildRepoConceptPrompt({
        evidence: [
            {
                id: 'ev_1',
                type: 'readme',
                value: 'README',
                detail: 'This repository focuses on a specialized method with measurable outcomes.',
            },
        ],
        repoInfo: { full_name: 'owner/repository', description: '' },
        skillLevel: 'beginner',
    });

    assert.match(prompt, /specific enough to explain the repository's problem space/);
    assert.match(prompt, /high-signal concepts/);
    assert.match(prompt, /promote a term only when the evidence shows conceptual importance/);
});

test('buildRepoConceptPrompt discourages generic prerequisite-heavy repo maps', () => {
    const prompt = buildRepoConceptPrompt({
        evidence: [
            {
                id: 'ev_1',
                type: 'readme',
                value: 'README',
                detail: 'The project describes a specialized method and reports task-specific outcomes.',
            },
        ],
        repoInfo: { full_name: 'example/repo', description: '' },
        skillLevel: 'beginner',
    });

    assert.match(prompt, /Prefer a smaller coherent path of high-signal concepts/);
    assert.match(prompt, /Broad prerequisites are allowed only when necessary/);
    assert.match(prompt, /include at most one/);
    assert.match(prompt, /broad school subjects/);
    assert.doesNotMatch(prompt, /Include both foundational prerequisites and repo-relevant advanced concepts/);
});

test('buildRepoConceptPrompt includes a generic title quality gate', () => {
    const prompt = buildRepoConceptPrompt({
        evidence: [
            {
                id: 'ev_1',
                type: 'readme',
                value: 'README',
                detail: 'The project describes evidence-scoped methods and outcomes.',
            },
        ],
        repoInfo: { full_name: 'example/repo', description: '' },
        skillLevel: 'beginner',
    });

    assert.match(prompt, /Quality gate before returning/);
    assert.match(prompt, /would fit many unrelated repositories/);
    assert.match(prompt, /more evidence-scoped method\/topic/);
    assert.match(prompt, /umbrella field, dependency, lifecycle chore, or generic skill/);
    assert.match(prompt, /simplify wording and goals; do not make the topic scope generic/);
});

test('buildRepoConceptPrompt asks the model to judge named terms by conceptual importance', () => {
    const prompt = buildRepoConceptPrompt({
        evidence: [
            {
                id: 'ev_1',
                type: 'readme',
                value: 'README',
                detail: 'Capability Result\nNamedTermAlpha improves a measured outcome\nNotes\n- NamedTermAlpha appears again',
            },
        ],
        repoInfo: { full_name: 'example/repo', description: '' },
        skillLevel: 'beginner',
    });

    assert.match(prompt, /promote a term only when the evidence shows conceptual importance/);
    assert.match(prompt, /Preserve important evidence terms in titles or keywords/);
    assert.doesNotMatch(prompt, /ProjectSpecificCacheTerm/);
    assert.doesNotMatch(prompt, /roadmap\/checklist/);
});

test('isLikelyGeneratedOrVendored identifies generated, lock, and virtual environment files', () => {
    const ignored = [
        'node_modules/express/index.js',
        'vendor/jquery.js',
        'dist/bundle.js',
        'build/index.js',
        'coverage/index.html',
        '.next/server/pages/index.js',
        'target/debug/app',
        '__pycache__/main.cpython-39.pyc',
        'package-lock.json',
        'yarn.lock',
        'pnpm-lock.yaml',
        'poetry.lock',
        '.venv/lib/python3.10/site-packages/requests/api.py',
        'venv/bin/pip',
        '.env/lib/python3.9/site-packages/requests/',
        'env/bin/activate',
    ];

    const allowed = [
        'src/environment/config.py',
        'src/main.py',
        'backend/main.py',
        'components/MyVenvIndicator.jsx',
    ];

    for (const path of ignored) {
        assert.equal(isLikelyGeneratedOrVendored(path), true, `Should have ignored: ${path}`);
    }

    for (const path of allowed) {
        assert.equal(isLikelyGeneratedOrVendored(path), false, `Should not have ignored: ${path}`);
    }
});
