const SOURCE_EXTENSIONS = new Set([
    '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.py', '.java', '.go', '.rs', '.rb', '.php',
    '.cs', '.cpp', '.c', '.h', '.swift', '.kt',
    '.ipynb',
]);

const { parseCodeBlocks } = require('./codeConceptService');

const MANIFEST_NAMES = new Set([
    'package.json',
    'requirements.txt',
    'pyproject.toml',
    'Pipfile',
    'poetry.lock',
    'go.mod',
    'Cargo.toml',
    'Gemfile',
    'pom.xml',
    'build.gradle',
    'composer.json',
]);

const MAX_TREE_PATHS = 600;
const MAX_SAMPLE_FILES = 150;
const MAX_FILE_BYTES = 250000;
const MAX_README_CHARS = 30000;
const MAX_SAMPLE_CHARS = 2600;
const MAX_CODE_GRAPH_FILES = 80;
const MAX_CODE_GRAPH_BLOCKS = 260;
const MAX_CODE_CLUSTERS = 24;

function parseGitHubRepoUrl(repoUrl) {
    let parsed;
    try {
        parsed = new URL(repoUrl);
    } catch {
        throw new Error('Enter a valid GitHub repository URL.');
    }

    if (!['github.com', 'www.github.com'].includes(parsed.hostname.toLowerCase())) {
        throw new Error('Only github.com repository URLs are supported right now.');
    }

    const parts = parsed.pathname
        .replace(/^\/+|\/+$/g, '')
        .split('/')
        .filter(Boolean);

    if (parts.length < 2) {
        throw new Error('GitHub URL must include an owner and repository name.');
    }

    return {
        owner: parts[0],
        repo: parts[1].replace(/\.git$/i, ''),
    };
}

function githubHeaders() {
    return {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'QuestMapAI/1.0 (+repo concept learning)',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    };
}

async function githubFetchJson(url) {
    const response = await fetch(url, {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(12000),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`GitHub request failed (${response.status}): ${body.slice(0, 180)}`);
    }

    return response.json();
}

function decodeBase64Content(content) {
    return Buffer.from(String(content || '').replace(/\n/g, ''), 'base64').toString('utf8');
}

async function fetchGithubFile({ owner, repo, path, ref }) {
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`);
    if (ref) url.searchParams.set('ref', ref);

    const response = await fetch(url.toString(), {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(12000),
    });

    if (!response.ok) return null;
    const data = await response.json();
    if (Array.isArray(data) || data.type !== 'file' || data.size > MAX_FILE_BYTES || !data.content) return null;

    return decodeBase64Content(data.content);
}

function getExtension(path) {
    const match = String(path || '').match(/(\.[a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : '';
}

function languageForSourcePath(path) {
    const extension = getExtension(path);
    if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) return 'javascript';
    if (['.ts', '.tsx'].includes(extension)) return 'typescript';
    if (['.py', '.ipynb'].includes(extension)) return 'python';
    return extension.replace(/^\./, '') || 'text';
}

function isLikelyGeneratedOrVendored(path) {
    const value = String(path || '').toLowerCase();
    const parts = value.split('/');
    const ignoredDirs = [
        'node_modules',
        'vendor',
        'dist',
        'build',
        'coverage',
        '.next',
        'target',
        '__pycache__',
        'venv',
        '.venv',
        'env',
        '.env'
    ];
    if (parts.some(part => ignoredDirs.includes(part))) {
        return true;
    }
    return (
        value.endsWith('package-lock.json') ||
        value.endsWith('yarn.lock') ||
        value.endsWith('pnpm-lock.yaml') ||
        value.endsWith('poetry.lock')
    );
}

function isManifestPath(path) {
    return MANIFEST_NAMES.has(String(path || '').split('/').pop());
}

function isSourcePath(path) {
    return SOURCE_EXTENSIONS.has(getExtension(path));
}

function firstMeaningfulLines(text, maxChars = MAX_SAMPLE_CHARS) {
    return String(text || '')
        .split(/\r?\n/)
        .filter(line => line.trim() && !line.trim().startsWith('//') && !line.trim().startsWith('#'))
        .slice(0, 80)
        .join('\n')
        .slice(0, maxChars);
}

function extractNotebookCode(text) {
    try {
        const notebook = JSON.parse(text);
        if (!Array.isArray(notebook.cells)) return '';
        return notebook.cells
            .filter(cell => cell?.cell_type === 'code')
            .map((cell, index) => {
                const source = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
                return source.trim() ? `# Notebook code cell ${index + 1}\n${source.trim()}` : '';
            })
            .filter(Boolean)
            .join('\n\n');
    } catch {
        return '';
    }
}

function sourceTextForAnalysis(path, text) {
    if (getExtension(path) === '.ipynb') {
        return extractNotebookCode(text);
    }
    return text;
}

function extractPackageJsonDependencies(path, text) {
    try {
        const json = JSON.parse(text);
        const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
        const deps = [];
        for (const section of sections) {
            for (const [name, version] of Object.entries(json[section] || {})) {
                deps.push({ name, version: String(version || ''), section, manifest: path });
            }
        }
        return {
            scripts: json.scripts || {},
            dependencies: deps,
        };
    } catch {
        return { scripts: {}, dependencies: [] };
    }
}

function extractSimpleDependencies(path, text) {
    const filename = path.split('/').pop();
    const deps = [];
    const lines = String(text || '').split(/\r?\n/);

    if (filename === 'requirements.txt') {
        for (const line of lines) {
            const cleaned = line.trim();
            if (!cleaned || cleaned.startsWith('#') || cleaned.startsWith('-')) continue;
            const name = cleaned.split(/[=<>~! ]/)[0];
            if (name) deps.push({ name, version: cleaned.slice(name.length), section: 'requirements', manifest: path });
        }
    } else if (filename === 'go.mod') {
        for (const line of lines) {
            const match = line.trim().match(/^([a-z0-9_.\-\/]+)\s+v?\d/i);
            if (match && !match[1].startsWith('module')) deps.push({ name: match[1], version: '', section: 'go.mod', manifest: path });
        }
    } else if (filename === 'Cargo.toml' || filename === 'pyproject.toml') {
        let inDependencyBlock = false;
        for (const line of lines) {
            const trimmed = line.trim();
            if (/^\[.*depend/i.test(trimmed)) {
                inDependencyBlock = true;
                continue;
            }
            if (trimmed.startsWith('[')) inDependencyBlock = false;
            if (inDependencyBlock) {
                const match = trimmed.match(/^([A-Za-z0-9_.\-]+)\s*=/);
                if (match) deps.push({ name: match[1], version: '', section: filename, manifest: path });
            }
        }
    } else if (filename === 'Gemfile') {
        for (const line of lines) {
            const match = line.trim().match(/^gem\s+['"]([^'"]+)['"]/);
            if (match) deps.push({ name: match[1], version: '', section: 'Gemfile', manifest: path });
        }
    }

    return deps;
}

function extractImports(path, text) {
    const imports = new Set();
    const patterns = [
        /import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
        /require\(\s*['"]([^'"]+)['"]\s*\)/g,
        /from\s+['"]([^'"]+)['"]/g,
        /^import\s+([a-zA-Z0-9_.\/-]+)/gm,
        /^using\s+([A-Za-z0-9_.]+)/gm,
        /^package\s+([A-Za-z0-9_.]+)/gm,
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const value = match[1];
            if (value && !value.startsWith('.') && !value.startsWith('/')) imports.add(value);
        }
    }

    return [...imports].slice(0, 40).map(name => ({ name, file: path }));
}

function extractAllImports(path, text) {
    const imports = [];
    const patterns = [
        /import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
        /require\(\s*['"]([^'"]+)['"]\s*\)/g,
        /from\s+['"]([^'"]+)['"]/g,
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            if (match[1]) imports.push({ name: match[1], file: path, local: match[1].startsWith('.') || match[1].startsWith('/') });
        }
    }

    return imports.slice(0, 80);
}

function pathWithoutExtension(path) {
    return String(path || '').replace(/\.[a-z0-9]+$/i, '');
}

function normalizePathParts(parts) {
    const stack = [];
    for (const part of parts) {
        if (!part || part === '.') continue;
        if (part === '..') stack.pop();
        else stack.push(part);
    }
    return stack.join('/');
}

function resolveLocalImport(fromPath, importName, allPaths) {
    if (!importName || (!importName.startsWith('.') && !importName.startsWith('/'))) return null;
    const baseDir = String(fromPath || '').split('/').slice(0, -1);
    const candidateBase = normalizePathParts([...baseDir, importName]);
    const normalized = candidateBase.replace(/^\/+/, '');
    const candidates = [
        normalized,
        `${normalized}.js`,
        `${normalized}.jsx`,
        `${normalized}.ts`,
        `${normalized}.tsx`,
        `${normalized}.py`,
        `${normalized}/index.js`,
        `${normalized}/index.jsx`,
        `${normalized}/index.ts`,
        `${normalized}/index.tsx`,
    ];
    return candidates.find(candidate => allPaths.has(candidate)) || null;
}

function fileRole(path) {
    const lower = String(path || '').toLowerCase();
    if (/test|spec/.test(lower)) return 'test';
    if (/route|server|controller|api|endpoint/.test(lower)) return 'api';
    if (/component|page|view|screen/.test(lower)) return 'ui';
    if (/store|state|context|reducer/.test(lower)) return 'state';
    if (/model|schema|entity/.test(lower)) return 'data_model';
    if (/service|client|adapter|provider/.test(lower)) return 'service';
    if (/config|settings|vite|webpack|tailwind/.test(lower)) return 'config';
    return 'implementation';
}

function compactBlock(block) {
    return {
        symbolName: block.symbolName,
        blockType: block.blockType,
        startLine: block.startLine,
        endLine: block.endLine,
    };
}

async function buildRepoCodeGraph(sourceFiles = []) {
    const selectedFiles = sourceFiles
        .filter(file => file?.path && file?.text)
        .slice(0, MAX_CODE_GRAPH_FILES);
    const allPaths = new Set(selectedFiles.map(file => file.path));
    const files = [];
    const blocks = [];

    for (const file of selectedFiles) {
        const language = getExtension(file.path) === '.ipynb' ? 'python' : undefined;
        const parsed = await parseCodeBlocks({ filePath: file.path, content: file.text }).catch(() => []);
        const imports = extractAllImports(file.path, file.text);
        const localImports = imports
            .filter(item => item.local)
            .map(item => ({ ...item, resolvedPath: resolveLocalImport(file.path, item.name, allPaths) }))
            .filter(item => item.resolvedPath);
        const externalImports = imports.filter(item => !item.local).map(item => item.name);
        const fileBlocks = parsed.slice(0, 40).map(block => ({
            ...compactBlock(block),
            filePath: file.path,
            language: block.language || language || languageForSourcePath(file.path),
        }));

        files.push({
            path: file.path,
            role: fileRole(file.path),
            imports: [...new Set(externalImports)].slice(0, 20),
            localImports: localImports.map(item => item.resolvedPath).slice(0, 20),
            blocks: fileBlocks.slice(0, 12),
        });
        blocks.push(...fileBlocks);
    }

    const clusters = files
        .filter(file => file.blocks.length > 0)
        .map((file, index) => {
            const keyBlocks = file.blocks
                .filter(block => ['route_handler', 'hook', 'initialization', 'config', 'class', 'function'].includes(block.blockType))
                .slice(0, 8);
            const representativeBlocks = keyBlocks.length ? keyBlocks : file.blocks.slice(0, 6);
            const id = `cg_${index + 1}`;
            return {
                id,
                title: `${file.role.replace(/_/g, ' ')} in ${file.path.split('/').pop()}`,
                filePaths: [file.path, ...file.localImports].filter(Boolean).slice(0, 8),
                role: file.role,
                imports: file.imports.slice(0, 12),
                localDependencies: file.localImports.slice(0, 8),
                blocks: representativeBlocks,
                summary: [
                    `Role: ${file.role}`,
                    `File: ${file.path}`,
                    file.imports.length ? `External imports: ${file.imports.slice(0, 10).join(', ')}` : '',
                    file.localImports.length ? `Local dependencies: ${file.localImports.slice(0, 8).join(', ')}` : '',
                    representativeBlocks.length ? `Key blocks: ${representativeBlocks.map(block => `${block.symbolName} (${block.blockType}, L${block.startLine}-${block.endLine})`).join('; ')}` : '',
                ].filter(Boolean).join('\n'),
            };
        })
        .slice(0, MAX_CODE_CLUSTERS);

    return {
        parser: 'tree-sitter-with-fallback',
        fileCount: files.length,
        blockCount: blocks.length,
        edgeCount: files.reduce((sum, file) => sum + file.localImports.length, 0),
        files,
        clusters,
    };
}

function summarizeTree(treeItems) {
    const paths = treeItems
        .filter(item => item.type === 'blob' || item.type === 'tree')
        .map(item => item.path)
        .filter(path => path && !isLikelyGeneratedOrVendored(path))
        .slice(0, MAX_TREE_PATHS);

    const topLevelFolders = [...new Set(paths
        .map(path => path.split('/')[0])
        .filter(Boolean)
        .filter(part => !part.includes('.')))]
        .slice(0, 40);

    const interestingPaths = paths.filter(path => {
        const lower = path.toLowerCase();
        return (
            isManifestPath(path) ||
            lower.includes('readme') ||
            lower.includes('doc') ||
            lower.includes('test') ||
            lower.includes('route') ||
            lower.includes('api') ||
            lower.includes('model') ||
            lower.includes('schema') ||
            lower.includes('service') ||
            lower.includes('component') ||
            lower.includes('page')
        );
    }).slice(0, 180);

    return { paths, topLevelFolders, interestingPaths };
}

function selectSampleFiles(treeItems) {
    const sourceFiles = treeItems
        .filter(item => item.type === 'blob' && !isLikelyGeneratedOrVendored(item.path) && isSourcePath(item.path))
        .sort((a, b) => {
            const score = path => {
                const lower = path.toLowerCase();
                let value = 0;
                if (lower.includes('server') || lower.includes('app') || lower.includes('main') || lower.includes('index')) value += 5;
                if (lower.includes('route') || lower.includes('api') || lower.includes('service')) value += 4;
                if (lower.includes('model') || lower.includes('schema')) value += 3;
                if (lower.includes('component') || lower.includes('page')) value += 2;
                return value;
            };
            return score(b.path) - score(a.path) || a.path.localeCompare(b.path);
        });

    return sourceFiles.slice(0, MAX_SAMPLE_FILES).map(item => item.path);
}

function createEvidenceIndex({ repoInfo, readme, manifests, treeSummary, sampleFiles, dependencies, imports, codeGraph }) {
    const evidence = [];
    let counter = 1;
    const addEvidence = (type, value, detail = '', weight = 'medium') => {
        if (!value) return null;
        const id = `ev_${counter++}`;
        evidence.push({ id, type, value, detail, weight });
        return id;
    };

    addEvidence('repo_description', repoInfo.description || repoInfo.full_name, repoInfo.html_url, repoInfo.description ? 'medium' : 'low');
    if (readme) {
        addEvidence('readme', 'README', readme.slice(0, MAX_README_CHARS), 'high');
    }

    for (const manifest of manifests) {
        addEvidence('manifest', manifest.path, manifest.summary, 'high');
    }
    for (const dependency of dependencies.slice(0, 220)) {
        addEvidence('dependency', dependency.name, `${dependency.section} in ${dependency.manifest}${dependency.version ? ` (${dependency.version})` : ''}`, 'high');
    }
    for (const folder of treeSummary.topLevelFolders) {
        addEvidence('folder', folder, 'Top-level repository folder', 'medium');
    }
    for (const path of treeSummary.interestingPaths.slice(0, 120)) {
        addEvidence('path', path, 'Repository path signal', 'medium');
    }
    for (const file of sampleFiles) {
        addEvidence('sample_file', file.path, file.sample, 'medium');
    }
    for (const imported of imports.slice(0, 160)) {
        addEvidence('import', imported.name, `Imported in ${imported.file}`, 'medium');
    }
    for (const cluster of (codeGraph?.clusters || []).slice(0, MAX_CODE_CLUSTERS)) {
        const evidenceId = addEvidence('code_cluster', cluster.title, cluster.summary, 'high');
        cluster.evidence_id = evidenceId;
    }

    return evidence;
}

function normalizeId(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 70);
}

function evidenceDigest(evidence) {
    return evidence.map(item => {
        const detailLimit = item.type === 'readme'
            ? MAX_README_CHARS
            : item.type === 'sample_file'
                ? 700
                : 280;
        return `${item.id} | ${item.type} | ${item.value} | ${String(item.detail || '').slice(0, detailLimit)}`;
    }).join('\n');
}

function codeGraphDigest(codeGraph) {
    if (!codeGraph?.clusters?.length) return 'No implementation clusters were available.';
    return codeGraph.clusters.map(cluster => (
        `${cluster.evidence_id || cluster.id} | ${cluster.title}\n${cluster.summary}`
    )).join('\n\n').slice(0, 18000);
}

function buildRepoConceptPrompt({ evidence, repoInfo, skillLevel, codeGraph }) {
    return `
Create a concept-learning curriculum from GitHub repository evidence.
The repository is only a signal for what the learner should study; do not produce a repo walkthrough, setup guide, or code-reading plan.
Return reusable learning concepts that are grounded in evidence and specific enough to explain the repository's problem space.

Skill level: "${skillLevel || 'beginner'}"
Repo: "${repoInfo.full_name}"
Description: "${repoInfo.description || 'No description'}"

Evidence catalog:
${evidenceDigest(evidence).slice(0, 45000)}

Implementation clusters from Tree-sitter/dependency analysis:
${codeGraphDigest(codeGraph)}

Rules:
- Use ONLY the evidence ids above when justifying concepts.
- Every concept must have at least one evidence_id.
- Prefer code_cluster evidence when it reveals actual implementation concepts, dependencies, or runtime flows.
- Generate concepts from README plus implementation clusters together; do not rely only on README terms when code shows important architecture.
- When a concept maps to implementation clusters, include those code_cluster evidence ids in code_cluster_ids.
- High confidence requires at least two evidence_ids.
- Prefer a smaller coherent path of high-signal concepts over a long list of generic prerequisite subjects.
- Concept titles must be reusable domain or method topics, not project labels, setup/run tasks, file walkthroughs, broad school subjects, or standalone dependency names.
- Broad prerequisites are allowed only when necessary for the skill level; include at most one, keep it early, and connect it clearly to later concepts.
- Preserve important evidence terms in titles or keywords, but promote a term only when the evidence shows conceptual importance.
- Keywords must come from evidence and be ordered for resource search; the first two should add specific detail beyond the title, not restate it.
- Keep concrete tools, named assets, models, formats, commands, and components in keywords unless they are central standalone learning concepts.
- Do not invent unsupported libraries, frameworks, domains, or outcomes.
- If evidence is weak, mark confidence "low".
- Order the learning_path so prerequisites come before advanced ideas.

Quality gate before returning:
- If a concept title would fit many unrelated repositories, replace it with a more evidence-scoped method/topic or drop it.
- If a title is only an umbrella field, dependency, lifecycle chore, or generic skill, use it as a keyword/prerequisite instead of a concept.
- A strong concept title names what is being learned plus the mechanism, task, or outcome implied by evidence.
- For beginner skill level, simplify wording and goals; do not make the topic scope generic.

Return valid JSON:
{
  "repo_summary": {
    "project_type": "Short category of project",
    "plain_english": "One sentence explaining what kind of concepts this repo points to",
    "confidence": "high | medium | low"
  },
  "detected_stack": ["stack/library/framework names from evidence"],
  "concepts": [
    {
      "id": "stable-slug",
      "title": "Reusable domain learning topic, not a repo/project task",
      "category": "frontend | backend | data | ai | devops | testing | architecture | security | domain | other",
      "confidence": "high | medium | low",
      "why_relevant": "Why this concept is relevant to this repo as a learning signal",
      "keywords": ["important evidence-backed terms for this concept"],
      "learning_goals": ["goal 1", "goal 2", "goal 3"],
      "prerequisites": ["prerequisite concept"],
      "resource_query": "Search query using only the concept title and evidence-backed keywords; do not add unsupported libraries or frameworks",
      "practice_focus": "What practice questions should test",
      "code_cluster_ids": ["ev_10"],
      "evidence_ids": ["ev_1"]
    }
  ],
  "learning_path": [
    {
      "order": 1,
      "concept_id": "stable-slug",
      "title": "Learning step title",
      "why_now": "Why this belongs at this point in the path",
      "task": "Concept-learning task, not code-reading task"
    }
  ],
  "suggested_project_tasks": [
    {
      "level": "beginner | intermediate | advanced",
      "task": "A learning exercise inspired by this repo's concepts",
      "concept_ids": ["stable-slug"]
    }
  ]
}
`;
}

function sanitizeConcepts(concepts, evidenceIds, codeClusterEvidenceIds = new Set()) {
    const seen = new Set();
    return (Array.isArray(concepts) ? concepts : [])
        .map((concept, index) => {
            const validEvidenceIds = (Array.isArray(concept.evidence_ids) ? concept.evidence_ids : [])
                .filter(id => evidenceIds.has(id));
            if (validEvidenceIds.length === 0) return null;

            const title = String(concept.title || `Concept ${index + 1}`).trim();
            const id = normalizeId(concept.id || title);
            if (!id || seen.has(id)) return null;
            seen.add(id);

            let confidence = ['high', 'medium', 'low'].includes(concept.confidence) ? concept.confidence : 'medium';
            if (confidence === 'high' && validEvidenceIds.length < 2) confidence = 'medium';

            return {
                id,
                title,
                category: String(concept.category || 'other'),
                confidence,
                why_relevant: String(concept.why_relevant || ''),
                keywords: Array.isArray(concept.keywords)
                    ? concept.keywords.slice(0, 10).map(String)
                    : (Array.isArray(concept.tools) ? concept.tools.slice(0, 10).map(String) : []),
                learning_goals: Array.isArray(concept.learning_goals) ? concept.learning_goals.slice(0, 5).map(String) : [],
                prerequisites: Array.isArray(concept.prerequisites) ? concept.prerequisites.slice(0, 6).map(String) : [],
                resource_query: String(concept.resource_query || `${title} tutorial beginner`),
                practice_focus: String(concept.practice_focus || `Core understanding of ${title}`),
                code_cluster_ids: (Array.isArray(concept.code_cluster_ids) ? concept.code_cluster_ids : [])
                    .map(String)
                    .filter(id => codeClusterEvidenceIds.has(id))
                    .slice(0, 6),
                evidence_ids: validEvidenceIds.slice(0, 8),
            };
        })
        .filter(Boolean)
        .slice(0, 14);
}

function sanitizeAnalysis(rawAnalysis, evidence) {
    const evidenceIds = new Set(evidence.map(item => item.id));
    const codeClusterEvidenceIds = new Set(evidence.filter(item => item.type === 'code_cluster').map(item => item.id));
    const concepts = sanitizeConcepts(rawAnalysis?.concepts, evidenceIds, codeClusterEvidenceIds);
    const conceptIds = new Set(concepts.map(item => item.id));

    const learningPath = (Array.isArray(rawAnalysis?.learning_path) ? rawAnalysis.learning_path : [])
        .map((step, index) => {
            const conceptId = normalizeId(step.concept_id || '');
            if (!conceptIds.has(conceptId)) return null;
            return {
                order: Number(step.order || index + 1),
                concept_id: conceptId,
                title: String(step.title || concepts.find(item => item.id === conceptId)?.title || `Step ${index + 1}`),
                why_now: String(step.why_now || ''),
                task: String(step.task || ''),
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.order - b.order)
        .map((step, index) => ({ ...step, order: index + 1 }));

    const pathConcepts = new Set(learningPath.map(step => step.concept_id));
    for (const concept of concepts) {
        if (!pathConcepts.has(concept.id)) {
            learningPath.push({
                order: learningPath.length + 1,
                concept_id: concept.id,
                title: concept.title,
                why_now: 'This repo provides evidence that the concept is relevant to understanding similar projects.',
                task: `Learn the core ideas behind ${concept.title}, then test yourself with concept practice.`,
            });
        }
    }

    return {
        repo_summary: {
            project_type: String(rawAnalysis?.repo_summary?.project_type || 'Software project'),
            plain_english: String(rawAnalysis?.repo_summary?.plain_english || 'This repository suggests a concept-focused learning path.'),
            confidence: ['high', 'medium', 'low'].includes(rawAnalysis?.repo_summary?.confidence)
                ? rawAnalysis.repo_summary.confidence
                : 'medium',
        },
        detected_stack: Array.isArray(rawAnalysis?.detected_stack)
            ? rawAnalysis.detected_stack.slice(0, 18).map(String)
            : [],
        concepts,
        learning_path: learningPath.slice(0, 14),
        suggested_project_tasks: (Array.isArray(rawAnalysis?.suggested_project_tasks) ? rawAnalysis.suggested_project_tasks : [])
            .map(task => ({
                level: ['beginner', 'intermediate', 'advanced'].includes(task.level) ? task.level : 'beginner',
                task: String(task.task || ''),
                concept_ids: (Array.isArray(task.concept_ids) ? task.concept_ids : [])
                    .map(normalizeId)
                    .filter(id => conceptIds.has(id))
                    .slice(0, 5),
            }))
            .filter(task => task.task && task.concept_ids.length > 0)
            .slice(0, 6),
    };
}

async function parallelLimit(tasks, limit) {
    const results = [];
    const executing = new Set();
    for (const task of tasks) {
        const p = Promise.resolve().then(() => task());
        results.push(p);
        executing.add(p);
        const clean = () => executing.delete(p);
        p.then(clean, clean);
        if (executing.size >= limit) {
            await Promise.race(executing);
        }
    }
    return Promise.all(results);
}

async function fetchRepoEvidence(repoUrl) {
    const { owner, repo } = parseGitHubRepoUrl(repoUrl);
    const repoInfo = await githubFetchJson(`https://api.github.com/repos/${owner}/${repo}`);
    const branch = repoInfo.default_branch || 'main';
    const tree = await githubFetchJson(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    if (!Array.isArray(tree.tree)) throw new Error('GitHub tree response did not include repository files.');

    const treeSummary = summarizeTree(tree.tree);
    const readme = await fetchGithubFile({ owner, repo, path: 'README.md', ref: branch })
        || await fetchGithubFile({ owner, repo, path: 'readme.md', ref: branch })
        || '';

    const manifestPaths = tree.tree
        .filter(item => item.type === 'blob' && isManifestPath(item.path) && !isLikelyGeneratedOrVendored(item.path))
        .map(item => item.path)
        .slice(0, 18);

    const manifestPromises = manifestPaths.map(async (path) => {
        const text = await fetchGithubFile({ owner, repo, path, ref: branch });
        if (!text) return null;
        return { path, text };
    });
    const fetchedManifests = (await Promise.all(manifestPromises)).filter(Boolean);

    const manifests = [];
    const dependencies = [];
    for (const { path, text } of fetchedManifests) {
        let manifestSummary = firstMeaningfulLines(text, 1800);
        if (path.endsWith('package.json')) {
            const extracted = extractPackageJsonDependencies(path, text);
            dependencies.push(...extracted.dependencies);
            manifestSummary = JSON.stringify({
                path,
                scripts: extracted.scripts,
                dependencies: extracted.dependencies.map(dep => dep.name).slice(0, 80),
            });
        } else {
            dependencies.push(...extractSimpleDependencies(path, text));
        }
        manifests.push({ path, summary: manifestSummary });
    }

    const samplePaths = selectSampleFiles(tree.tree);
    const tasks = samplePaths.map((path) => async () => {
        const text = await fetchGithubFile({ owner, repo, path, ref: branch });
        if (!text) return null;
        const analysisText = sourceTextForAnalysis(path, text);
        if (!analysisText.trim()) return null;
        const sample = firstMeaningfulLines(analysisText);
        return { path, text: analysisText, sample };
    });

    const rawResults = await parallelLimit(tasks, 15);
    const results = rawResults.filter(Boolean);

    const sampleFiles = [];
    const sourceFiles = [];
    const imports = [];
    for (const res of results) {
        sampleFiles.push({ path: res.path, sample: res.sample });
        sourceFiles.push({ path: res.path, text: res.text });
        imports.push(...extractImports(res.path, res.text));
    }

    const codeGraph = await buildRepoCodeGraph(sourceFiles).catch(err => {
        console.warn('[Repo Code Graph] Skipped:', err.message);
        return { parser: 'tree-sitter-with-fallback', fileCount: 0, blockCount: 0, edgeCount: 0, files: [], clusters: [] };
    });

    const evidence = createEvidenceIndex({
        repoInfo,
        readme: readme.slice(0, MAX_README_CHARS),
        manifests,
        treeSummary,
        sampleFiles,
        dependencies,
        imports,
        codeGraph,
    });

    return {
        repo: {
            owner,
            name: repo,
            fullName: repoInfo.full_name || `${owner}/${repo}`,
            url: repoInfo.html_url || repoUrl,
            description: repoInfo.description || '',
            defaultBranch: branch,
            commitSha: tree.sha || branch,
        },
        scan: {
            readmeFound: Boolean(readme),
            manifestCount: manifests.length,
            dependencyCount: dependencies.length,
            sampledFileCount: sampleFiles.length,
            totalTreeItems: tree.tree.length,
            evidenceCount: evidence.length,
            topLevelFolders: treeSummary.topLevelFolders,
        },
        evidence,
        sourceFiles,
        codeGraph,
    };
}

async function analyzeRepoWithLlm({ repoUrl, skillLevel = 'beginner', callLlm }) {
    if (typeof callLlm !== 'function') throw new Error('callLlm function is required');
    const evidenceBundle = await fetchRepoEvidence(repoUrl);
    const rawAnalysis = await callLlm(buildRepoConceptPrompt({
        evidence: evidenceBundle.evidence,
        repoInfo: {
            full_name: evidenceBundle.repo.fullName,
            description: evidenceBundle.repo.description,
        },
        skillLevel,
        codeGraph: evidenceBundle.codeGraph,
    }));

    const analysis = sanitizeAnalysis(rawAnalysis, evidenceBundle.evidence);
    if (analysis.concepts.length === 0) {
        throw new Error('Repo analysis did not produce any evidence-backed concepts.');
    }

    return {
        ...evidenceBundle,
        analysis,
    };
}

module.exports = {
    parseGitHubRepoUrl,
    fetchRepoEvidence,
    analyzeRepoWithLlm,
    sanitizeAnalysis,
    buildRepoConceptPrompt,
    buildRepoCodeGraph,
    isLikelyGeneratedOrVendored,
};
