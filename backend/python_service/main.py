"""
Python FastAPI microservice for AST-based code chunking using tree-sitter.
Runs on port 5002 alongside the Node.js Express backend (port 5001).

Uses tree-sitter-language-pack for grammar bindings (v0.25+ API).
LlamaIndex CodeSplitter is incompatible with tree-sitter v0.25, so we
implement our own AST-aware splitter that understands code structure.
"""

import os
import re
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="[PythonChunker] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# tree-sitter imports
# ---------------------------------------------------------------------------
_tree_sitter_available = False

try:
    from tree_sitter_language_pack import get_parser

    _tree_sitter_available = True
    logger.info("tree-sitter-language-pack loaded successfully (v0.25+ API).")
except ImportError as exc:
    logger.warning(
        "tree-sitter-language-pack not available (%s). "
        "Falling back to line-based splitting.",
        exc,
    )

# ---------------------------------------------------------------------------
# Language mapping (file extension → tree-sitter grammar name)
# ---------------------------------------------------------------------------
EXTENSION_TO_TS_LANGUAGE: dict[str, str] = {
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".py": "python",
    ".java": "java",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".php": "php",
    ".cs": "c_sharp",
    ".cpp": "cpp",
    ".c": "c",
    ".h": "c",
    ".swift": "swift",
    ".kt": "kotlin",
}

# Friendly language label → tree-sitter grammar name
LANGUAGE_TO_TS: dict[str, str] = {
    "javascript": "javascript",
    "typescript": "typescript",
    "python": "python",
    "java": "java",
    "go": "go",
    "rust": "rust",
    "ruby": "ruby",
    "php": "php",
    "csharp": "c_sharp",
    "c_sharp": "c_sharp",
    "cpp": "cpp",
    "c": "c",
    "swift": "swift",
    "kotlin": "kotlin",
}

# AST node kinds that represent top-level code blocks worth extracting
BLOCK_KINDS: set[str] = {
    # Functions
    "function_declaration",
    "function_definition",
    "method_definition",
    "method_declaration",
    "arrow_function",
    "generator_function_declaration",
    "async_function_declaration",
    # Classes
    "class_declaration",
    "class_definition",
    "interface_declaration",
    "struct_item",
    "enum_declaration",
    "enum_item",
    # Statements that wrap route handlers, hooks, exports, etc.
    "expression_statement",
    "lexical_declaration",
    "variable_declaration",
    "assignment_statement",
    "export_statement",
    "decorated_definition",
    # Go / Rust
    "function_item",
    "impl_item",
    "type_declaration",
}

# Node kinds that should always be extracted as standalone blocks
ALWAYS_EXTRACT: set[str] = {
    "function_declaration",
    "function_definition",
    "method_definition",
    "method_declaration",
    "class_declaration",
    "class_definition",
    "interface_declaration",
    "function_item",
    "impl_item",
    "decorated_definition",
    "export_statement",
}


def _resolve_ts_language(file_path: str, language_hint: str | None) -> str | None:
    """Resolve a tree-sitter grammar name from file extension or language hint."""
    ext = os.path.splitext(file_path)[1].lower()
    ts_lang = EXTENSION_TO_TS_LANGUAGE.get(ext)
    if ts_lang:
        return ts_lang
    if language_hint:
        return LANGUAGE_TO_TS.get(language_hint.lower())
    return None


# ---------------------------------------------------------------------------
# Block-type / symbol-name inference helpers
# ---------------------------------------------------------------------------

_BLOCK_TYPE_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("route_handler", re.compile(r"\b(?:app|router|server|fastify)\s*\.\s*(?:get|post|put|patch|delete|all|use)\s*\(", re.I)),
    ("route_handler", re.compile(r"^@\w+(?:\.\w+)*\.(?:get|post|put|patch|delete|route)\s*\(", re.I)),
    ("route_handler", re.compile(r"^@(?:GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\b")),
    ("hook", re.compile(r"\b(?:useEffect|useMemo|useCallback|useQuery|useMutation|useReducer|useState|useRef|useContext)\s*\(")),
    ("event_handler", re.compile(r"\.\s*(?:on|once|addEventListener)\s*\(")),
    ("test", re.compile(r"\b(?:describe|it|test)\s*\(\s*['\"`]")),
    ("class", re.compile(r"\b(?:class|interface|struct|enum)\s+[A-Za-z_]")),
    ("function", re.compile(r"\b(?:function|def|fn|func)\s+[A-Za-z_]")),
    ("function", re.compile(r"=>")),
]

_SYMBOL_PATTERNS: list[re.Pattern] = [
    re.compile(r"\bclass\s+([A-Za-z_$][\w$]*)"),
    re.compile(r"\binterface\s+([A-Za-z_$][\w$]*)"),
    re.compile(r"\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"),
    re.compile(r"\b(?:async\s+)?def\s+([A-Za-z_][\w]*)"),
    re.compile(r"\bfn\s+([A-Za-z_][\w]*)"),
    re.compile(r"^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)"),
    re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>"),
    re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b"),
    re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*="),
]


def _infer_block_type(text: str) -> str:
    first_line = text.strip().split("\n", 1)[0]
    for btype, pat in _BLOCK_TYPE_PATTERNS:
        if pat.search(first_line):
            return btype
    return "block"


def _infer_symbol_name(text: str, fallback: str) -> str:
    first_line = text.strip().split("\n", 1)[0]
    for pat in _SYMBOL_PATTERNS:
        m = pat.search(first_line)
        if m:
            return m.group(1)
    return fallback


def _kind_to_block_type(kind: str) -> str:
    """Map tree-sitter node kind to our block type taxonomy."""
    if "class" in kind or "interface" in kind or "struct" in kind or "enum" in kind:
        return "class"
    if "function" in kind or "method" in kind:
        return "function"
    if kind == "decorated_definition":
        return "function"
    return "block"


# ---------------------------------------------------------------------------
# AST-based chunking with tree-sitter v0.25+
# ---------------------------------------------------------------------------

MAX_CHUNK_LINES = 120
MAX_CHARS = 14000
MIN_CHUNK_CHARS = 20


def _extract_ast_chunks(content: str, ts_language: str, file_path: str) -> list[dict]:
    """
    Parse content using tree-sitter and extract top-level AST nodes as chunks.

    Strategy:
    1. Parse the file into an AST.
    2. Walk top-level children of the root (program) node.
    3. Group consecutive small statements (imports, requires, assignments)
       into a single "preamble" chunk.
    4. Extract each function/class/route-handler as its own chunk.
    5. If a chunk exceeds MAX_CHUNK_LINES, split it into sub-chunks.
    """
    parser = get_parser(ts_language)
    tree = parser.parse(content)
    root = tree.root_node()

    filename = os.path.basename(file_path) or "module"
    chunks: list[dict] = []
    preamble_lines: list[tuple[int, int]] = []  # (start_byte, end_byte) pairs

    child_count = root.child_count()

    for i in range(child_count):
        child = root.child(i)
        kind = child.kind()
        start_row = child.start_position().row
        end_row = child.end_position().row
        start_byte = child.start_byte()
        end_byte = child.end_byte()
        text = content[start_byte:end_byte]
        line_count = end_row - start_row + 1

        # Skip trivial nodes (empty, comments)
        if len(text.strip()) < MIN_CHUNK_CHARS:
            continue

        # Is this a "significant" block worth extracting on its own?
        is_significant = (
            kind in ALWAYS_EXTRACT
            or line_count >= 3
            or _infer_block_type(text) in ("route_handler", "hook", "event_handler", "test", "class", "function")
        )

        if not is_significant:
            # Accumulate into preamble group
            preamble_lines.append((start_byte, end_byte, start_row, end_row))
            continue

        # Flush any accumulated preamble before this block
        if preamble_lines:
            _flush_preamble(preamble_lines, content, file_path, ts_language, filename, chunks)
            preamble_lines = []

        # Extract this node as a chunk
        if line_count > MAX_CHUNK_LINES:
            # Large block: split into sub-chunks of MAX_CHUNK_LINES with overlap
            _split_large_chunk(text, start_row, file_path, ts_language, filename, chunks)
        else:
            block_type = _infer_block_type(text)
            if block_type == "block":
                block_type = _kind_to_block_type(kind)
            fallback_name = f"{filename}:{start_row + 1}"
            symbol_name = _infer_symbol_name(text, fallback_name)

            chunks.append({
                "file_path": file_path,
                "language": ts_language,
                "block_type": block_type,
                "symbol_name": symbol_name,
                "start_line": start_row + 1,
                "end_line": end_row + 1,
                "snippet": text[:MAX_CHARS],
            })

    # Flush trailing preamble
    if preamble_lines:
        _flush_preamble(preamble_lines, content, file_path, ts_language, filename, chunks)

    logger.info(
        "AST splitter produced %d chunks for %s (%s)", len(chunks), file_path, ts_language
    )
    return chunks


def _flush_preamble(
    preamble_lines: list[tuple],
    content: str,
    file_path: str,
    ts_language: str,
    filename: str,
    chunks: list[dict],
) -> None:
    """Merge accumulated preamble/import statements into a single chunk."""
    if not preamble_lines:
        return
    start_byte = preamble_lines[0][0]
    end_byte = preamble_lines[-1][1]
    start_row = preamble_lines[0][2]
    end_row = preamble_lines[-1][3]
    text = content[start_byte:end_byte]
    if text.strip():
        chunks.append({
            "file_path": file_path,
            "language": ts_language,
            "block_type": "module",
            "symbol_name": f"{filename} imports/setup",
            "start_line": start_row + 1,
            "end_line": end_row + 1,
            "snippet": text[:MAX_CHARS],
        })


def _split_large_chunk(
    text: str,
    base_start_row: int,
    file_path: str,
    ts_language: str,
    filename: str,
    chunks: list[dict],
) -> None:
    """Split a large AST node into sub-chunks with overlap."""
    lines = text.split("\n")
    total = len(lines)
    overlap = 15
    start = 0

    while start < total:
        end = min(total, start + MAX_CHUNK_LINES)
        snippet = "\n".join(lines[start:end])
        if snippet.strip():
            block_type = _infer_block_type(snippet)
            fallback_name = f"{filename}:{base_start_row + start + 1}"
            symbol_name = _infer_symbol_name(snippet, fallback_name)

            chunks.append({
                "file_path": file_path,
                "language": ts_language,
                "block_type": block_type,
                "symbol_name": symbol_name,
                "start_line": base_start_row + start + 1,
                "end_line": base_start_row + end,
                "snippet": snippet[:MAX_CHARS],
            })
        start += MAX_CHUNK_LINES - overlap
        if end == total:
            break


def _chunk_fallback(content: str, file_path: str, language: str) -> list[dict]:
    """Simple line-based chunking fallback for unsupported languages."""
    lines = content.split("\n")
    total = len(lines)
    chunk_size = 120
    overlap = 20
    filename = os.path.basename(file_path) or "module"
    chunks = []

    start = 0
    while start < total:
        end = min(total, start + chunk_size)
        snippet = "\n".join(lines[start:end])
        if snippet.strip():
            chunks.append({
                "file_path": file_path,
                "language": language or "text",
                "block_type": "module",
                "symbol_name": (
                    filename
                    if total <= chunk_size
                    else f"{filename} (Lines {start + 1}-{end})"
                ),
                "start_line": start + 1,
                "end_line": end,
                "snippet": snippet[:MAX_CHARS],
            })
        start += chunk_size - overlap
        if end == total:
            break

    logger.info("Fallback splitter produced %d chunks for %s", len(chunks), file_path)
    return chunks


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="LlamaIndex Code Chunker",
    description="AST-based code chunking microservice using tree-sitter",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChunkRequest(BaseModel):
    file_path: str
    content: str
    language: Optional[str] = Field(
        default=None,
        description="Language hint (e.g. 'javascript', 'python'). Auto-detected from file extension if omitted.",
    )


class ChunkInfo(BaseModel):
    file_path: str
    language: str
    block_type: str
    symbol_name: str
    start_line: int
    end_line: int
    snippet: str


class ChunkResponse(BaseModel):
    chunks: list[ChunkInfo]
    parser: str = Field(description="Which parser was used: 'ast' or 'fallback'")
    language_detected: str


class HealthResponse(BaseModel):
    status: str
    ast_parser_available: bool
    supported_languages: list[str]


@app.get("/health", response_model=HealthResponse)
def health_check():
    return HealthResponse(
        status="ok",
        ast_parser_available=_tree_sitter_available,
        supported_languages=sorted(LANGUAGE_TO_TS.keys()),
    )


@app.post("/api/chunk", response_model=ChunkResponse)
def chunk_code(req: ChunkRequest):
    if not req.content or not req.content.strip():
        raise HTTPException(status_code=400, detail="Content must not be empty.")

    ts_lang = _resolve_ts_language(req.file_path, req.language)
    detected = ts_lang or req.language or "text"

    if _tree_sitter_available and ts_lang:
        try:
            chunks = _extract_ast_chunks(req.content, ts_lang, req.file_path)
            if chunks:
                return ChunkResponse(
                    chunks=chunks, parser="ast", language_detected=detected
                )
        except Exception as exc:
            logger.warning(
                "AST parser failed for %s (%s): %s — falling back",
                req.file_path,
                ts_lang,
                exc,
            )

    # Fallback
    chunks = _chunk_fallback(req.content, req.file_path, detected)
    return ChunkResponse(
        chunks=chunks, parser="fallback", language_detected=detected
    )


# ---------------------------------------------------------------------------
# Batch endpoint — chunk multiple files in one request
# ---------------------------------------------------------------------------

class BatchChunkRequest(BaseModel):
    files: list[ChunkRequest]


class BatchChunkResponse(BaseModel):
    results: list[ChunkResponse]


@app.post("/api/chunk/batch", response_model=BatchChunkResponse)
def chunk_code_batch(req: BatchChunkRequest):
    results = []
    for file_req in req.files:
        try:
            result = chunk_code(file_req)
            results.append(result)
        except HTTPException:
            results.append(
                ChunkResponse(chunks=[], parser="error", language_detected="unknown")
            )
    return BatchChunkResponse(results=results)


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("CHUNKER_PORT", 5002))
    logger.info("Starting AST Code Chunker on port %d...", port)
    uvicorn.run(app, host="0.0.0.0", port=port)
