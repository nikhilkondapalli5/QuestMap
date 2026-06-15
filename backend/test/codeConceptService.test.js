const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCodeBlocks } = require('../codeConceptService');

test('parseCodeBlocks extracts JavaScript function and class blocks with line numbers', async () => {
    const blocks = await parseCodeBlocks({
        filePath: 'src/service.js',
        content: [
            'import x from "x";',
            '',
            'export function loadThing(id) {',
            '  return id;',
            '}',
            '',
            'class Worker {',
            '  run() { return true; }',
            '}',
        ].join('\n'),
    });

    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].symbolName, 'loadThing');
    assert.equal(blocks[0].startLine, 3);
    assert.equal(blocks[0].blockType, 'function');
    assert.equal(blocks[1].symbolName, 'Worker');
    assert.equal(blocks[1].blockType, 'class');
    assert.match(blocks[1].snippet, /run\(\)/);
    assert.equal(blocks[1].endLine, 9);
});

test('parseCodeBlocks extracts Python functions and classes', async () => {
    const blocks = await parseCodeBlocks({
        filePath: 'src/model.py',
        content: [
            'import os',
            '',
            'def score_item(value):',
            '    return value',
            '',
            'class Ranker:',
            '    pass',
        ].join('\n'),
    });

    assert.deepEqual(blocks.map(block => block.symbolName), ['score_item', 'Ranker']);
    assert.deepEqual(blocks.map(block => block.startLine), [3, 6]);
});

test('parseCodeBlocks keeps full Python class bodies while also exposing methods', async () => {
    const blocks = await parseCodeBlocks({
        filePath: 'src/agent.py',
        content: [
            'class Agent:',
            '    """Coordinates tool use."""',
            '    def __init__(self, tools):',
            '        self.tools = tools',
            '',
            '    def run(self, task):',
            '        return self.tools[0](task)',
            '',
            'def build_agent(tools):',
            '    return Agent(tools)',
        ].join('\n'),
    });

    const classBlock = blocks.find(block => block.symbolName === 'Agent');
    const initBlock = blocks.find(block => block.symbolName === '__init__');
    const runBlock = blocks.find(block => block.symbolName === 'run');
    const factoryBlock = blocks.find(block => block.symbolName === 'build_agent');

    assert.ok(classBlock);
    assert.match(classBlock.snippet, /def __init__/);
    assert.match(classBlock.snippet, /def run/);
    assert.doesNotMatch(classBlock.snippet, /def build_agent/);
    assert.ok(classBlock.endLine === 7 || classBlock.endLine === 8);
    assert.ok(initBlock);
    assert.ok(runBlock);
    assert.ok(factoryBlock);
});

test('parseCodeBlocks keeps full JavaScript class bodies by brace matching', async () => {
    const blocks = await parseCodeBlocks({
        filePath: 'src/agent.js',
        content: [
            'export class Agent {',
            '  constructor(tools) {',
            '    this.tools = tools;',
            '  }',
            '',
            '  run(task) {',
            '    return this.tools[0](task);',
            '  }',
            '}',
            '',
            'export function buildAgent(tools) {',
            '  return new Agent(tools);',
            '}',
        ].join('\n'),
    });

    const classBlock = blocks.find(block => block.symbolName === 'Agent');
    const factoryBlock = blocks.find(block => block.symbolName === 'buildAgent');

    assert.ok(classBlock);
    assert.match(classBlock.snippet, /constructor/);
    assert.match(classBlock.snippet, /run\(task\)/);
    assert.doesNotMatch(classBlock.snippet, /buildAgent/);
    assert.equal(classBlock.endLine, 9);
    assert.ok(factoryBlock);
    assert.equal(factoryBlock.startLine, 11);
});

test('parseCodeBlocks extracts React hooks and Socket.IO event listeners inside components', async () => {
    const blocks = await parseCodeBlocks({
        filePath: 'src/UserPhotos.jsx',
        content: [
            'import { useEffect } from "react";',
            'import { io } from "socket.io-client";',
            'const socket = io("http://localhost:3001", {',
            '  withCredentials: true',
            '});',
            '',
            'function UserPhotos({ userId, queryClient }) {',
            '  const commentMutation = useMutation({',
            '    mutationFn: (text) => addComment(text),',
            '    onSuccess: () => queryClient.invalidateQueries(["photos", userId]),',
            '  });',
            '',
            '  useEffect(() => {',
            '    socket.on("new-comment", (data) => {',
            '      queryClient.invalidateQueries(["photos", userId]);',
            '    });',
            '    return () => socket.off("new-comment");',
            '  }, [userId, queryClient]);',
            '',
            '  return null;',
            '}',
        ].join('\n'),
    });

    const socketInit = blocks.find(block => block.symbolName === 'socket socket.io client');
    const mutation = blocks.find(block => block.symbolName === 'commentMutation useMutation');
    const effect = blocks.find(block => block.symbolName === 'useEffect');
    const socketListener = blocks.find(block => block.symbolName === 'socket.on new-comment');
    const component = blocks.find(block => block.symbolName === 'UserPhotos');

    assert.ok(socketInit);
    assert.equal(socketInit.blockType, 'initialization');
    assert.ok(mutation);
    assert.equal(mutation.blockType, 'hook');
    assert.ok(effect);
    assert.match(effect.snippet, /socket\.on\("new-comment"/);
    assert.ok(socketListener);
    assert.equal(socketListener.blockType, 'event_handler');
    assert.equal(socketListener.anchorStartLine, 14);
    assert.equal(socketListener.traceSymbolName, 'useEffect');
    assert.match(socketListener.traceSnippet, /return \(\) => socket\.off/);
    assert.ok(component);
    assert.match(component.snippet, /useEffect/);
});

test('parseCodeBlocks extracts JavaScript route handlers and tests', async () => {
    const blocks = await parseCodeBlocks({
        filePath: 'src/server.test.js',
        content: [
            'app.get("/health", async (req, res) => {',
            '  res.json({ ok: true });',
            '});',
            '',
            'describe("health endpoint", () => {',
            '  test("returns ok", async () => {',
            '    expect(true).toBe(true);',
            '  });',
            '});',
        ].join('\n'),
    });

    const route = blocks.find(block => block.symbolName === 'GET /health');
    const suite = blocks.find(block => block.symbolName === 'describe health endpoint');
    const testCase = blocks.find(block => block.symbolName === 'test returns ok');

    assert.ok(route);
    assert.equal(route.blockType, 'route_handler');
    assert.ok(suite);
    assert.equal(suite.blockType, 'test');
    assert.ok(testCase);
});

test('parseCodeBlocks includes decorated Python routes with decorator context', async () => {
    const blocks = await parseCodeBlocks({
        filePath: 'src/api.py',
        content: [
            '@app.post("/predict")',
            'async def predict(request):',
            '    return {"ok": True}',
            '',
            'def helper():',
            '    return True',
        ].join('\n'),
    });

    const route = blocks.find(block => block.symbolName.includes('POST /predict'));
    const helper = blocks.find(block => block.symbolName === 'helper');

    assert.ok(route);
    assert.equal(route.blockType, 'route_handler');
    assert.equal(route.startLine, 1);
    assert.match(route.snippet, /@app\.post/);
    assert.ok(helper);
});

test('parseCodeBlocks extracts JavaScript config objects as retrievable blocks', async () => {
    const blocks = await parseCodeBlocks({
        filePath: 'vite.config.js',
        content: [
            'export const buildConfig = {',
            '  plugins: ["react"],',
            '  server: { port: 5173 },',
            '};',
        ].join('\n'),
    });

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].symbolName, 'buildConfig');
    assert.equal(blocks[0].blockType, 'config');
    assert.match(blocks[0].snippet, /server/);
});

test('parseCodeBlocks extracts configured factory initializers and related routes', async () => {
    const blocks = await parseCodeBlocks({
        filePath: 'webServer.js',
        content: [
            'const storage = adapter.diskStorage({',
            '  destination: function (req, file, cb) {',
            '    cb(null, "images");',
            '  },',
            '  filename: function (req, file, cb) {',
            '    cb(null, file.originalname);',
            '  },',
            '});',
            '',
            'const upload = adapter({ storage: storage });',
            '',
            'app.post("/photos/new", requireAuth, upload.single("uploadedphoto"), async (req, res) => {',
            '  if (!req.file) return res.status(400).send("No file uploaded");',
            '  return res.status(200).send({ file_name: req.file.filename });',
            '});',
        ].join('\n'),
    });

    const storage = blocks.find(block => block.symbolName === 'storage adapter.diskStorage');
    const upload = blocks.find(block => block.symbolName === 'upload adapter');
    const route = blocks.find(block => block.symbolName === 'POST /photos/new');

    assert.ok(storage);
    assert.equal(storage.blockType, 'initialization');
    assert.match(storage.snippet, /destination/);
    assert.ok(upload);
    assert.equal(upload.blockType, 'initialization');
    assert.ok(route);
    assert.match(route.snippet, /upload\.single/);
});

test('parseCodeBlocks treats notebook code text as Python', async () => {
    const blocks = await parseCodeBlocks({
        filePath: 'notebooks/experiment.ipynb',
        content: [
            '# Notebook code cell 1',
            'def build_agent(config):',
            '    return config',
            '',
            '# Notebook code cell 2',
            'class Evaluator:',
            '    pass',
        ].join('\n'),
    });

    assert.deepEqual(blocks.map(block => block.symbolName), ['build_agent', 'Evaluator']);
    assert.equal(blocks[0].language, 'python');
});

test('parseCodeBlocks falls back to a module block when no symbols are found', async () => {
    const blocks = await parseCodeBlocks({
        filePath: 'src/config.ts',
        content: 'export const settings = { enabled: true, threshold: 3 };',
    });

    assert.equal(blocks.length, 1);
    assert.ok(blocks[0].blockType === 'module' || blocks[0].blockType === 'block');
    assert.equal(blocks[0].startLine, 1);
});

test('linkConceptsToCode matches concept lexically and bypasses LLM reranking', async () => {
    const { linkConceptsToCode } = require('../codeConceptService');
    const concept = {
        title: 'Zustand State Store',
        keywords: ['store', 'zustand', 'state'],
        learning_goals: ['Learn Zustand'],
        practice_focus: 'How to create a Zustand store',
    };

    const mockBlocks = [
        {
            _id: '662b9e4e0db71499facad57a',
            filePath: 'src/store.js',
            language: 'javascript',
            blockType: 'hook',
            symbolName: 'useBearStore',
            startLine: 1,
            endLine: 10,
            snippet: 'const useBearStore = create((set) => ({ bears: 0 }))',
            summary: 'React state hook or custom utility for useBearStore in src/store.js',
        },
        {
            _id: '662b9e4e0db71499facad57b',
            filePath: 'src/index.css',
            language: 'css',
            blockType: 'block',
            symbolName: 'main-css',
            startLine: 1,
            endLine: 5,
            snippet: 'body { color: red; }',
            summary: 'Implements main-css block in src/index.css',
        }
    ];

    const result = await linkConceptsToCode({
        userId: 'user1',
        repo: { fullName: 'owner/repo', commitSha: 'sha123' },
        concepts: [concept],
        blocks: mockBlocks,
    });

    assert.equal(result.length, 1);
    const codeRefs = result[0].code_references;
    assert.ok(codeRefs.length > 0);
    
    const matched = codeRefs.find(ref => ref.symbolName === 'useBearStore');
    assert.ok(matched);
    assert.equal(matched.filePath, 'src/store.js');
    assert.equal(matched.centrality, 'supporting');
    assert.equal(matched.reason, 'Matched via code index similarity.');
});

test('linkConceptsToCode uses mapCodeBlocksToConceptsWithLlm to directly match concepts', async () => {
    const { linkConceptsToCode } = require('../codeConceptService');
    const concept = {
        id: 'zustand-store',
        title: 'Zustand State Store',
        keywords: ['store', 'zustand', 'state'],
    };

    const mockBlocks = [
        {
            _id: '662b9e4e0db71499facad57a',
            filePath: 'src/store.js',
            language: 'javascript',
            blockType: 'hook',
            symbolName: 'useBearStore',
            startLine: 1,
            endLine: 10,
            snippet: 'const useBearStore = create((set) => ({ bears: 0 }))',
            summary: 'State store',
        }
    ];

    const mockCallLlm = async (prompt) => {
        return {
            mappings: [
                {
                    concept_id: 'zustand-store',
                    matches: [
                        {
                            chunk_index: 0,
                            relevance: 0.98,
                            centrality: 'central',
                            reason: 'Main Zustand store definition.'
                        }
                    ]
                }
            ]
        };
    };

    const result = await linkConceptsToCode({
        userId: 'user1',
        repo: { fullName: 'owner/repo', commitSha: 'sha123' },
        concepts: [concept],
        blocks: mockBlocks,
        callLlm: mockCallLlm,
    });

    assert.equal(result.length, 1);
    const codeRefs = result[0].code_references;
    assert.equal(codeRefs.length, 1);
    assert.equal(codeRefs[0].symbolName, 'useBearStore');
    assert.equal(codeRefs[0].relevance, 0.98);
    assert.equal(codeRefs[0].centrality, 'central');
    assert.equal(codeRefs[0].reason, 'Main Zustand store definition.');
});

test('linkConceptsToCode semantic retrieval uses LLM query expansion and selects 1-2 keywords', async () => {
    const { linkConceptsToCode } = require('../codeConceptService');
    const concept = {
        id: 'session-auth',
        title: 'Session Authentication',
        keywords: ['login', 'logout', 'express-session', 'cookies', 'passport', 'auth-middleware'],
    };

    let generatedPrompt = '';
    const mockCallLlm = async (prompt) => {
        generatedPrompt = prompt;
        return {
            semantic_terms: ['authenticate user', 'login route'],
            code_patterns: ['req.session.userId', 'app.use(session)']
        };
    };

    const originalApiKey = process.env.PINECONE_API_KEY;
    process.env.PINECONE_API_KEY = 'mock-api-key';

    const ragService = require('../ragService');
    const originalRetrieve = ragService.retrieveRepoCodeMatches;

    let retrieveQueryParam = '';
    ragService.retrieveRepoCodeMatches = async ({ query }) => {
        retrieveQueryParam = query;
        return [
            {
                score: 0.88,
                blockId: 'mock_block_id_1',
            }
        ];
    };

    const RepoCodeBlock = require('../models/RepoCodeBlock');
    const originalFind = RepoCodeBlock.find;
    RepoCodeBlock.find = () => ({
        lean: async () => [
            {
                _id: 'mock_block_id_1',
                filePath: 'src/auth.js',
                language: 'javascript',
                blockType: 'route_handler',
                symbolName: 'POST /login',
                startLine: 10,
                endLine: 25,
                snippet: 'app.post("/login", (req, res) => {})',
                summary: 'Login endpoint',
            }
        ]
    });

    try {
        const result = await linkConceptsToCode({
            userId: 'user1',
            repo: { fullName: 'owner/repo', commitSha: 'sha123' },
            concepts: [concept],
            blocks: [{ _id: 'mock_block_id_1', summary: 'Login endpoint', vectorId: 'block_user1_mock' }],
            callLlm: mockCallLlm,
        });

        assert.match(generatedPrompt, /Review the concept title, description, and all candidate keywords/);
        assert.match(generatedPrompt, /Candidate Keywords/);
        assert.equal(retrieveQueryParam, 'authenticate user login route req.session.userId app.use(session)');
        assert.equal(result.length, 1);
        assert.equal(result[0].code_references.length, 1);
        assert.equal(result[0].code_references[0].symbolName, 'POST /login');
        assert.equal(result[0].code_references[0].relevance, 0.88);
        assert.equal(result[0].code_references[0].reason, 'Retrieved via vector similarity search.');
    } finally {
        process.env.PINECONE_API_KEY = originalApiKey;
        ragService.retrieveRepoCodeMatches = originalRetrieve;
        RepoCodeBlock.find = originalFind;
    }
});

