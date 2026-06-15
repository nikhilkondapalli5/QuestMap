const EVAL_SCENARIOS = [
    {
        id: 'eval-scenarios-api',
        mode: 'default',
        endpoint: 'GET /api/eval-scenarios',
        topic: 'Eval coverage contract',
        sourceSummary: 'The backend should expose the eval suite that can be run against a local server.',
        expectedBehavior: 'Endpoint returns this scenario catalog with stable ids.',
    },
    {
        id: 'blocked-url',
        mode: 'default',
        endpoint: 'POST /api/ingest-url',
        topic: 'URL permission check',
        sourceSummary: 'Private, local, or otherwise unsafe URLs should not be ingested as source evidence.',
        expectedBehavior: 'Endpoint returns a structured client error and does not create a document.',
    },
    {
        id: 'mastery-remediation',
        mode: 'default',
        endpoint: 'POST /api/mastery/attempt',
        topic: 'Dinosaur extinction theories',
        sourceSummary: 'A missed concept should produce a targeted remediation drill.',
        expectedBehavior: 'Mastery record stores the miss and remediation practice focuses on the missed concept.',
    },
    {
        id: 'broad-topic-narrow-source',
        mode: 'live',
        endpoint: 'POST /api/generate-map',
        topic: 'Machine Learning',
        sourceSummary: 'A narrow paper about video summarization should not dominate the full curriculum map.',
        expectedBehavior: 'Map covers foundational ML concepts and marks narrow-source coverage as limited.',
    },
    {
        id: 'niche-topic-low-source',
        mode: 'live',
        endpoint: 'POST /api/generate-node-data',
        topic: 'Fermi paradox rare solutions',
        sourceSummary: 'Sparse source coverage should produce low-confidence exploratory practice.',
        expectedBehavior: 'Practice does not invent citations and asks for source-backed review where needed.',
    },
    {
        id: 'repo-concept-learning-path',
        mode: 'live',
        endpoint: 'POST /api/repo/analyze',
        topic: 'GitHub repo curriculum seed',
        sourceSummary: 'A repository URL should produce evidence-backed general learning concepts, not a file-by-file code walkthrough.',
        expectedBehavior: 'Analysis returns concepts with valid evidence ids and an ordered learning path.',
    },
];

module.exports = EVAL_SCENARIOS;
