# 🗺️ QuestMap AI: RAG-Powered Personalized Learning

QuestMap is a next-generation educational platform that transforms static documents into dynamic, personalized learning journeys. By leveraging **Retrieval-Augmented Generation (RAG)**, QuestMap grounds its AI tutor in your specific source materials, ensuring that every learning path, practice quiz, and recommended resource is perfectly aligned with your curriculum.

![QuestMap Dashboard](/Users/konda/.gemini/antigravity/brain/2bb2f111-a840-4d23-83e3-c9dd39749c41/final_dashboard_personalization_1772973507895.png)

## 🚀 Key Features

### 🧠 Adaptive Knowledge Maps
Instantly visualize your learning journey. QuestMap scans your goals, background, and uploaded documents to generate a structured, interactive map of sub-topics.

### 📚 Strict RAG Grounding
No more AI hallucinations. QuestMap's specialized "Strict Grounding" engine ensures that practice questions and recommendations stick purely to the terminology and concepts found in your uploaded PDFs and notes.

### 🛡️ RAG Relevance Guard
Topic isolation at scale. QuestMap uses a high-confidence semantic threshold (0.65) and "Domain-Aware" instructions to ensure your old documents (like research papers) never pollute a new, unrelated learning quest (like a new hobby).

### ⚡ Parallelized Learning Flow
Our optimized backend handles RAG retrieval, practice generation, and resource curation in parallel, delivering a zero-lag experience as you explore complex subjects.

### 🎯 Smart Filtering
The system automatically identifies and discards bibliographies, citations, and metadata during the chunking process, keeping your learning context clean and focused on actual educational content.

---

## 🛠️ Tech Stack

**Frontend:**
- **React (Vite)**: For a lightning-fast UI.
- **Framer Motion**: For fluid animations and transitions.
- **Lucide Icons**: For a modern, clean design system.
- **Tailwind CSS**: For responsive and sleek styling.

**Backend:**
- **Node.js & Express**: High-performance API layer.
- **Pinecone Vector DB**: High-speed retrieval for RAG.
- **Google Gemini 1.5 Pro/Flash**: The "brain" behind the knowledge maps and grounding.
- **MongoDB Atlas**: Persistent storage for user profiles and quest history.

---

## 🏗️ Architecture: The RAG Pipeline

1.  **Document Ingestion**: PDFs/DOCX/TXT files are parsed and cleaned.
2.  **Semantic Chunking**: Text is split into meaningful segments, with citation-heavy chunks filtered out.
3.  **Vector Embedding**: Chunks are converted into 768-dimensional vectors using Gemini Embeddings.
4.  **Contextual Retrieval**: When a user selects a topic, Pinecone retrieves relevant snippets using a strict **0.65 similarity filter** to ensure zero context leakage from unrelated files.
5.  **Domain-Aware Generation**: Gemini verifies the domain of each snippet; if it doesn't match your current topic, the AI ignores the noise and builds a standard curriculum instead.

---

## 📂 Project Structure

```text
├── backend/            # Express server & RAG services
│   ├── server.js       # Main API entry point
│   ├── ragService.js   # Pinecone & Embedding logic
│   ├── fileParser.js   # PDF/Docx text extraction
│   └── models/         # Mongoose schemas
├── frontend/           # React application
│   ├── src/pages/      # Dashboard and Profile views
│   ├── src/components/ # Interactive Maps and UI panels
│   └── src/lib/        # API and Auth utilities
```

---

## ⚙️ Setup & Installation

### Prerequisites
- Node.js (v18+)
- MongoDB Atlas account
- Pinecone account & API Key
- Google AI (Gemini) API Key

### Installation

1.  **Clone the Repository**
    ```bash
    git clone https://github.com/Krish-008/team-hackathon.git
    cd team-hackathon
    ```

2.  **Backend Setup**
    ```bash
    cd backend
    npm install
    # Create a .env file with your API keys
    node server.js
    ```

3.  **Frontend Setup**
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

---
*Built for the 2026 AI Innovation Hackathon* 🚀
