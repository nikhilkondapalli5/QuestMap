#!/usr/bin/env bash
# Setup script for the LlamaIndex Code Chunking microservice.
# Usage: cd backend/python_service && bash setup.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== LlamaIndex Code Chunker — Setup ==="

# 1. Create virtual environment
if [ ! -d "venv" ]; then
    echo "[1/3] Creating Python virtual environment..."
    python3 -m venv venv
else
    echo "[1/3] Virtual environment already exists."
fi

# 2. Activate and install dependencies
echo "[2/3] Installing dependencies..."
source venv/bin/activate
pip install --upgrade pip -q
pip install -r requirements.txt -q

# 3. Validate imports
echo "[3/3] Validating imports..."
python3 -c "
from fastapi import FastAPI
print('  ✓ FastAPI')
try:
    from llama_index.core.node_parser import CodeSplitter
    print('  ✓ LlamaIndex CodeSplitter')
except ImportError as e:
    print(f'  ✗ LlamaIndex CodeSplitter: {e}')
try:
    from tree_sitter_language_pack import get_language, get_parser
    print('  ✓ tree-sitter-language-pack')
except ImportError as e:
    print(f'  ✗ tree-sitter-language-pack: {e}')
import uvicorn
print('  ✓ Uvicorn')
"

echo ""
echo "=== Setup complete! ==="
echo "Start the service with:"
echo "  cd $SCRIPT_DIR && source venv/bin/activate && python main.py"
echo "Or use 'npm run dev:all' from the backend directory."
