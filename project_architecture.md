# QuestMap: System Architecture Diagram

This document contains a comprehensive system architecture description and interactive Mermaid diagrams representing the components and data flows of the **QuestMap** project. You can copy and paste the Mermaid code directly into your GitHub repository's `README.md` or wiki.

---

## 1. High-Level System Architecture

This diagram shows how the React frontend, Node.js backend, Python service, databases, and third-party APIs connect.

```mermaid
graph TD
    %% Frontend Layer
    subgraph Frontend [React + Vite App]
        UI[Dashboard & Learning Map]
        ResPanel[Resource Panel / Code Viewer]
        PracPanel[Practice & Drill Panel]
    end

    %% Backend Layer
    subgraph Backend [Node.js Express Server]
        API[API Endpoints]
        Cron[RSS Sync Cron Job]
        LLMService[Gemini Integration Service]
        RAG[RAG & Vector Retrieval Service]
    end

    subgraph Chunker [Python AST Service]
        PyService[FastAPI/Flask Parser]
        AST[AST Symbol Parser]
    end

    %% Storage Layer
    subgraph Databases [Storage & Retrieval Layer]
        Mongo[(MongoDB Atlas)]
        Supa[(Supabase PostgreSQL)]
        Pine[(Pinecone Vector DB)]
    end

    %% Third-Party API Layer
    subgraph ThirdPartyAPIs [External APIs]
        Gemini[Google Gemini API]
        YouTube[YouTube Data API]
    end

    %% Connections
    UI <-->|HTTP / REST| API
    API <-->|HTTP| PyService
    PyService === AST
    
    %% DB Read/Writes
    API ===|Cache Profile & Map| Mongo
    API ===|Relational / YouTube Cache| Supa
    API ===|Vector Similarity Search| Pine
    Cron ===|RSS Feed Checks| Supa
    
    %% API Integrations
    LLMService <-->|Generative AI Tasks| Gemini
    RAG <-->|Gemini Embeddings| Gemini
    API <-->|OAuth Bearer / API Key| YouTube
    
    %% Styling
    classDef frontend fill:#1e1e30,stroke:#3b82f6,stroke-width:2px,color:#fff;
    classDef backend fill:#111827,stroke:#10b981,stroke-width:2px,color:#fff;
    classDef chunker fill:#374151,stroke:#f59e0b,stroke-width:2px,color:#fff;
    classDef storage fill:#1f2937,stroke:#8b5cf6,stroke-width:2px,color:#fff;
    classDef thirdparty fill:#0f172a,stroke:#ef4444,stroke-width:2px,color:#fff;

    class UI,ResPanel,PracPanel frontend;
    class API,Cron,LLMService,RAG backend;
    class PyService,AST chunker;
    class Mongo,Supa,Pine storage;
    class Gemini,YouTube thirdparty;
```

---

## 2. Key Data Flows

### A. Repository Scanning & Code Evidence Indexing

When a user links a GitHub repository, this flow runs to parse files, calculate embeddings, and index the codebase:

```mermaid
sequenceDiagram
    autonumber
    participant UI as React Frontend
    participant Server as Express Backend
    participant Py as Python AST Service
    participant Gemini as Gemini API
    participant Mongo as MongoDB Atlas
    participant Pine as Pinecone Vector DB

    UI->>Server: POST /api/analyze-repo {repoUrl}
    Server->>Server: Clone & Walk Repository
    loop For each code file (excluding venv, lock, node_modules)
        Server->>Py: POST /api/chunk {filePath, fileContent}
        Py->>Py: Parse AST (Functions, Classes, Route patterns)
        Py-->>Server: JSON list of Code Snippets & Metadata
    end
    Server->>Mongo: Batch insert parsed code metadata
    loop Batch size: 100
        Server->>Gemini: generateEmbedding(Code Snippet text)
        Gemini-->>Server: 3072-dimension Vector
        Server->>Pinecone: Upsert Vector + Metadata (filePath, blockId)
    end
    Server-->>UI: Repository mapping & Concept nodes JSON
```

---

### B. Concept Generation & Vector Retrieval

When generating learning nodes and practice scenarios, this flow retrieves the relevant code snippets via semantic search:

```mermaid
sequenceDiagram
    autonumber
    participant UI as React Frontend
    participant Server as Express Backend
    participant Gemini as Gemini API
    participant Pine as Pinecone Vector DB
    participant Mongo as MongoDB Atlas

    UI->>Server: POST /api/generate-node-data {topic, node_label}
    Server->>Gemini: generateExpandedQuery(node_label, keywords)
    Gemini-->>Server: Optimized Search Term (1-2 Key terms)
    Server->>Gemini: generateEmbedding(Search Term)
    Gemini-->>Server: Query Vector
    Server->>Pine: query(Query Vector, namespace, minScore: 0.6)
    Pine-->>Server: Matching Vector IDs (Block IDs) & similarity scores
    Server->>Mongo: Fetch raw code snippets from MongoDB matching IDs
    Server->>Gemini: callGemini(Practice & Resources prompts + grounding code context)
    Gemini-->>Server: Customized learning resources, books, and practice scenario JSON
    Server-->>UI: Unified Node Data JSON
```

---

### C. YouTube Discovery & Prioritization Flow

When recommendations are generated, this flow uses the user's OAuth token (or server fallback) to fetch and prioritize subscribed videos:

```mermaid
flowchart TD
    Start([Get YouTube Videos]) --> CheckToken{ytAccessToken provided?}
    
    %% Token Path
    CheckToken -- Yes --> FetchSubs[Fetch & cache user subscriptions in MongoDB]
    FetchSubs --> SearchAuth[Search YouTube API using token in 'Authorization: Bearer' header]
    
    %% Fallback Path
    CheckToken -- No --> CheckApiKey{process.env.YOUTUBE_API_KEY present?}
    CheckApiKey -- Yes --> SearchApiKey[Search YouTube API using 'key' parameter]
    CheckApiKey -- No --> NoVideos[Return empty list '[]']
    
    %% Merge & Prioritize
    SearchAuth --> FetchStats[Batch-fetch statistics views/durations]
    SearchApiKey --> FetchStats
    
    FetchStats --> MatchSubs[Match search items against user subscriptions cached in MongoDB]
    MatchSubs --> PriorityGroup[Group matched items into Subscribed vs Regular results]
    PriorityGroup --> LimitPerChannel[Limit to max 2 videos per channel]
    LimitPerChannel --> FinalMerge[Merge & place Subscribed Channel matches at top]
    FinalMerge --> End([Return prioritized resource recommendations])
    NoVideos --> End
```
