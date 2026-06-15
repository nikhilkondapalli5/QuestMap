const crypto = require('node:crypto');
const RepoFile = require('./models/RepoFile');
const RepoCodeBlock = require('./models/RepoCodeBlock');

const MAX_FILES_TO_INGEST = 150;
const MAX_BLOCKS_TO_SUMMARIZE = 300;
const MAX_BLOCK_LINES = 260;
const MAX_SNIPPET_CHARS = 14000;
const MAX_CODE_REFERENCES_PER_CONCEPT = Number(process.env.REPO_CODE_MATCH_LIMIT || 25);

const EXTENSION_LANGUAGE = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.java': 'java',
    '.go': 'go',
    '.rs': 'rust',
    '.rb': 'ruby',
    '.php': 'php',
    '.cs': 'csharp',
    '.cpp': 'cpp',
    '.c': 'c',
    '.h': 'c',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.ipynb': 'python',
};

function sha256(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function getExtension(path) {
    const match = String(path || '').match(/(\.[a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : '';
}

function languageForPath(path) {
    return EXTENSION_LANGUAGE[getExtension(path)] || 'text';
}

function inferBlockType(line) {
    const value = line.trim();
    if (isJsRouteStart(value)) return 'route_handler';
    if (isJsHookStart(value)) return 'hook';
    if (isJsEventStart(value)) return 'event_handler';
    if (isJsTestStart(value)) return 'test';
    if (isJsConfigStart(value)) return 'config';
    if (isJsFactoryInitStart(value)) return 'initialization';
    if (isJsSocketInitStart(value)) return 'initialization';
    if (isPythonRouteDecorator(value) || isJavaRouteAnnotation(value)) return 'route_handler';
    if (/\b(class|interface|struct|enum)\b/.test(value)) return 'class';
    if (/^\s*func\b/.test(value)) return 'function';
    if (/\b(function|def|fn)\b/.test(value)) return 'function';
    if (/=>/.test(value)) return 'function';
    return 'block';
}

function inferSymbolName(line, fallback) {
    const semanticName = inferSemanticSymbolName(line);
    if (semanticName) return semanticName;

    const patterns = [
        /\bclass\s+([A-Za-z_$][\w$]*)/,
        /\binterface\s+([A-Za-z_$][\w$]*)/,
        /\bstruct\s+([A-Za-z_$][\w$]*)/,
        /\benum\s+([A-Za-z_$][\w$]*)/,
        /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
        /\b(?:async\s+)?def\s+([A-Za-z_][\w]*)/,
        /\bfn\s+([A-Za-z_][\w]*)/,
        /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/,
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b/,
        /^\s*(?:public|private|protected|static|async|final|override|virtual|\s)+\s*[A-Za-z0-9_<>,\[\]?]+\s+([A-Za-z_][\w]*)\s*\(/,
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
    ];

    for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match?.[1]) return match[1];
    }

    return fallback;
}

function inferSemanticSymbolName(line) {
    const value = String(line || '').trim();
    const hookAssignment = value.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(use[A-Z][A-Za-z0-9_$]*)\s*\(/);
    if (hookAssignment) return `${hookAssignment[1]} ${hookAssignment[2]}`;

    const hookCall = value.match(/\b(useEffect|useMemo|useCallback|useQuery|useMutation|useReducer|useState|useRef|useContext)\s*\(/);
    if (hookCall) return hookCall[1];

    const eventCall = value.match(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\.\s*(on|once|addEventListener)\s*\(\s*['"`]([^'"`]+)['"`]/);
    if (eventCall) return `${eventCall[1]}.${eventCall[2]} ${eventCall[3]}`;

    const routeCall = value.match(/\b(?:app|router|server|fastify|expressRouter)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*['"`]([^'"`]+)['"`]/i);
    if (routeCall) return `${routeCall[1].toUpperCase()} ${routeCall[2]}`;

    const testCall = value.match(/\b(describe|it|test)\s*\(\s*['"`]([^'"`]+)['"`]/);
    if (testCall) return `${testCall[1]} ${testCall[2]}`;

    const ioInit = value.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*io\s*\(/);
    if (ioInit) return `${ioInit[1]} socket.io client`;

    const factoryInit = value.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/);
    if (factoryInit && isJsFactoryInitStart(value)) return `${factoryInit[1]} ${factoryInit[2]}`;

    const configAssignment = value.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*(?:config|Config|settings|Settings|options|Options|schema|Schema|routes|Routes)[A-Za-z0-9_$]*)\s*=/);
    if (configAssignment) return configAssignment[1];

    const pythonRoute = value.match(/^@\w+(?:\.\w+)*\.(get|post|put|patch|delete|route)\s*\(\s*['"]([^'"]+)['"]/i);
    if (pythonRoute) return `${pythonRoute[1].toUpperCase()} ${pythonRoute[2]}`;

    const javaRoute = value.match(/^@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*(?:\(\s*(?:value\s*=\s*)?["']([^"']+)["'])?/);
    if (javaRoute) return `${javaRoute[1]}${javaRoute[2] ? ` ${javaRoute[2]}` : ''}`;

    return '';
}

function isJsHookStart(value) {
    return (
        /\b(useEffect|useMemo|useCallback|useQuery|useMutation)\s*\(/.test(value) ||
        /^(?:export\s+)?(?:const|let|var)\s+(use[A-Z][A-Za-z0-9_$]*)\b/.test(value) ||
        /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(use[A-Z][A-Za-z0-9_$]*)\s*\(/.test(value)
    );
}

function isJsEventStart(value) {
    return /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\.\s*(on|once|addEventListener)\s*\(/.test(value);
}

function isJsRouteStart(value) {
    return /\b(?:app|router|server|fastify|expressRouter)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(/i.test(value);
}

function isJsTestStart(value) {
    return /\b(describe|it|test)\s*\(\s*['"`]/.test(value);
}

function isJsConfigStart(value) {
    return (
        /^(?:export\s+default|module\.exports)\s*=/.test(value) ||
        /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:config|Config|settings|Settings|options|Options|schema|Schema|routes|Routes)[A-Za-z0-9_$]*\s*=/.test(value)
    );
}

function isJsFactoryInitStart(value) {
    return /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(\s*\{/.test(value);
}

function isJsSocketInitStart(value) {
    return /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*io\s*\(/.test(value);
}

function isPythonRouteDecorator(value) {
    return /^@\w+(?:\.\w+)*\.(get|post|put|patch|delete|route)\s*\(/i.test(value);
}

function isJavaRouteAnnotation(value) {
    return /^@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\b/.test(value);
}

function isSemanticBlockStart(line, language) {
    const value = line.trim();
    if (!value || value.startsWith('//') || value.startsWith('#') || value.startsWith('*')) return false;

    if (['javascript', 'typescript'].includes(language)) {
        return isJsHookStart(value)
            || isJsEventStart(value)
            || isJsRouteStart(value)
            || isJsTestStart(value)
            || isJsConfigStart(value)
            || isJsFactoryInitStart(value)
            || isJsSocketInitStart(value);
    }

    if (language === 'python') return isPythonRouteDecorator(value);

    if (['java', 'csharp', 'kotlin'].includes(language)) return isJavaRouteAnnotation(value);

    return false;
}

function isBlockStart(line, language) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) return false;

    if (language === 'python') {
        return /^(async\s+def|def|class)\s+[A-Za-z_][\w]*/.test(trimmed);
    }

    if (['javascript', 'typescript'].includes(language)) {
        return (
            /^(export\s+default\s+)?(export\s+)?(async\s+)?function\s+[A-Za-z_$][\w$]*/.test(trimmed) ||
            /^(export\s+)?class\s+[A-Za-z_$][\w$]*/.test(trimmed) ||
            /^(export\s+)?(const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(trimmed) ||
            /^(export\s+)?(const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(async\s*)?function\b/.test(trimmed)
        );
    }

    if (language === 'go') return /^func\s+/.test(trimmed);
    if (language === 'rust') return /^(pub\s+)?(async\s+)?fn\s+[A-Za-z_][\w]*/.test(trimmed);
    if (['java', 'csharp', 'cpp', 'c', 'swift', 'kotlin', 'php', 'ruby'].includes(language)) {
        return (
            /\b(class|interface|struct|enum)\s+[A-Za-z_][\w]*/.test(trimmed) ||
            /\)\s*(\{|=>)?\s*$/.test(trimmed) && /\b(public|private|protected|static|func|fun|def|function)\b/.test(trimmed)
        );
    }

    return false;
}

function indentationOf(line) {
    const match = String(line || '').match(/^[\t ]*/);
    return match ? match[0].replace(/\t/g, '    ').length : 0;
}

function isIgnorablePythonLine(line) {
    const trimmed = String(line || '').trim();
    return !trimmed || trimmed.startsWith('#');
}

function findPythonBlockEnd(lines, start) {
    const startIndent = indentationOf(lines[start]);
    let end = Math.min(lines.length, start + MAX_BLOCK_LINES);

    for (let index = start + 1; index < Math.min(lines.length, start + MAX_BLOCK_LINES); index += 1) {
        const line = lines[index];
        if (isIgnorablePythonLine(line)) continue;
        const indent = indentationOf(line);
        if (indent <= startIndent) {
            end = index;
            break;
        }
    }

    return Math.max(start + 1, end);
}

function braceDelta(line) {
    let delta = 0;
    let quote = null;
    let escaped = false;
    const text = String(line || '');

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];
        if (!quote && char === '/' && next === '/') break;
        if (!quote && char === '/' && next === '*') {
            index += 1;
            continue;
        }
        if (quote) {
            if (!escaped && char === quote) quote = null;
            escaped = !escaped && char === '\\';
            continue;
        }
        if (char === '"' || char === "'" || char === '`') {
            quote = char;
            escaped = false;
            continue;
        }
        if (char === '{') delta += 1;
        if (char === '}') delta -= 1;
    }

    return delta;
}

function delimiterDelta(line) {
    const totals = { brace: 0, paren: 0, bracket: 0 };
    let quote = null;
    let escaped = false;
    const text = String(line || '');

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];
        if (!quote && char === '/' && next === '/') break;
        if (!quote && char === '/' && next === '*') {
            index += 1;
            continue;
        }
        if (quote) {
            if (!escaped && char === quote) quote = null;
            escaped = !escaped && char === '\\';
            continue;
        }
        if (char === '"' || char === "'" || char === '`') {
            quote = char;
            escaped = false;
            continue;
        }
        if (char === '{') totals.brace += 1;
        if (char === '}') totals.brace -= 1;
        if (char === '(') totals.paren += 1;
        if (char === ')') totals.paren -= 1;
        if (char === '[') totals.bracket += 1;
        if (char === ']') totals.bracket -= 1;
    }

    return totals;
}

function findBraceBlockEnd(lines, start, nextStart) {
    let depth = 0;
    let sawBrace = false;
    const maxEnd = Math.min(lines.length, start + MAX_BLOCK_LINES);

    for (let index = start; index < maxEnd; index += 1) {
        const delta = braceDelta(lines[index]);
        if (delta !== 0 || String(lines[index]).includes('{')) sawBrace = true;
        depth += delta;
        if (sawBrace && depth <= 0) return index + 1;
    }

    if (!sawBrace) {
        for (let index = start; index < maxEnd; index += 1) {
            if (/[;}]$/.test(lines[index].trim())) return index + 1;
        }
    }

    return sawBrace ? maxEnd : Math.min(nextStart ?? lines.length, maxEnd);
}

function findDelimitedCallEnd(lines, start) {
    const maxEnd = Math.min(lines.length, start + MAX_BLOCK_LINES);
    const depth = { brace: 0, paren: 0, bracket: 0 };
    let sawDelimiter = false;

    for (let index = start; index < maxEnd; index += 1) {
        const line = String(lines[index] || '');
        const delta = delimiterDelta(lines[index]);
        depth.brace += delta.brace;
        depth.paren += delta.paren;
        depth.bracket += delta.bracket;
        if (delta.brace || delta.paren || delta.bracket || /[({[]/.test(line)) sawDelimiter = true;

        if (sawDelimiter && (index > start || /[;)]\s*$/.test(line.trim())) && depth.brace <= 0 && depth.paren <= 0 && depth.bracket <= 0) {
            return index + 1;
        }
    }

    return maxEnd;
}

function findBlockEnd(lines, candidate, nextStart, language) {
    if (candidate.semantic && ['javascript', 'typescript'].includes(language)) return findDelimitedCallEnd(lines, candidate.start);
    if (language === 'python') return findPythonBlockEnd(lines, candidate.start);
    return findBraceBlockEnd(lines, candidate.start, nextStart);
}

function findLeadingDecorators(lines, start, language) {
    if (!['python', 'java', 'csharp', 'kotlin'].includes(language)) return start;
    let index = start - 1;
    let foundDecorator = false;
    while (index >= 0) {
        const trimmed = String(lines[index] || '').trim();
        if (!trimmed && foundDecorator) {
            index -= 1;
            continue;
        }
        if (trimmed.startsWith('@')) {
            foundDecorator = true;
            index -= 1;
            continue;
        }
        break;
    }
    return foundDecorator ? index + 1 : start;
}

function buildBlockCandidates(lines, language) {
    const byStart = new Map();

    lines.forEach((line, index) => {
        if (isBlockStart(line, language)) {
            byStart.set(index, {
                start: index,
                snippetStart: findLeadingDecorators(lines, index, language),
                semantic: false,
            });
        }

        if (isSemanticBlockStart(line, language)) {
            const nextLine = lines[index + 1] || '';
            const isDecoratorOnly = ['python', 'java', 'csharp', 'kotlin'].includes(language) && line.trim().startsWith('@');
            const targetStart = isDecoratorOnly && isBlockStart(nextLine, language) ? index + 1 : index;
            byStart.set(targetStart, {
                start: targetStart,
                snippetStart: index,
                semantic: true,
            });
        }
    });

    return [...byStart.values()].sort((a, b) => a.start - b.start || a.snippetStart - b.snippetStart);
}

function blockLineSpan(block) {
    return Number(block.endLine || 0) - Number(block.startLine || 0) + 1;
}

function isTraceCandidate(block) {
    return ['function', 'class', 'route_handler', 'hook', 'config', 'module'].includes(block.blockType);
}

function attachParentTraces(blocks) {
    return blocks.map(block => {
        const parent = blocks
            .filter(candidate => (
                candidate.filePath === block.filePath &&
                candidate !== block &&
                isTraceCandidate(candidate) &&
                candidate.startLine <= block.startLine &&
                candidate.endLine >= block.endLine &&
                blockLineSpan(candidate) > blockLineSpan(block)
            ))
            .sort((a, b) => (
                blockLineSpan(a) - blockLineSpan(b) ||
                Number(a.startLine || 0) - Number(b.startLine || 0)
            ))[0];

        const trace = parent || block;
        return {
            ...block,
            anchorStartLine: block.startLine,
            anchorEndLine: block.endLine,
            anchorSnippet: block.snippet,
            traceSymbolName: trace.symbolName,
            traceBlockType: trace.blockType,
            traceStartLine: trace.startLine,
            traceEndLine: trace.endLine,
            traceSnippet: trace.snippet,
        };
    });
}

function parseSequentialChunks({ filePath, content, language }) {
    const lines = String(content || '').split(/\r?\n/);
    const totalLines = lines.length;
    const chunkSize = 150;
    const overlap = 30;
    const blocks = [];

    const filename = filePath.split('/').pop() || 'module';

    for (let start = 0; start < totalLines; start += (chunkSize - overlap)) {
        const end = Math.min(totalLines, start + chunkSize);
        const snippet = lines.slice(start, end).join('\n');
        
        if (snippet.trim()) {
            blocks.push({
                filePath,
                language,
                blockType: 'module',
                symbolName: totalLines <= chunkSize ? filename : `${filename} (Lines ${start + 1}-${end})`,
                startLine: start + 1,
                endLine: end,
                snippet,
                anchorStartLine: start + 1,
                anchorEndLine: end,
                anchorSnippet: snippet
            });
        }

        if (end === totalLines) break;
    }
    return blocks;
}

function parseCodeBlocksRegex({ filePath, content }) {
    const language = languageForPath(filePath);
    const lines = String(content || '').split(/\r?\n/);
    const candidates = buildBlockCandidates(lines, language);

    if (candidates.length === 0) {
        return parseSequentialChunks({ filePath, content, language });
    }

    const blocks = candidates.map((candidate, index) => {
        const nextStart = candidates[index + 1]?.start ?? lines.length;
        const endExclusive = findBlockEnd(lines, candidate, nextStart, language);
        const firstLine = lines[candidate.snippetStart] || lines[candidate.start] || '';
        const snippet = lines.slice(candidate.snippetStart, endExclusive).join('\n').slice(0, MAX_SNIPPET_CHARS);
        const fallbackName = `${filePath.split('/').pop() || 'block'}:${candidate.start + 1}`;
        const semanticName = inferSemanticSymbolName(firstLine);
        const baseName = inferSymbolName(lines[candidate.start], fallbackName);
        return {
            filePath,
            language,
            blockType: inferBlockType(firstLine),
            symbolName: semanticName
                ? [semanticName, baseName].filter(Boolean).filter((value, itemIndex, list) => list.indexOf(value) === itemIndex).join(' ')
                : baseName,
            startLine: candidate.snippetStart + 1,
            endLine: endExclusive,
            snippet,
        };
    }).filter(block => block.snippet.trim().length > 20);

    return attachParentTraces(blocks);
}

// Target parse function kept for test-compatibility
// Tries Python LlamaIndex service first, falls back to local regex parser
const PYTHON_CHUNKER_URL = process.env.PYTHON_CHUNKER_URL || 'http://localhost:5002';

async function parseCodeBlocksViaPython({ filePath, content }) {
    const language = languageForPath(filePath);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
        const response = await fetch(`${PYTHON_CHUNKER_URL}/api/chunk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file_path: filePath,
                content: content,
                language: language,
            }),
            signal: controller.signal,
        });

        if (!response.ok) {
            console.warn(`[CodeConcept] Python chunker returned ${response.status} for ${filePath}`);
            return null;
        }

        const data = await response.json();
        if (!data.chunks || data.chunks.length === 0) return null;

        console.log(`[CodeConcept] Python ${data.parser} returned ${data.chunks.length} chunks for ${filePath}`);

        // Convert Python service response to match our block format
        const blocks = data.chunks.map(chunk => ({
            filePath: chunk.file_path,
            language: chunk.language || language,
            blockType: chunk.block_type || 'block',
            symbolName: chunk.symbol_name || filePath.split('/').pop(),
            startLine: chunk.start_line,
            endLine: chunk.end_line,
            snippet: chunk.snippet,
        }));

        return attachParentTraces(blocks);
    } catch (err) {
        if (err.name === 'AbortError') {
            console.warn(`[CodeConcept] Python chunker timed out for ${filePath}`);
        } else {
            console.warn(`[CodeConcept] Python chunker unavailable: ${err.message}`);
        }
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function parseCodeBlocks({ filePath, content }) {
    // Skip Python service if explicitly disabled (e.g., in tests: PYTHON_CHUNKER_URL=none)
    if (PYTHON_CHUNKER_URL && PYTHON_CHUNKER_URL !== 'none') {
        const pythonBlocks = await parseCodeBlocksViaPython({ filePath, content });
        if (pythonBlocks && pythonBlocks.length > 0) {
            return pythonBlocks;
        }
        console.log(`[CodeConcept] Falling back to regex parser for ${filePath}`);
    }

    return parseCodeBlocksRegex({ filePath, content });
}

function toCodeReference(block, score = null, alignment = null) {
    if (!block) return null;
    const traceStartLine = Number(block.traceStartLine || block.startLine || 1);
    const traceEndLine = Number(block.traceEndLine || block.endLine || 1);
    const anchorStartLine = Number(block.anchorStartLine || block.startLine || 1);
    const anchorEndLine = Number(block.anchorEndLine || block.endLine || 1);
    return {
        blockId: String(block._id || block.blockId || ''),
        fileId: String(block.fileId?._id || block.fileId || ''),
        filePath: block.filePath,
        language: block.language || 'text',
        blockType: block.traceBlockType || block.blockType || 'block',
        symbolName: block.traceSymbolName || block.symbolName || 'module',
        startLine: traceStartLine,
        endLine: traceEndLine,
        snippet: block.traceSnippet || block.snippet || '',
        anchorBlockType: block.blockType || 'block',
        anchorSymbolName: block.symbolName || 'module',
        anchorStartLine,
        anchorEndLine,
        anchorSnippet: block.anchorSnippet || block.snippet || '',
        summary: block.summary || '',
        relevance: alignment?.relevance ?? null,
        centrality: alignment?.centrality || null,
        reason: alignment?.reason || '',
        score: score == null ? null : Number(score.toFixed ? score.toFixed(3) : score),
    };
}

async function mapCodeBlocksToConceptsWithLlm({ concepts, blocks, callLlm }) {
    if (!concepts.length || !blocks.length || typeof callLlm !== 'function') {
        return { mappings: [] };
    }

    const conceptsList = concepts.map(concept => ({
        id: concept.id || concept.title,
        title: concept.title,
        description: concept.why_relevant || concept.description || '',
        keywords: concept.keywords || [],
    }));

    const chunksList = blocks.map((block, idx) => ({
        chunk_index: idx,
        file_path: block.filePath,
        symbol_name: block.symbolName,
        code: block.snippet,
    }));

    const prompt = `
Map the provided code chunks to the repository concepts (topics).
For each concept, identify which code chunks implement, define, or consume it.

Concepts:
${JSON.stringify(conceptsList, null, 2)}

Code Chunks:
${JSON.stringify(chunksList, null, 2)}

Instructions:
1. For each concept, find the relevant code chunks from the provided list.
2. Multiple chunks can map to the same concept. A single chunk can map to multiple concepts.
3. For each matched chunk, specify:
   - "chunk_index": The integer index of the matched chunk.
   - "relevance": A score between 0.0 and 1.0.
   - "centrality": "central" (core definition/implementation) or "supporting" (usage, helper, configuration).
   - "reason": A short explanation of why this chunk maps to the concept.
4. Output valid JSON matching the schema below. Do not wrap in markdown or add comments.

JSON Schema:
{
  "mappings": [
    {
      "concept_id": "concept slug or id",
      "matches": [
        {
          "chunk_index": 0,
          "relevance": 0.98,
          "centrality": "central",
          "reason": "explanation of mapping"
        }
      ]
    }
  ]
}
`;

    try {
        console.log(`[CodeConcept] Calling LLM to map ${blocks.length} chunks to ${concepts.length} concepts...`);
        const result = await callLlm(prompt);
        return result || { mappings: [] };
    } catch (err) {
        console.error('[CodeConcept] LLM chunk mapping failed:', err.message);
        return { mappings: [] };
    }
}

function lexicalFallback({ concepts, blocks }) {
    console.log("[CodeConcept] Running lexical fallback parser...");
    const linkedConcepts = [];

    for (const concept of concepts) {
        const queryTerms = [
            concept.title,
            ...(concept.keywords || [])
        ].map(t => String(t).toLowerCase().trim()).filter(Boolean);

        const references = [];
        const seenKeys = new Set();

        for (const block of blocks) {
            const pathLower = String(block.filePath || '').toLowerCase();
            const fileNameLower = (block.filePath?.split('/').pop() || '').toLowerCase();
            const symbolNameLower = String(block.symbolName || '').toLowerCase();
            const snippetLower = String(block.snippet || '').toLowerCase();

            const matchesKeyword = queryTerms.some(term => {
                return snippetLower.includes(term) || 
                       pathLower.includes(term) || 
                       fileNameLower.includes(term) ||
                       symbolNameLower.includes(term);
            });

            if (matchesKeyword) {
                const key = `${block.filePath}:${block.startLine}:${block.endLine}`;

                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    references.push(toCodeReference(block, 0.6, {
                        relevance: 0.6,
                        centrality: 'supporting',
                        reason: 'Matched via code index similarity.'
                    }));

                    if (references.length >= 8) break;
                }
            }
        }

        linkedConcepts.push({
            ...concept,
            code_references: references
        });
    }

    return linkedConcepts;
}

async function limitConcurrency(tasks, limit) {
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

async function ingestRepoCodeEvidence({ userId, repo, sourceFiles = [], callLlm }) {
    const files = sourceFiles
        .filter(file => file?.path && file?.text)
        .slice(0, MAX_FILES_TO_INGEST);

    console.log(`[CodeConcept] Ingesting ${files.length} code files in parallel (concurrency: 15)...`);

    // 1. Ingest files in parallel
    const storedFiles = await limitConcurrency(
        files.map(sourceFile => async () => {
            const language = languageForPath(sourceFile.path);
            const contentHash = sha256(sourceFile.text);
            const lineCount = String(sourceFile.text).split(/\r?\n/).length;

            let repoFile;
            try {
                repoFile = await RepoFile.findOneAndUpdate(
                    {
                        userId,
                        repoFullName: repo.fullName,
                        commitSha: repo.commitSha,
                        filePath: sourceFile.path,
                    },
                    {
                        userId,
                        repoFullName: repo.fullName,
                        repoUrl: repo.url,
                        defaultBranch: repo.defaultBranch,
                        commitSha: repo.commitSha,
                        filePath: sourceFile.path,
                        language,
                        content: sourceFile.text,
                        contentHash,
                        lineCount,
                        updatedAt: new Date(),
                    },
                    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
                );
            } catch (dbErr) {
                console.warn('[CodeConcept] DB file write failed, using fallback in-memory file:', dbErr.message);
                repoFile = {
                    _id: 'mock_file_id_' + contentHash.slice(0, 12),
                    userId,
                    repoFullName: repo.fullName,
                    commitSha: repo.commitSha,
                    filePath: sourceFile.path,
                    language,
                    content: sourceFile.text,
                    contentHash,
                    lineCount,
                };
            }
            return repoFile;
        }),
        15
    );

    console.log(`[CodeConcept] Running AST chunking on ${files.length} files in parallel (concurrency: 15)...`);

    // 2. Parse code blocks for all files in parallel
    const allParsedBlocks = await limitConcurrency(
        files.map((sourceFile, idx) => async () => {
            const repoFile = storedFiles[idx];
            const blocks = await parseCodeBlocks({ filePath: sourceFile.path, content: sourceFile.text });
            return { repoFile, blocks };
        }),
        15
    );

    // 3. Process and write all blocks in parallel
    const saveBlockTasks = [];
    for (const { repoFile, blocks } of allParsedBlocks) {
        if (!blocks) continue;
        for (const block of blocks) {
            const blockHash = sha256(`${repoFile._id}:${block.startLine}:${block.endLine}:${block.snippet}`);
            const vectorId = `block_${userId}_${blockHash.slice(0, 24)}`;
            
            saveBlockTasks.push(async () => {
                let savedBlock;
                try {
                    savedBlock = await RepoCodeBlock.findOneAndUpdate(
                        {
                            userId,
                            repoFullName: repo.fullName,
                            commitSha: repo.commitSha,
                            contentHash: blockHash,
                        },
                        {
                            userId,
                            repoFullName: repo.fullName,
                            repoUrl: repo.url,
                            defaultBranch: repo.defaultBranch,
                            commitSha: repo.commitSha,
                            fileId: repoFile._id,
                            filePath: repoFile.filePath,
                            language: block.language,
                            blockType: block.blockType,
                            symbolName: block.symbolName,
                            startLine: block.startLine,
                            endLine: block.endLine,
                            snippet: block.snippet,
                            anchorStartLine: block.anchorStartLine || block.startLine,
                            anchorEndLine: block.anchorEndLine || block.endLine,
                            anchorSnippet: block.anchorSnippet || block.snippet,
                            traceSymbolName: block.traceSymbolName || block.symbolName,
                            traceBlockType: block.traceBlockType || block.blockType,
                            traceStartLine: block.traceStartLine || block.startLine,
                            traceEndLine: block.traceEndLine || block.endLine,
                            traceSnippet: block.traceSnippet || block.snippet,
                            contentHash: blockHash,
                            summary: block.summary || '',
                            vectorId,
                            updatedAt: new Date(),
                        },
                        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
                    );
                } catch (dbErr) {
                    savedBlock = {
                        _id: 'mock_block_id_' + blockHash.slice(0, 12),
                        fileId: repoFile._id,
                        filePath: repoFile.filePath,
                        language: block.language,
                        blockType: block.blockType,
                        symbolName: block.symbolName,
                        startLine: block.startLine,
                        endLine: block.endLine,
                        snippet: block.snippet,
                        anchorStartLine: block.anchorStartLine || block.startLine,
                        anchorEndLine: block.anchorEndLine || block.endLine,
                        anchorSnippet: block.anchorSnippet || block.snippet,
                        traceSymbolName: block.traceSymbolName || block.symbolName,
                        traceBlockType: block.traceBlockType || block.blockType,
                        traceStartLine: block.traceStartLine || block.startLine,
                        traceEndLine: block.traceEndLine || block.endLine,
                        traceSnippet: block.traceSnippet || block.snippet,
                        contentHash: blockHash,
                        summary: block.summary || '',
                        vectorId,
                    };
                }
                return savedBlock;
            });
        }
    }

    console.log(`[CodeConcept] Writing ${saveBlockTasks.length} code blocks to database in parallel (concurrency: 15)...`);
    const storedBlocks = await limitConcurrency(saveBlockTasks, 15);

    let vectorCount = 0;
    try {
        const { storeRepoCodeBlockEmbeddings } = require('./ragService');
        const embeddableBlocks = storedBlocks.filter(b => b.vectorId);
        if (embeddableBlocks.length > 0) {
            console.log(`[CodeConcept] Storing embeddings for ${embeddableBlocks.length} code blocks in Pinecone...`);
            vectorCount = await storeRepoCodeBlockEmbeddings(embeddableBlocks);
            console.log(`[CodeConcept] Embedded ${vectorCount} code blocks in Pinecone.`);
        }
    } catch (err) {
        console.warn('[CodeConcept] Failed to store code block embeddings:', err.message);
    }

    return {
        fileCount: storedFiles.length,
        blockCount: storedBlocks.length,
        summarizedCount: storedBlocks.length,
        vectorCount,
        files: storedFiles.map(file => ({
            fileId: String(file._id),
            filePath: file.filePath,
            language: file.language,
            lineCount: file.lineCount,
        })),
        blocks: storedBlocks,
    };
}

async function generateExpandedQuery({ concept, languageHint, callLlm }) {
    const title = concept.title;
    const description = concept.why_relevant || concept.description || '';
    const keywords = Array.isArray(concept.keywords) ? concept.keywords : [];
    const languages = languageHint || 'javascript, typescript, python';

    if (typeof callLlm !== 'function') {
        return [title, ...keywords.slice(0, 2)].join(' ');
    }

    const prompt = `You are a code search query generator. Given a software concept, produce keywords and code patterns that a developer would find in source code implementing this concept.

Concept Title: "${title}"
Description: "${description}"
Candidate Keywords: ${JSON.stringify(keywords)}
Repository languages: ${languages}

Instructions:
1. Review the concept title, description, and all candidate keywords to fully understand the software concept.
2. Select only the most specific, critical, and high-signal terms/patterns to build the search query. Avoid generic terms and do not dump all candidate keywords into the output to prevent search pollution.
3. Keep the lists concise: generate at most 20 highly relevant terms for "semantic_terms" and at most 20 patterns for "code_patterns". Do not repeat terms or generate redundant variations of the same root word.
4. Generate:
   - "semantic_terms": array of highly specific natural language terms (maximum 20).
   - "code_patterns": array of specific code signatures, variables, function patterns, or API calls (maximum 20).

You MUST respond with valid, complete JSON only. No markdown, no commentary.`;

    try {
        const result = await callLlm(prompt);
        if (result) {
            const terms = Array.isArray(result.semantic_terms) ? result.semantic_terms : [];
            const patterns = Array.isArray(result.code_patterns) ? result.code_patterns : [];
            const queryParts = [...terms, ...patterns].filter(Boolean);
            if (queryParts.length > 0) {
                return queryParts.join(' ');
            }
        }
    } catch (err) {
        console.warn(`[CodeConcept] Failed to generate expanded query for concept "${title}":`, err.message);
    }
    return [title, ...keywords.slice(0, 2)].join(' ');
}

async function linkConceptsToCode({ userId, repo, concepts = [], blocks = [], callLlm }) {
    if (!concepts.length) return [];

    let allBlocks = [];
    if (blocks && blocks.length > 0) {
        allBlocks = blocks;
    } else {
        let dbFiles = [];
        try {
            dbFiles = await RepoFile.find({
                userId,
                repoFullName: repo.fullName,
                commitSha: repo.commitSha
            }).lean();
        } catch (dbErr) {
            console.warn('[CodeConcept] DB files fetch failed, cannot parse blocks:', dbErr.message);
        }

        for (const file of dbFiles) {
            const fileBlocks = await parseCodeBlocks({ filePath: file.filePath, content: file.content });
            for (const block of fileBlocks) {
                const blockHash = sha256(`${file._id}:${block.startLine}:${block.endLine}:${block.snippet}`);
                const vectorId = `block_${userId}_${blockHash.slice(0, 24)}`;
                let savedBlock;
                try {
                    savedBlock = await RepoCodeBlock.findOneAndUpdate(
                        {
                            userId,
                            repoFullName: repo.fullName,
                            commitSha: repo.commitSha,
                            contentHash: blockHash,
                        },
                        {
                            userId,
                            repoFullName: repo.fullName,
                            repoUrl: repo.url,
                            defaultBranch: repo.defaultBranch,
                            commitSha: repo.commitSha,
                            fileId: file._id,
                            filePath: file.filePath,
                            language: block.language,
                            blockType: block.blockType,
                            symbolName: block.symbolName,
                            startLine: block.startLine,
                            endLine: block.endLine,
                            snippet: block.snippet,
                            anchorStartLine: block.anchorStartLine || block.startLine,
                            anchorEndLine: block.anchorEndLine || block.endLine,
                            anchorSnippet: block.anchorSnippet || block.snippet,
                            traceSymbolName: block.traceSymbolName || block.symbolName,
                            traceBlockType: block.traceBlockType || block.blockType,
                            traceStartLine: block.traceStartLine || block.startLine,
                            traceEndLine: block.traceEndLine || block.endLine,
                            traceSnippet: block.traceSnippet || block.snippet,
                            contentHash: blockHash,
                            summary: block.summary || '',
                            vectorId,
                            updatedAt: new Date(),
                        },
                        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
                    );
                } catch (dbErr) {
                    savedBlock = {
                        _id: 'mock_block_id_' + blockHash.slice(0, 12),
                        fileId: file._id,
                        filePath: file.filePath,
                        language: block.language,
                        blockType: block.blockType,
                        symbolName: block.symbolName,
                        startLine: block.startLine,
                        endLine: block.endLine,
                        snippet: block.snippet,
                        anchorStartLine: block.anchorStartLine || block.startLine,
                        anchorEndLine: block.anchorEndLine || block.endLine,
                        anchorSnippet: block.anchorSnippet || block.snippet,
                        traceSymbolName: block.traceSymbolName || block.symbolName,
                        traceBlockType: block.traceBlockType || block.blockType,
                        traceStartLine: block.traceStartLine || block.startLine,
                        traceEndLine: block.traceEndLine || block.endLine,
                        traceSnippet: block.traceSnippet || block.snippet,
                        contentHash: blockHash,
                        summary: block.summary || '',
                        vectorId,
                    };
                }
                allBlocks.push(savedBlock);
            }
        }
    }

    if (!allBlocks.length) {
        return concepts.map(c => ({ ...c, code_references: [] }));
    }

    const linkedConcepts = [];
    const isPineconeActive = !!process.env.PINECONE_API_KEY;

    if (isPineconeActive) {
        console.log(`[CodeConcept] Pinecone active. Retrieving code links via vector search...`);
        const { retrieveRepoCodeMatches } = require('./ragService');

        for (const concept of concepts) {
            let queryText = '';
            try {
                queryText = await generateExpandedQuery({
                    concept,
                    languageHint: repo.language || 'javascript, typescript, python',
                    callLlm
                });

                console.log(`[CodeConcept] Searching Pinecone for concept "${concept.title}" with query: "${queryText}"`);
                const matches = await retrieveRepoCodeMatches({
                    userId,
                    repoFullName: repo.fullName,
                    commitSha: repo.commitSha,
                    query: queryText,
                    topK: 100,
                    minScore: 0.6,
                });

                if (matches && matches.length > 0) {
                    const blockIds = matches.map(m => m.blockId).filter(Boolean);
                    const dbBlocks = await RepoCodeBlock.find({ _id: { $in: blockIds } }).lean();
                    const dbBlocksMap = new Map(dbBlocks.map(b => [String(b._id), b]));

                    const references = [];
                    for (const match of matches) {
                        const block = dbBlocksMap.get(String(match.blockId));
                        if (!block) continue;

                        references.push(toCodeReference(block, match.score, {
                            relevance: match.score,
                            centrality: ['class', 'function', 'route_handler'].includes(block.blockType) ? 'central' : 'supporting',
                            reason: `Retrieved via vector similarity search.`
                        }));
                    }

                    if (references.length > 0) {
                        linkedConcepts.push({
                            ...concept,
                            search_query: queryText,
                            code_references: references,
                        });
                        continue;
                    }
                }
            } catch (err) {
                console.warn(`[CodeConcept] Semantic retrieval failed for concept "${concept.title}":`, err.message);
            }

            console.log(`[CodeConcept] Falling back to lexical matching for concept "${concept.title}"`);
            const fallback = lexicalFallback({ concepts: [concept], blocks: allBlocks })[0];
            linkedConcepts.push({
                ...fallback,
                search_query: queryText || `${concept.title} ${concept.keywords?.join(' ') || ''}`.trim()
            });
        }
    } else {
        console.log(`[CodeConcept] Pinecone not active. Falling back to LLM mapping prompt...`);
        const mappingResult = await mapCodeBlocksToConceptsWithLlm({ concepts, blocks: allBlocks, callLlm });
        const mappings = Array.isArray(mappingResult?.mappings) ? mappingResult.mappings : [];

        if (mappings.length === 0) {
            return lexicalFallback({ concepts, blocks: allBlocks });
        }

        const mappingByConceptId = new Map(mappings.map(m => [m.concept_id, m.matches || []]));

        for (const concept of concepts) {
            let matches = mappingByConceptId.get(concept.id);
            if (!matches) {
                matches = mappingByConceptId.get(concept.title) || [];
            }

            const references = [];
            for (const match of matches) {
                const idx = Number(match.chunk_index);
                const block = allBlocks[idx];
                if (!block) continue;

                references.push(toCodeReference(block, match.relevance, {
                    relevance: match.relevance || 0.8,
                    centrality: match.centrality || 'supporting',
                    reason: match.reason || 'Mapped via LLM chunk classification.'
                }));
            }

            if (references.length === 0) {
                const fallback = lexicalFallback({ concepts: [concept], blocks: allBlocks })[0];
                linkedConcepts.push(fallback);
            } else {
                linkedConcepts.push({
                    ...concept,
                    code_references: references.slice(0, MAX_CODE_REFERENCES_PER_CONCEPT)
                });
            }
        }
    }

    return linkedConcepts;
}

async function ingestAndLinkRepoCode({ userId, repo, sourceFiles, concepts, callLlm, codeGraph = null }) {
    const ingestion = await ingestRepoCodeEvidence({ userId, repo, sourceFiles, callLlm });
    const linkedConcepts = await linkConceptsToCode({
        userId,
        repo,
        concepts,
        blocks: ingestion.blocks,
        callLlm,
    });

    const blockCount = linkedConcepts.reduce((acc, c) => acc + (c.code_references?.length || 0), 0);

    return {
        ingestion: {
            fileCount: ingestion.fileCount,
            blockCount,
            summarizedCount: blockCount,
            vectorCount: ingestion.vectorCount,
        },
        codeFiles: ingestion.files,
        concepts: linkedConcepts,
    };
}

module.exports = {
    parseCodeBlocks,
    ingestRepoCodeEvidence,
    linkConceptsToCode,
    ingestAndLinkRepoCode,
};
