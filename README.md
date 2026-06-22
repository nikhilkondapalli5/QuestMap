# 🗺️ QuestMap AI: RAG-Powered Personalized Learning & Code Explorer

QuestMap is an educational platform that transforms source documents and code repositories into interactive, personalized learning journeys. By leveraging **Retrieval-Augmented Generation (RAG)**, QuestMap grounds its AI tutor in your specific source materials to align the learning path, practice quizzes, and recommended resources with your curriculum or codebase.

![QuestMap Dashboard](/Users/konda/.gemini/antigravity/brain/2bb2f111-a840-4d23-83e3-c9dd39749c41/final_dashboard_personalization_1772973507895.png)
*(Note: Visual asset paths are configured locally; update to relative or hosting URLs for remote deployment)*

## 🚀 Key Features

### 🧠 Adaptive Knowledge Maps
Visualize your learning journey. QuestMap processes your goals, background, and uploaded documents to generate a structured, interactive map of sub-topics.

### 💻 GitHub Repository Code Explorer
Analyze code repositories. QuestMap parses your codebase, generates abstract syntax tree (AST) code chunks, indexes them semantically in Pinecone, and maps files to conceptual learning nodes. Users can explore a custom, interactive IDE-like flat file tree, highlight matching line ranges, navigate snippets with previous/next buttons, and resize the code editor window dynamically.

### 📚 Strict RAG Grounding
QuestMap uses Retrieval-Augmented Generation (RAG) to ground practice questions and recommendations in the concepts found in your uploaded PDFs, notes, and code.

### 🛡️ RAG Relevance Guard & Code Threshold
QuestMap applies a semantic threshold filter and exclusions for virtual environments (`venv`, `.venv`) or configuration files to maintain relevance between document context and the active learning quest.

### ⚡ Parallelized Learning Flow & API Optimization
Our backend processes RAG retrieval, practice generation, and resource curation in parallel to optimize response times. YouTube recommendations are capped to at most 2 videos per channel to avoid repetitive listings.

### 🎯 Smart Filtering
The pipeline identifies and filters out bibliographies, citations, and metadata during document chunking to focus the context on educational content.

---

## 🛠️ Tech Stack

**Frontend:**
- **React (Vite)**: Web frontend framework.
- **Framer Motion**: For fluid animations and transitions.
- **Lucide Icons**: For a modern, clean design system.
- **Tailwind CSS**: For responsive and sleek styling.

**Backend:**
- **Node.js & Express**: API web server layer.
- **Python AST Service**: FastAPI service utilizing `tree-sitter` for syntactic code chunking.
- **Pinecone Vector DB**: Vector database for RAG retrieval and semantic code searches.
- **Google Gemini 1.5 Pro/Flash**: Language models used for generating knowledge maps, query expansions, and grounding.
- **MongoDB Atlas**: Persistent storage for user profiles, files, and quest history.

---

## 🏗️ Architecture: The RAG & Code Ingestion Pipeline

1.  **Ingestion & Parsing**: PDFs/DOCX/TXT files are parsed and cleaned. Codebases are parsed dynamically, excluding virtual environments.
2.  **AST Semantic Chunking**: Code files are syntactically chunked into functions, classes, and handlers using the Python `tree-sitter` service.
3.  **Vector Embedding**: Chunks and snippets are converted into 3072-dimensional vectors using Gemini Embeddings.
4.  **Query-Expanded Retrieval**: Concept terms undergo Gemini-driven query expansion. Pinecone matches search vectors using a strict **0.6 similarity filter** to retrieve relevant code blocks.
5.  **Interactive Code Tree & Viewer**: Results are displayed in a borderless IDE-like file tree. Clickable keywords bar filters matches dynamically. Double-click loads full files (auto-loaded for multi-snippet files) with line scroll-centering.

---

## 📂 Project Structure

```text
├── backend/                  # Express server & RAG services
│   ├── server.js             # Main API entry point & search routes
│   ├── ragService.js         # Pinecone & Embedding logic
│   ├── codeConceptService.js # Code semantic linkage & query expansion
│   ├── repoAnalyzerService.js# Repository directory structure analyzer
│   ├── fileParser.js         # PDF/Docx text extraction
│   ├── python_service/       # Python AST tree-sitter chunker service
│   │   ├── main.py           # FastAPI entrypoint
│   │   ├── setup.sh          # Virtual environment builder script
│   │   └── requirements.txt  # Python package requirements
│   └── models/               # Mongoose schemas
├── frontend/                 # React application
│   ├── src/pages/            # Dashboard, LevelQuiz, and Profile views
│   ├── src/components/       # RepoLearningPanel, ResourcePanel, and Maps
│   └── src/lib/              # API and Auth utilities
```

---

## ⚙️ Setup & Installation

### Prerequisites
- Node.js (v18+)
- Python (v3.9+)
- MongoDB Atlas account
- Pinecone account & API Key
- Google AI (Gemini) API Key

### Installation

1.  **Clone the Repository**
    ```bash
    git clone https://github.com/nikhilkondapalli5/QuestMap.git
    cd QuestMap
    ```

2.  **Backend & Python Service Setup**
    ```bash
    cd backend
    npm install
    
    # Set up and activate the Python AST chunker virtual environment
    cd python_service
    chmod +x setup.sh
    ./setup.sh
    
    # Create a .env file in the backend/ folder with your API keys
    # See backend/.env.example for required keys (GEMINI_API_KEY, PINECONE_API_KEY, MONGO_URI)
    ```

3.  **Running the Dev Environment**
    - To run both Node.js API and Python Chunker concurrently:
      ```bash
      # From the backend directory
      npm run dev:all
      ```
    - Or run them individually:
      ```bash
      # Tab 1: Node.js
      npm run dev
      
      # Tab 2: Python Chunker
      npm run dev:python
      ```

4.  **Frontend Setup**
    ```bash
    cd ../frontend
    npm install
    npm run dev
    ```

---

## 📺 Demo Snapshots

| Feature | Visual Evidence |
| :--- | :--- |
| **Interactive Map** | ![Dashboard Map](/Users/konda/.gemini/antigravity/brain/2bb2f111-a840-4d23-83e3-c9dd39749c41/final_dashboard_personalization_1772973507895.png) |
| **Practice Grounding** | ![Practice Panels](/Users/konda/.gemini/antigravity/brain/2bb2f111-a840-4d23-83e3-c9dd39749c41/dashboard_practice_content_1772941954570.png) |
| **RAG Ingestion** | ![File Upload](/Users/konda/.gemini/antigravity/brain/2bb2f111-a840-4d23-83e3-c9dd39749c41/rag_categorized_upload_test_1772973077268.webp) |
